import { randomUUID } from "node:crypto";

import {
  Role,
  type Message,
  type SendMessageConfiguration,
  type SendMessageRequest,
  type SendMessageResult,
  type StreamResponse,
  type Task,
} from "@a2a-js/sdk";
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory, type RequestOptions } from "@a2a-js/sdk/client";

import { agentEndpointPath } from "../a2a/cards.js";
import { EXECUTION_OPTIONS_URI, type ExecutionOptions } from "../a2a/execution-options.js";
import { textPart } from "../a2a/task-mapper.js";

/**
 * Thin facade over the gateway's HTTP surface (spec §8.1). Every method here
 * is exactly "build one request, make one call, hand back the response" —
 * the caller-facing behavior (what counts as success, what to print) lives in
 * cli.ts / format.ts, not here.
 */

const REQUEST_TIMEOUT_MS = 15_000;
// Bounds the `--wait` stream so a worker that never settles cannot hang the
// process forever; the gateway itself already backstops via
// relay.settleTimeoutMs + relay.turnStartTimeoutMs, this is a second,
// independent bound on the client side.
const WAIT_TIMEOUT_MS = 600_000;

export class GatewayUnreachableError extends Error {
  constructor(
    readonly baseUrl: string,
    override readonly cause: unknown,
  ) {
    super(`cannot reach herdr-a2a gateway at ${baseUrl}`);
    this.name = "GatewayUnreachableError";
  }
}

export class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`gateway returned HTTP ${status}`);
    this.name = "GatewayHttpError";
  }
}

/** `GET /tasks/:id` returned 404 — no such task, not a reachability problem. */
export class TaskNotFoundError extends Error {
  constructor(
    readonly taskId: string,
    override readonly cause: unknown,
  ) {
    super(`unknown task ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

/**
 * Building an A2A client for a specific agent URL failed — either that
 * agent's card could not be fetched (gateway down, or the name does not
 * exist) or the transport rejected the card. One message covers both causes
 * honestly, since the client has no reliable way to tell them apart from a
 * single failed request.
 */
export class AgentUnreachableError extends Error {
  constructor(
    readonly agentUrl: string,
    override readonly cause: unknown,
  ) {
    super(`could not reach agent endpoint ${agentUrl}`);
    this.name = "AgentUnreachableError";
  }
}

/** The subset of the SDK's `Client` this package calls. Kept minimal and
 * structural so tests can supply a fake without constructing a real one. */
export interface AgentClient {
  sendMessage(params: SendMessageRequest, options?: RequestOptions): Promise<SendMessageResult>;
  sendMessageStream(params: SendMessageRequest, options?: RequestOptions): AsyncGenerator<StreamResponse, void, undefined>;
  getTask(params: { tenant: string; id: string }, options?: RequestOptions): Promise<Task>;
  cancelTask(
    params: { tenant: string; id: string; metadata: Record<string, unknown> | undefined },
    options?: RequestOptions,
  ): Promise<Task>;
}

export type AgentClientFactory = (agentUrl: string, fetchImpl: typeof fetch) => Promise<AgentClient>;

/**
 * Resolves the per-agent card at `agentUrl` itself (the gateway serves both
 * the card, on GET, and JSON-RPC, on POST, at that same URL — spec §4), then
 * builds a real A2A client from it.
 */
export const defaultAgentClientFactory: AgentClientFactory = async (agentUrl, fetchImpl) => {
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  });
  return factory.createFromUrl(agentUrl, "");
};

export const DEFAULT_BASE_URL = "http://127.0.0.1:4319";

/** `--base-url` flag > `HERDR_A2A_URL` env > the built-in default. */
export function resolveBaseUrl(flagValue: string | undefined, env: NodeJS.ProcessEnv): string {
  if (flagValue !== undefined && flagValue.length > 0) return flagValue;
  const fromEnv = env["HERDR_A2A_URL"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return DEFAULT_BASE_URL;
}

export interface BridgeClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  agentClientFactory?: AgentClientFactory;
}

/** `GET /tasks/:id` response shape (src/a2a/server.ts). */
export interface TaskLookup {
  agent: string;
  url: string;
  task: Task;
}

export class BridgeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly agentClientFactory: AgentClientFactory;

  constructor(opts: BridgeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.agentClientFactory = opts.agentClientFactory ?? defaultAgentClientFactory;
  }

  /** `GET {baseUrl}/agents` — the local catalog helper (spec §7). */
  async discover(): Promise<unknown> {
    return this.getJson("/agents");
  }

  /** `GET {baseUrl}/doctor` — operator diagnostic, not part of delegation. */
  async doctor(): Promise<unknown> {
    return this.getJson("/doctor");
  }

  private async fetchJson(path: string): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      throw new GatewayUnreachableError(this.baseUrl, err);
    }
    const body: unknown = await res.json().catch(() => undefined);
    return { status: res.status, body };
  }

  private async getJson(path: string): Promise<unknown> {
    const { status, body } = await this.fetchJson(path);
    if (status < 200 || status >= 300) throw new GatewayHttpError(status, body);
    return body;
  }

  /**
   * `GET {baseUrl}/tasks/:id` — the durable store's single, cross-agent
   * answer to "who owns this task" (src/a2a/server.ts). This is the only
   * network call `getTask` needs, and the first of two for `continue` /
   * `cancel`. It also doubles as the connectivity check for those verbs: a
   * failed fetch here throws `GatewayUnreachableError` directly, so there is
   * no separate reachability probe to pay for on top of it.
   */
  private async lookupTask(taskId: string): Promise<TaskLookup> {
    const { status, body } = await this.fetchJson(`/tasks/${encodeURIComponent(taskId)}`);
    if (status === 404) throw new TaskNotFoundError(taskId, body);
    if (status < 200 || status >= 300) throw new GatewayHttpError(status, body);

    const parsed = body as { agent?: unknown; url?: unknown; task?: unknown };
    if (typeof parsed.agent !== "string" || typeof parsed.url !== "string" || parsed.task === undefined) {
      throw new GatewayHttpError(status, body);
    }
    return { agent: parsed.agent, url: parsed.url, task: parsed.task as Task };
  }

  private async clientForUrl(url: string): Promise<AgentClient> {
    try {
      return await this.agentClientFactory(url, this.fetchImpl);
    } catch (err) {
      throw new AgentUnreachableError(url, err);
    }
  }

  /** `delegate` → `sendMessage`, or `sendMessageStream` when `wait` is true. */
  async delegate(agentName: string, text: string, options: ExecutionOptions, wait: boolean): Promise<SendMessageResult> {
    const client = await this.clientForUrl(`${this.baseUrl}${agentEndpointPath(agentName)}`);
    return send(client, buildMessage(text, options, ""), wait);
  }

  /** `get` → one direct lookup; no A2A round trip needed for a read. */
  async getTask(taskId: string): Promise<Task> {
    const { task } = await this.lookupTask(taskId);
    return task;
  }

  /** `cancel` → look up the owning agent, then `cancelTask` against it. */
  async cancelTask(taskId: string): Promise<Task> {
    const { url } = await this.lookupTask(taskId);
    const client = await this.clientForUrl(url);
    return client.cancelTask({ tenant: "", id: taskId, metadata: undefined }, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  /** `continue` → look up the owning agent, then `sendMessage` with the
   * message's `taskId` set to the existing task. */
  async continueTask(taskId: string, text: string, options: ExecutionOptions, wait: boolean): Promise<SendMessageResult> {
    const { url } = await this.lookupTask(taskId);
    const client = await this.clientForUrl(url);
    return send(client, buildMessage(text, options, taskId), wait);
  }
}

async function send(client: AgentClient, message: Message, wait: boolean): Promise<SendMessageResult> {
  const request: SendMessageRequest = {
    tenant: "",
    message,
    // Default: ask the gateway to hand back the task as soon as it exists
    // rather than blocking for the whole turn, so the caller gets a task id
    // back immediately and can ask again later (spec §8.1). `--wait` opts
    // into the SDK's own bounded streaming call instead.
    configuration: wait ? undefined : immediateConfig(),
    metadata: undefined,
  };
  if (wait) {
    return consumeStream(client.sendMessageStream(request, { signal: AbortSignal.timeout(WAIT_TIMEOUT_MS) }));
  }
  return client.sendMessage(request, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function immediateConfig(): SendMessageConfiguration {
  return { acceptedOutputModes: [], taskPushNotificationConfig: undefined, returnImmediately: true };
}

function buildMessage(text: string, options: ExecutionOptions, taskId: string): Message {
  return {
    messageId: randomUUID(),
    contextId: "",
    taskId,
    role: Role.ROLE_USER,
    parts: [textPart(text)],
    metadata: buildMetadata(options),
    extensions: [],
    referenceTaskIds: [],
  };
}

/**
 * Model and visibility travel ONLY under `EXECUTION_OPTIONS_URI` in the
 * message's own metadata — never as flat sibling keys and never on the
 * request's top-level metadata (spec §19).
 */
function buildMetadata(options: ExecutionOptions): Record<string, unknown> | undefined {
  if (options.model === undefined && options.visibility === undefined) return undefined;
  const nested: Record<string, unknown> = {};
  if (options.model !== undefined) nested["model"] = options.model;
  if (options.visibility !== undefined) nested["visibility"] = options.visibility;
  return { [EXECUTION_OPTIONS_URI]: nested };
}

/**
 * Drains the SDK's own async generator to its end (which the gateway bounds
 * server-side) and folds the events into the final task/message, rather than
 * re-checking task state in a caller-driven loop.
 */
async function consumeStream(gen: AsyncGenerator<StreamResponse, void, undefined>): Promise<SendMessageResult> {
  let lastTask: Task | undefined;
  let lastMessage: Message | undefined;
  for await (const event of gen) {
    const payload = event.payload;
    if (!payload) continue;
    if (payload.$case === "task") {
      lastTask = payload.value;
    } else if (payload.$case === "statusUpdate" && lastTask && lastTask.id === payload.value.taskId) {
      lastTask = { ...lastTask, status: payload.value.status ?? lastTask.status };
    } else if (payload.$case === "artifactUpdate" && lastTask && lastTask.id === payload.value.taskId) {
      const artifact = payload.value.artifact;
      if (artifact) lastTask = { ...lastTask, artifacts: [...lastTask.artifacts, artifact] };
    } else if (payload.$case === "message") {
      lastMessage = payload.value;
    }
  }
  if (lastTask) return lastTask;
  if (lastMessage) return lastMessage;
  throw new Error("agent stream ended without a task or message");
}
