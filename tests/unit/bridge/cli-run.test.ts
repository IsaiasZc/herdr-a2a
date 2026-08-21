import { TaskState, type Message, type SendMessageRequest, type Task } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";

import { EXECUTION_OPTIONS_URI } from "../../../src/a2a/execution-options.js";
import type { AgentClient, AgentClientFactory } from "../../../src/bridge/client.js";
import { run } from "../../../src/bridge/cli.js";

/**
 * Every test here injects a fake `fetch` and a fake A2A-client factory
 * (spec §8.1 test seam) — no network, no real gateway process.
 *
 * Several tests assert the exact number of `fetch` / agent-client-factory
 * calls a command makes. That is deliberate: `get` must cost exactly one
 * gateway round trip (`GET /tasks/:id`) and `continue` / `cancel` exactly
 * two (that lookup, then the A2A call against the agent it names) — the
 * per-agent fan-out this package used before the gateway grew a durable,
 * cross-agent task store must never creep back in.
 */

const BASE_URL = "http://gw.test";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Handler = () => Response | Promise<Response>;

function fakeFetch(handlers: Record<string, Handler>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    for (const [path, handler] of Object.entries(handlers)) {
      if (url === `${BASE_URL}${path}`) return handler();
    }
    throw new Error(`unhandled fetch in test: ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    contextId: "ctx-1",
    status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: "t" },
    artifacts: [],
    history: [],
    metadata: { target: "codex" },
    ...overrides,
  };
}

function collector() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
  };
}

describe("run: connectivity", () => {
  it("names missing session discovery and the plugin install check in one actionable line", async () => {
    const io = collector();
    const brokenFetch: typeof fetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4319");
    }) as unknown as typeof fetch;

    const code = await run(["discover"], { env: {}, fetchImpl: brokenFetch, stdout: io.stdout, stderr: io.stderr });

    expect(code).toBe(2);
    expect(io.err).toEqual([
      "no gateway found for this Herdr session; check `herdr plugin list` and install it with `herdr plugin link <path-to-herdr-a2a>`",
    ]);
  });

  it("exits 2 with a single actionable line when the gateway cannot be reached, no stack trace", async () => {
    const io = collector();
    const brokenFetch: typeof fetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4319");
    }) as unknown as typeof fetch;

    const code = await run(["discover"], { env: { HERDR_A2A_URL: BASE_URL }, fetchImpl: brokenFetch, stdout: io.stdout, stderr: io.stderr });

    expect(code).toBe(2);
    expect(io.err).toHaveLength(1);
    expect(io.err[0]).toMatch(/node dist\/main\.js/);
    expect(io.err[0]).not.toMatch(/\n {2,}at /);
    expect(io.out).toHaveLength(0);
  });
});

describe("run: usage errors", () => {
  it("unknown verb exits 2 with usage on stderr and nothing on stdout", async () => {
    const io = collector();
    const code = await run(["nope"], { stdout: io.stdout, stderr: io.stderr });
    expect(code).toBe(2);
    expect(io.out).toHaveLength(0);
    expect(io.err.join("\n")).toMatch(/Usage:/);
  });

  it("missing required args exits 2 with usage on stderr", async () => {
    const io = collector();
    const code = await run(["delegate", "codex"], { stdout: io.stdout, stderr: io.stderr });
    expect(code).toBe(2);
    expect(io.err.join("\n")).toMatch(/usage: herdr-a2a delegate/);
  });
});

describe("run: discover / doctor json passthrough", () => {
  it("--json prints the raw structured payload and nothing else on stdout, in exactly one request", async () => {
    const io = collector();
    const payload = { baseUrl: BASE_URL, agents: [{ name: "codex", available: true, runtime: "codex-cli", url: `${BASE_URL}/a2a/agents/codex` }] };
    const { fetchImpl, calls } = fakeFetch({ "/agents": () => jsonResponse(payload) });

    const code = await run(["discover", "--json", "--base-url", BASE_URL], { fetchImpl, stdout: io.stdout, stderr: io.stderr });

    expect(code).toBe(0);
    expect(io.out).toHaveLength(1);
    expect(JSON.parse(io.out[0] as string)).toEqual(payload);
    expect(calls).toEqual([`${BASE_URL}/agents`]);
  });

  it("doctor exits 1 when the report says ok: false, still just prints the payload for --json", async () => {
    const io = collector();
    const payload = { ok: false, checks: [{ name: "ping", ok: false, detail: "no socket" }], agents: [] };
    const { fetchImpl } = fakeFetch({ "/doctor": () => jsonResponse(payload) });

    const code = await run(["doctor", "--json", "--base-url", BASE_URL], { fetchImpl, stdout: io.stdout, stderr: io.stderr });

    expect(code).toBe(1);
    expect(JSON.parse(io.out[0] as string)).toEqual(payload);
  });
});

describe("run: delegate exit codes", () => {
  function factoryReturning(task: Task): { factory: AgentClientFactory; calls: string[] } {
    const calls: string[] = [];
    const client: AgentClient = {
      sendMessage: async () => task,
      sendMessageStream: async function* () {
        yield { payload: { $case: "task", value: task } };
      },
      getTask: async () => task,
      cancelTask: async () => task,
    };
    return {
      factory: async (url) => {
        calls.push(url);
        return client;
      },
      calls,
    };
  }

  // delegate goes straight to the named agent's endpoint; it has no reason to
  // touch the gateway's own HTTP routes at all.
  const noGatewayFetch: typeof fetch = (async (input: unknown) => {
    throw new Error(`delegate must not call the gateway's HTTP surface, got: ${String(input)}`);
  }) as unknown as typeof fetch;

  it("a completed task exits 0", async () => {
    const io = collector();
    const task = baseTask({ status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: "t" } });
    const { factory } = factoryReturning(task);
    const code = await run(["delegate", "codex", "do", "the", "thing", "--base-url", BASE_URL], {
      fetchImpl: noGatewayFetch,
      agentClientFactory: factory,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(io.out[0]).toContain("state: completed");
  });

  it("a failed task exits 1", async () => {
    const io = collector();
    const task = baseTask({
      status: { state: TaskState.TASK_STATE_FAILED, message: undefined, timestamp: "t" },
      metadata: { target: "codex", error: { code: "TASK_FAILED", message: "went wrong" } },
    });
    const { factory } = factoryReturning(task);
    const code = await run(["delegate", "codex", "do", "the", "thing", "--base-url", BASE_URL], {
      fetchImpl: noGatewayFetch,
      agentClientFactory: factory,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
    expect(io.out[0]).toContain("state: failed");
  });
});

describe("run: execution options placement", () => {
  it("model and visibility land only in message.metadata under EXECUTION_OPTIONS_URI", async () => {
    const io = collector();
    let captured: SendMessageRequest | undefined;
    const client: AgentClient = {
      sendMessage: async (params) => {
        captured = params;
        return baseTask({ status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: "t" } });
      },
      sendMessageStream: async function* () {},
      getTask: async () => baseTask(),
      cancelTask: async () => baseTask(),
    };

    const code = await run(
      ["delegate", "codex", "do", "it", "--model", "gpt-5", "--headless", "--base-url", BASE_URL],
      { agentClientFactory: async () => client, stdout: io.stdout, stderr: io.stderr },
    );

    expect(code).toBe(0);
    expect(captured).toBeDefined();
    const message = (captured as SendMessageRequest).message as Message;
    expect(message.metadata).toEqual({ [EXECUTION_OPTIONS_URI]: { model: "gpt-5", visibility: "headless" } });
    // Nowhere else: not flattened onto message.metadata, not on the request's own metadata.
    expect(message.metadata?.["model"]).toBeUndefined();
    expect(message.metadata?.["visibility"]).toBeUndefined();
    expect((captured as SendMessageRequest).metadata).toBeUndefined();
  });

  it("omits execution-options metadata entirely when no model/visibility was requested", async () => {
    const io = collector();
    let captured: SendMessageRequest | undefined;
    const client: AgentClient = {
      sendMessage: async (params) => {
        captured = params;
        return baseTask();
      },
      sendMessageStream: async function* () {},
      getTask: async () => baseTask(),
      cancelTask: async () => baseTask(),
    };

    await run(["delegate", "codex", "plain", "message", "--base-url", BASE_URL], {
      agentClientFactory: async () => client,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect((captured?.message as Message).metadata).toBeUndefined();
  });
});

describe("run: get / continue / cancel go through the durable task lookup, not a per-agent probe", () => {
  const lookupUrl = `${BASE_URL}/a2a/agents/agent-b`;
  const task = baseTask({ id: "task-9", metadata: { target: "agent-b" } });
  const lookupPayload = { agent: "agent-b", url: lookupUrl, task };

  it("get makes exactly one request: GET /tasks/:id, no agent client at all", async () => {
    const io = collector();
    const { fetchImpl, calls } = fakeFetch({ "/tasks/task-9": () => jsonResponse(lookupPayload) });
    let factoryCalls = 0;
    const agentClientFactory: AgentClientFactory = async () => {
      factoryCalls++;
      throw new Error("get must not build an agent client");
    };

    const code = await run(["get", "task-9", "--base-url", BASE_URL], { fetchImpl, agentClientFactory, stdout: io.stdout, stderr: io.stderr });

    expect(code).toBe(0);
    expect(io.out[0]).toContain("id: task-9");
    expect(calls).toEqual([`${BASE_URL}/tasks/task-9`]);
    expect(factoryCalls).toBe(0);
  });

  it("cancel makes exactly two round trips: the lookup, then cancelTask against the url it returned", async () => {
    const io = collector();
    const { fetchImpl, calls } = fakeFetch({ "/tasks/task-9": () => jsonResponse(lookupPayload) });

    let factoryCalls = 0;
    let cancelCalls = 0;
    const agentClientFactory: AgentClientFactory = async (url) => {
      factoryCalls++;
      expect(url).toBe(lookupUrl);
      return {
        sendMessage: async () => task,
        sendMessageStream: async function* () {},
        getTask: async () => task,
        cancelTask: async () => {
          cancelCalls++;
          return { ...task, status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: "t" } };
        },
      };
    };

    const code = await run(["cancel", "task-9", "--base-url", BASE_URL], { fetchImpl, agentClientFactory, stdout: io.stdout, stderr: io.stderr });

    expect(code).toBe(0);
    expect(calls).toEqual([`${BASE_URL}/tasks/task-9`]);
    expect(factoryCalls).toBe(1);
    expect(cancelCalls).toBe(1);
  });

  it("continue makes exactly two round trips: the lookup, then sendMessage against the url it returned", async () => {
    const io = collector();
    const { fetchImpl, calls } = fakeFetch({ "/tasks/task-9": () => jsonResponse(lookupPayload) });

    let sendCalls = 0;
    let capturedTaskId: string | undefined;
    const agentClientFactory: AgentClientFactory = async (url) => {
      expect(url).toBe(lookupUrl);
      return {
        sendMessage: async (params) => {
          sendCalls++;
          capturedTaskId = params.message?.taskId;
          return { ...task, status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: "t" } };
        },
        sendMessageStream: async function* () {},
        getTask: async () => task,
        cancelTask: async () => task,
      };
    };

    const code = await run(["continue", "task-9", "here", "is", "more", "--base-url", BASE_URL], {
      fetchImpl,
      agentClientFactory,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(code).toBe(0);
    expect(calls).toEqual([`${BASE_URL}/tasks/task-9`]);
    expect(sendCalls).toBe(1);
    expect(capturedTaskId).toBe("task-9");
  });

  it("an unknown task id exits 2 with one clean line, not a stack trace", async () => {
    const io = collector();
    const { fetchImpl, calls } = fakeFetch({
      "/tasks/ghost-task": () => jsonResponse({ error: "TASK_NOT_FOUND", taskId: "ghost-task" }, 404),
    });

    const code = await run(["get", "ghost-task", "--base-url", BASE_URL], { fetchImpl, stdout: io.stdout, stderr: io.stderr });

    expect(code).toBe(2);
    expect(io.err).toHaveLength(1);
    expect(io.err[0]).toMatch(/unknown task ghost-task/);
    expect(io.err[0]).not.toMatch(/\n {2,}at /);
    expect(calls).toEqual([`${BASE_URL}/tasks/ghost-task`]);
  });
});
