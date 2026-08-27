import net from "node:net";
import { once } from "node:events";

import { ERROR_CODES, DelegationFailure, fail } from "../core/errors.js";
import type { HerdrClient, HerdrEventHandler, HerdrSubscription, Logger } from "../core/ports.js";
import {
  REQUIRED_PROTOCOL,
  type AgentInfo,
  type AgentManifestStatus,
  type AgentStatus,
  type HerdrErrorBody,
  type PaneInfo,
  type PaneLayoutSnapshot,
  type PaneProcessInfo,
  type PaneSplitParams,
  type PongResult,
  type ReadSource,
  type SessionSnapshot,
  type Subscription,
  type TabCreateParams,
  type TabInfo,
} from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Covers `agent.start`'s own 300s ceiling plus slack. */
const MAX_REQUEST_TIMEOUT_MS = 320_000;
/**
 * Guards against fd exhaustion when many short reads are in flight at once.
 *
 * Long-blocking calls (`agent.start`, `agent.prompt` with a wait, `agent.wait`)
 * are exempt: `agent.wait` legitimately holds its connection for the whole
 * settle timeout — ten minutes by default — and counting those against a shared
 * budget would let a handful of settling workers starve every other request.
 * Their cost is bounded by the number of live workers, not by request rate.
 */
const MAX_CONCURRENT_REQUESTS = 48;
const WINDOWS_PIPE_PREFIXES = ["\\\\.\\pipe\\", "\\\\?\\pipe\\"];

type ResultFrame = Record<string, unknown> & { type: string };

/**
 * Herdr exposes a filesystem socket path on Unix and a marker-file path on
 * Windows. Its Windows IPC implementation maps that marker path into the
 * generic named-pipe namespace; Node requires the namespace prefix explicitly.
 */
export function localSocketEndpointFor(socketPath: string, platform = process.platform): string {
  if (platform !== "win32" || WINDOWS_PIPE_PREFIXES.some((prefix) => socketPath.startsWith(prefix))) return socketPath;
  return `\\\\.\\pipe\\${socketPath}`;
}

/**
 * Sends exactly one request on a fresh connection and reads its single reply.
 *
 * Herdr's API socket is **request-per-connection**: it answers the first frame
 * and then closes. Verified against 0.8.0 — pipelining three frames yields one
 * response and an ECONNRESET, and sending a request on a subscribed connection
 * resets it too. So there is no multiplexing to be had here, and a persistent
 * request connection would fail intermittently depending on whether Node had
 * yet noticed the peer's FIN.
 */
async function requestOnce(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<ResultFrame> {
  const socket = net.createConnection({ path: localSocketEndpointFor(socketPath) });
  socket.setNoDelay(true);

  const cleanup = () => {
    socket.removeAllListeners();
    socket.destroy();
  };

  try {
    await Promise.race([
      once(socket, "connect"),
      once(socket, "error").then(([err]) => {
        throw err;
      }),
    ]);
  } catch (err) {
    cleanup();
    throw fail(
      ERROR_CODES.HERDR_UNAVAILABLE,
      `cannot reach Herdr socket at ${socketPath}: ${(err as Error).message}`,
      { socketPath, method },
    );
  }

  return new Promise<ResultFrame>((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          fail(ERROR_CODES.HERDR_API_ERROR, `${method} timed out after ${timeoutMs}ms`, {
            method,
            timeoutMs,
          }),
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx < 0) return;

      const line = buffer.slice(0, idx);
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        finish(() =>
          reject(
            fail(ERROR_CODES.HERDR_API_ERROR, `${method}: unparseable response`, {
              method,
              preview: line.slice(0, 200),
            }),
          ),
        );
        return;
      }

      const error = frame["error"] as HerdrErrorBody | undefined;
      if (error) {
        finish(() =>
          reject(
            new DelegationFailure(ERROR_CODES.HERDR_API_ERROR, `${method}: ${error.message}`, {
              // Callers branch on this: `agent_prompt_stalled` in particular is a
              // first-class signal, not a generic failure.
              herdrCode: error.code,
              method,
            }),
          ),
        );
        return;
      }
      finish(() => resolve(frame["result"] as ResultFrame));
    });

    // The server closing before a reply means the request never landed.
    socket.on("close", () => {
      finish(() =>
        reject(fail(ERROR_CODES.HERDR_UNAVAILABLE, `${method}: connection closed before a reply`, { method })),
      );
    });
    socket.on("error", (err: Error) => {
      finish(() => reject(fail(ERROR_CODES.HERDR_UNAVAILABLE, `${method}: ${err.message}`, { method })));
    });

    socket.write(`${JSON.stringify({ id: `a2a-${method}`, method, params })}\n`, (err) => {
      if (!err) return;
      finish(() => reject(fail(ERROR_CODES.HERDR_UNAVAILABLE, `write failed: ${err.message}`, { method })));
    });
  });
}

/**
 * A long-lived connection that carries only events. Requests must never be sent
 * on it — Herdr resets a subscribed connection that receives one.
 */
class EventConnection {
  private socket: net.Socket | undefined;
  private buffer = "";
  private closed = false;

  constructor(
    private readonly socketPath: string,
    private readonly handler: HerdrEventHandler,
    private readonly log: Logger,
    private readonly onDrop: () => void,
  ) {}

  async open(subscriptions: Subscription[]): Promise<void> {
    const socket = net.createConnection({ path: localSocketEndpointFor(this.socketPath) });
    socket.setNoDelay(true);

    try {
      await Promise.race([
        once(socket, "connect"),
        once(socket, "error").then(([err]) => {
          throw err;
        }),
      ]);
    } catch (err) {
      socket.destroy();
      throw fail(
        ERROR_CODES.HERDR_UNAVAILABLE,
        `cannot open Herdr event stream: ${(err as Error).message}`,
        { socketPath: this.socketPath },
      );
    }

    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.ingest(chunk));
    socket.on("close", () => this.drop("closed"));
    socket.on("error", (err: Error) => this.drop(err.message));

    const ack = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(fail(ERROR_CODES.HERDR_API_ERROR, "events.subscribe timed out")), 15_000);
      timer.unref?.();
      this.pendingAck = { resolve, reject, timer };
    });

    socket.write(`${JSON.stringify({ id: "a2a-subscribe", method: "events.subscribe", params: { subscriptions } })}\n`);
    await ack;
  }

  private pendingAck: { resolve: () => void; reject: (e: unknown) => void; timer: NodeJS.Timeout } | undefined;

  private ingest(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;

      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.log.log("warn", "herdr: unparseable event frame", { preview: line.slice(0, 200) });
        continue;
      }

      if (this.pendingAck && typeof frame["id"] === "string") {
        const ack = this.pendingAck;
        this.pendingAck = undefined;
        clearTimeout(ack.timer);
        const error = frame["error"] as HerdrErrorBody | undefined;
        if (error) ack.reject(fail(ERROR_CODES.HERDR_API_ERROR, `events.subscribe: ${error.message}`, { herdrCode: error.code }));
        else ack.resolve();
        continue;
      }

      const event = frame["event"];
      if (typeof event !== "string") continue;
      try {
        this.handler(event, (frame["data"] ?? {}) as Record<string, unknown>);
      } catch (err) {
        this.log.log("warn", "herdr: event handler threw", { event, error: String(err) });
      }
    }
  }

  private drop(reason: string): void {
    this.socket = undefined;
    this.buffer = "";
    if (this.pendingAck) {
      const ack = this.pendingAck;
      this.pendingAck = undefined;
      clearTimeout(ack.timer);
      ack.reject(fail(ERROR_CODES.HERDR_UNAVAILABLE, `event stream closed: ${reason}`));
    }
    if (!this.closed) this.onDrop();
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
    this.socket = undefined;
  }
}

export interface HerdrSocketClientOptions {
  socketPath?: string;
  logger: Logger;
  /** Called when the event stream drops, so caches can resync. */
  onDisconnect?: () => void;
}

export function resolveSocketPath(explicit?: string): string {
  const path = explicit ?? process.env["HERDR_SOCKET_PATH"];
  if (!path) {
    throw fail(
      ERROR_CODES.HERDR_UNAVAILABLE,
      "HERDR_SOCKET_PATH is not set — this process is not running inside a Herdr-managed pane",
    );
  }
  return path;
}

export class HerdrSocketClient implements HerdrClient {
  private readonly socketPath: string;
  private readonly streams = new Set<EventConnection>();
  private inFlight = 0;
  private readonly waiting: (() => void)[] = [];
  private closed = false;

  constructor(private readonly opts: HerdrSocketClientOptions) {
    this.socketPath = resolveSocketPath(opts.socketPath);
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < MAX_CONCURRENT_REQUESTS) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.inFlight += 1;
  }

  private release(): void {
    this.inFlight -= 1;
    this.waiting.shift()?.();
  }

  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    pick: (result: ResultFrame) => T,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    /** Set for calls that block on Herdr's own event loop, not on us. */
    longRunning = false,
  ): Promise<T> {
    if (this.closed) throw fail(ERROR_CODES.HERDR_UNAVAILABLE, "client closed");
    if (!longRunning) await this.acquire();
    try {
      const result = await requestOnce(
        this.socketPath,
        method,
        params,
        Math.min(timeoutMs, MAX_REQUEST_TIMEOUT_MS),
      );
      return pick(result);
    } finally {
      if (!longRunning) this.release();
    }
  }

  async ping(): Promise<PongResult> {
    const pong = await this.call("ping", {}, (r) => r as unknown as PongResult);
    if (pong.protocol !== REQUIRED_PROTOCOL) {
      // A newer protocol is usually additive; `doctor` turns this into an
      // operator-visible verdict rather than refusing here.
      this.opts.logger.log("warn", "herdr: protocol mismatch", {
        expected: REQUIRED_PROTOCOL,
        actual: pong.protocol,
      });
    }
    return pong;
  }

  /** Throws `HERDR_PROTOCOL_UNSUPPORTED` when the wire protocol is too old. */
  async assertCompatible(): Promise<PongResult> {
    const pong = await this.ping();
    if (pong.protocol < REQUIRED_PROTOCOL) {
      throw fail(
        ERROR_CODES.HERDR_PROTOCOL_UNSUPPORTED,
        `Herdr protocol ${pong.protocol} is older than the required ${REQUIRED_PROTOCOL}`,
        { actual: pong.protocol, required: REQUIRED_PROTOCOL, version: pong.version },
      );
    }
    return pong;
  }

  sessionSnapshot(): Promise<SessionSnapshot> {
    return this.call("session.snapshot", {}, (r) => r["snapshot"] as SessionSnapshot);
  }

  agentManifests(): Promise<AgentManifestStatus> {
    return this.call("server.agent_manifests", {}, (r) => r as unknown as AgentManifestStatus);
  }

  agentList(): Promise<AgentInfo[]> {
    return this.call("agent.list", {}, (r) => (r["agents"] ?? []) as AgentInfo[]);
  }

  agentGet(target: string): Promise<AgentInfo> {
    return this.call("agent.get", { target }, (r) => r["agent"] as AgentInfo);
  }

  agentStart(params: {
    name: string;
    kind: string;
    paneId: string;
    args?: string[];
    timeoutMs?: number;
  }): Promise<{ agent: AgentInfo; argv: string[] }> {
    // Herdr rejects timeout_ms <= 3000 and > 300000; clamp a value we chose
    // ourselves rather than surfacing a schema error to the caller.
    const timeoutMs = params.timeoutMs === undefined ? undefined : clamp(params.timeoutMs, 3_001, 300_000);
    return this.call(
      "agent.start",
      {
        name: params.name,
        kind: params.kind,
        pane_id: params.paneId,
        ...(params.args ? { args: params.args } : {}),
        ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
      },
      (r) => ({ agent: r["agent"] as AgentInfo, argv: (r["argv"] ?? []) as string[] }),
      (timeoutMs ?? 30_000) + 10_000,
      true,
    );
  }

  agentPrompt(params: {
    target: string;
    text: string;
    wait?: { until?: AgentStatus[]; timeoutMs?: number };
  }): Promise<AgentInfo> {
    const wait = params.wait
      ? {
          ...(params.wait.until ? { until: params.wait.until } : {}),
          ...(params.wait.timeoutMs === undefined ? {} : { timeout_ms: params.wait.timeoutMs }),
        }
      : undefined;
    return this.call(
      "agent.prompt",
      { target: params.target, text: params.text, ...(wait ? { wait } : {}) },
      (r) => r["agent"] as AgentInfo,
      (params.wait?.timeoutMs ?? 15_000) + 10_000,
      Boolean(params.wait),
    );
  }

  agentWait(params: { target: string; until?: AgentStatus[]; timeoutMs?: number }): Promise<AgentInfo> {
    return this.call(
      "agent.wait",
      {
        target: params.target,
        ...(params.until ? { until: params.until } : {}),
        ...(params.timeoutMs === undefined ? {} : { timeout_ms: params.timeoutMs }),
      },
      (r) => r["agent"] as AgentInfo,
      (params.timeoutMs ?? 30_000) + 10_000,
      true,
    );
  }

  agentRead(params: {
    target: string;
    source: ReadSource;
    lines?: number;
    stripAnsi?: boolean;
  }): Promise<string> {
    return this.call(
      "agent.read",
      {
        target: params.target,
        source: params.source,
        ...(params.lines === undefined ? {} : { lines: params.lines }),
        strip_ansi: params.stripAnsi ?? true,
      },
      (r) => readText(r["read"]),
    );
  }

  agentSendKeys(target: string, keys: string[]): Promise<void> {
    return this.call("agent.send_keys", { target, keys }, () => undefined);
  }

  paneSplit(params: PaneSplitParams): Promise<PaneInfo> {
    return this.call(
      "pane.split",
      { focus: false, ...(params as unknown as Record<string, unknown>) },
      (r) => r["pane"] as PaneInfo,
    );
  }

  paneGet(paneId: string): Promise<PaneInfo> {
    return this.call("pane.get", { pane_id: paneId }, (r) => r["pane"] as PaneInfo);
  }

  paneList(params?: { workspaceId?: string }): Promise<PaneInfo[]> {
    return this.call(
      "pane.list",
      params?.workspaceId ? { workspace_id: params.workspaceId } : {},
      (r) => (r["panes"] ?? []) as PaneInfo[],
    );
  }

  paneClose(paneId: string): Promise<void> {
    return this.call("pane.close", { pane_id: paneId }, () => undefined);
  }

  /**
   * `pane.layout` accepts only `pane_id`, and it IGNORES unknown keys rather
   * than rejecting them — passing a `tab_id` silently returns the *focused*
   * pane's tab layout instead. So a tab is resolved by looking up one of its
   * panes first; never by hoping the server honours a `tab_id`.
   */
  async paneLayout(params?: { paneId?: string; tabId?: string }): Promise<PaneLayoutSnapshot> {
    let paneId = params?.paneId;

    if (!paneId && params?.tabId) {
      const panes = await this.paneList();
      paneId = panes.find((p) => p.tab_id === params.tabId)?.pane_id;
      if (!paneId) {
        throw fail(ERROR_CODES.HERDR_API_ERROR, `tab ${params.tabId} has no panes`, { tabId: params.tabId });
      }
    }

    return this.call(
      "pane.layout",
      paneId ? { pane_id: paneId } : {},
      (r) => r["layout"] as PaneLayoutSnapshot,
    );
  }

  paneProcessInfo(paneId: string): Promise<PaneProcessInfo> {
    return this.call("pane.process_info", { pane_id: paneId }, (r) => r["process_info"] as PaneProcessInfo);
  }

  tabCreate(params: TabCreateParams): Promise<TabInfo> {
    return this.call(
      "tab.create",
      { focus: false, ...(params as unknown as Record<string, unknown>) },
      (r) => r["tab"] as TabInfo,
    );
  }

  async subscribe(subscriptions: Subscription[], handler: HerdrEventHandler): Promise<HerdrSubscription> {
    if (this.closed) throw fail(ERROR_CODES.HERDR_UNAVAILABLE, "client closed");

    const stream = new EventConnection(this.socketPath, handler, this.opts.logger, () => {
      this.streams.delete(stream);
      this.opts.onDisconnect?.();
    });

    await stream.open(subscriptions);
    this.streams.add(stream);

    return {
      close: () => {
        this.streams.delete(stream);
        stream.close();
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const stream of this.streams) stream.close();
    this.streams.clear();
    for (const resume of this.waiting.splice(0)) resume();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** `pane_read` results vary by source; normalize to a single string. */
function readText(read: unknown): string {
  if (typeof read === "string") return read;
  if (!read || typeof read !== "object") return "";
  const obj = read as Record<string, unknown>;
  if (typeof obj["text"] === "string") return obj["text"];
  if (Array.isArray(obj["lines"])) return (obj["lines"] as unknown[]).map(String).join("\n");
  if (typeof obj["content"] === "string") return obj["content"];
  return "";
}
