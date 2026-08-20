import { describe, expect, it, vi } from "vitest";

import { ERROR_CODES, DelegationFailure } from "../../../src/core/errors.js";
import type { AgentSnapshot, LiveAgent, RelayMessage, DelegatedTask } from "../../../src/core/model.js";
import type { HerdrClient, RuntimeContext, TaskContext } from "../../../src/core/ports.js";
import { classifyBlocker, defaultRuntimeAdapter, formatPeerMessage } from "../../../src/runtimes/default-adapter.js";

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    paneId: "w1:p1",
    terminalId: "term_1",
    agent: "codex",
    status: "blocked",
    interactiveReady: true,
    launchPending: false,
    stateChangeSeq: 5,
    revision: 5,
    screenDetectionSkipped: false,
    stateLabels: {},
    observedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("classifyBlocker", () => {
  it("classifies an auth prompt as auth", () => {
    const result = classifyBlocker(snapshot(), "Please log in to continue. Not logged in.");
    expect(result.kind).toBe("auth");
  });

  it("classifies a workspace trust prompt as trust", () => {
    const result = classifyBlocker(snapshot(), "Do you trust the files in this workspace?");
    expect(result.kind).toBe("trust");
  });

  it("classifies a plain approval prompt as permission", () => {
    const result = classifyBlocker(snapshot(), "Allow this command to run? (y/n)");
    expect(result.kind).toBe("permission");
  });

  it("classifies an auth prompt that also contains an approval verb as auth, not permission", () => {
    // Ordering case: "allow" appears, but this is an auth/OAuth prompt.
    const result = classifyBlocker(
      snapshot(),
      "Authenticate with GitHub: allow this app to access your account? Sign in to continue.",
    );
    expect(result.kind).toBe("auth");
  });

  it("classifies a generic trailing question as question", () => {
    const result = classifyBlocker(snapshot(), "Which file should I edit next?");
    expect(result.kind).toBe("question");
  });

  it("returns unknown with no usable evidence", () => {
    const result = classifyBlocker(snapshot(), "   ");
    expect(result.kind).toBe("unknown");
    expect(result.text).toBeUndefined();
  });

  it("prefers a Herdr-supplied stateLabels hint over screen text", () => {
    // Screen text alone would read as a plain permission prompt, but the
    // integration-supplied label says this is actually an auth prompt —
    // stronger authority than scraped text (docs/herdr-contract.md §5).
    const result = classifyBlocker(
      snapshot({ stateLabels: { blocker: "auth" } }),
      "Allow access? (y/n)",
    );
    expect(result.kind).toBe("auth");
  });

  it("recognizes a stateLabels hint by key as well as value", () => {
    const result = classifyBlocker(snapshot({ stateLabels: { workspace_trust: "pending" } }), "");
    expect(result.kind).toBe("trust");
  });
});

describe("validateOptions", () => {
  it("passes when no model is requested", async () => {
    const ctx: RuntimeContext = { runtimeKind: "codex", cwd: "/tmp" };
    await expect(defaultRuntimeAdapter.validateOptions?.(ctx)).resolves.toBeUndefined();
  });

  it("throws MODEL_UNSUPPORTED when a model is requested with no known recipe", async () => {
    const ctx: RuntimeContext = { runtimeKind: "codex", cwd: "/tmp", model: "gpt-6" };
    await expect(defaultRuntimeAdapter.validateOptions?.(ctx)).rejects.toMatchObject({
      code: ERROR_CODES.MODEL_UNSUPPORTED,
    });
    await expect(defaultRuntimeAdapter.validateOptions?.(ctx)).rejects.toBeInstanceOf(DelegationFailure);
  });
});

describe("buildAgentArgs", () => {
  it("passes profileArgs through verbatim and invents nothing", async () => {
    const ctx: RuntimeContext = { runtimeKind: "codex", cwd: "/tmp", profileArgs: ["--foo", "bar"] };
    await expect(defaultRuntimeAdapter.buildAgentArgs?.(ctx)).resolves.toEqual(["--foo", "bar"]);
  });

  it("defaults to an empty array", async () => {
    const ctx: RuntimeContext = { runtimeKind: "codex", cwd: "/tmp" };
    await expect(defaultRuntimeAdapter.buildAgentArgs?.(ctx)).resolves.toEqual([]);
  });
});

describe("formatPeerMessage", () => {
  it("includes the sender and task id in a mandatory-attribution envelope", () => {
    const message: RelayMessage = {
      id: "msg_1",
      taskId: "task_123",
      targetInstanceId: "inst_1",
      from: { role: "peer-agent", name: "claude", ref: "a81f" },
      to: { role: "peer-agent", name: "codex", ref: "b2c3" },
      body: "Review the authentication change and report correctness issues.",
      state: "DELIVERING",
      attempt: 1,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    const formatted = formatPeerMessage(message);
    expect(formatted).toContain("from: claude:a81f");
    expect(formatted).toContain("task: task_123");
    expect(formatted).toContain(message.body);
    expect(formatted.startsWith("[peer-agent message]")).toBe(true);
  });
});

function fakeHerdr(readResult: string): HerdrClient {
  return {
    ping: vi.fn(),
    sessionSnapshot: vi.fn(),
    agentManifests: vi.fn(),
    agentList: vi.fn(),
    agentGet: vi.fn(),
    agentStart: vi.fn(),
    agentPrompt: vi.fn(),
    agentWait: vi.fn(),
    agentRead: vi.fn().mockResolvedValue(readResult),
    agentSendKeys: vi.fn(),
    paneSplit: vi.fn(),
    paneGet: vi.fn(),
    paneList: vi.fn(),
    paneClose: vi.fn(),
    paneLayout: vi.fn(),
    tabCreate: vi.fn(),
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as HerdrClient;
}

function fakeLiveAgent(overrides: Partial<LiveAgent> = {}): LiveAgent {
  return {
    instanceId: "inst_1",
    logicalTarget: "codex",
    runtimeKind: "codex",
    herdrAgentName: "codex-a1",
    paneId: "w1:p2",
    cwd: "/tmp",
    visibility: "visible",
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function fakeTask(): DelegatedTask {
  return {
    id: "task_1",
    caller: { role: "human", name: "operator" },
    target: { role: "peer-agent", name: "codex" },
    state: "working",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

describe("extractResult", () => {
  it("returns undefined rather than a lie on an empty read", async () => {
    const herdr = fakeHerdr("   \n  ");
    const ctx: TaskContext = { task: fakeTask(), live: fakeLiveAgent(), herdr };
    await expect(defaultRuntimeAdapter.extractResult?.(ctx)).resolves.toBeUndefined();
  });

  it("is bounded and marked truncated on a long read", async () => {
    const longText = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const herdr = fakeHerdr(longText);
    const ctx: TaskContext = { task: fakeTask(), live: fakeLiveAgent(), herdr };
    const result = await defaultRuntimeAdapter.extractResult?.(ctx);
    expect(result).toBeDefined();
    expect(result?.truncated).toBe(true);
    expect(result?.source).toBe("terminal-read");
    // The bound is enforced by the `lines` param passed to Herdr, not by
    // slicing the returned text again — assert we asked for a bounded read.
    expect(herdr.agentRead).toHaveBeenCalledWith(
      expect.objectContaining({ source: "recent_unwrapped", lines: 200, stripAnsi: true }),
    );
  });

  it("targets the herdr agent name over the pane id when both are known", async () => {
    const herdr = fakeHerdr("some result text");
    const ctx: TaskContext = { task: fakeTask(), live: fakeLiveAgent({ herdrAgentName: "codex-a1", paneId: "w1:p9" }), herdr };
    await defaultRuntimeAdapter.extractResult?.(ctx);
    expect(herdr.agentRead).toHaveBeenCalledWith(expect.objectContaining({ target: "codex-a1" }));
  });
});
