import { describe, expect, it } from "vitest";

import { DefaultSpawnManager } from "../../../src/spawn/spawn-manager.js";
import { DelegationFailure, ERROR_CODES } from "../../../src/core/errors.js";
import { EVENTS } from "../../../src/observability/events.js";
import { silentLogger } from "../../../src/observability/logger.js";
import type {
  Clock,
  EventSink,
  HerdrClient,
  IdGenerator,
  LayoutManager,
  LiveAgentStore,
  Preflight,
  PreflightReport,
  RecoveryConfig,
  ReusePolicy,
  RuntimeAdapter,
  RuntimeAdapterRegistry,
} from "../../../src/core/ports.js";
import type { AgentDescriptor, LiveAgent, SpawnRequest } from "../../../src/core/model.js";
import type { AgentInfo, PaneInfo } from "../../../src/herdr/types.js";

function descriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    name: "codex",
    descriptorKind: "runtime",
    runtimeKind: "codex",
    available: true,
    runtime: {
      kind: "codex",
      supportedByHerdr: true,
      hasDetectionManifest: true,
      hasIntegration: true,
      launchable: "yes",
      runningInstances: 0,
      sources: ["herdr-cli-kinds"],
    },
    description: "codex runtime",
    ...overrides,
  };
}

function baseReq(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    descriptor: descriptor(),
    cwd: "/work/project",
    visibility: "visible",
    callerPaneId: "caller-p1",
    callerTabId: "w1:t1",
    callerWorkspaceId: "w1",
    ...overrides,
  };
}

function pane(id: string, overrides: Partial<PaneInfo> = {}): PaneInfo {
  return {
    pane_id: id,
    terminal_id: `term_${id}`,
    workspace_id: "w1",
    tab_id: "w1:t1",
    focused: false,
    agent_status: "idle",
    revision: 1,
    ...overrides,
  };
}

function agentInfo(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    terminal_id: "term_p1",
    agent_status: "idle",
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "p1",
    focused: false,
    revision: 1,
    agent: "codex",
    interactive_ready: true,
    launch_pending: false,
    ...overrides,
  };
}

/** Throws on any method not explicitly overridden. */
class FakeHerdrClient implements HerdrClient {
  agentStartCalls: unknown[] = [];
  sendKeysCalls: unknown[] = [];

  constructor(
    private readonly impl: {
      agentStart?: HerdrClient["agentStart"];
      paneGet?: HerdrClient["paneGet"];
      agentGet?: HerdrClient["agentGet"];
    } = {},
  ) {}

  async agentStart(params: Parameters<HerdrClient["agentStart"]>[0]): ReturnType<HerdrClient["agentStart"]> {
    this.agentStartCalls.push(params);
    if (!this.impl.agentStart) throw new Error("FakeHerdrClient: unexpected call to agentStart");
    return this.impl.agentStart(params);
  }
  async paneGet(paneId: string): ReturnType<HerdrClient["paneGet"]> {
    if (!this.impl.paneGet) throw new Error("FakeHerdrClient: unexpected call to paneGet");
    return this.impl.paneGet(paneId);
  }
  async agentGet(target: string): ReturnType<HerdrClient["agentGet"]> {
    if (!this.impl.agentGet) throw new Error("FakeHerdrClient: unexpected call to agentGet");
    return this.impl.agentGet(target);
  }

  ping(): ReturnType<HerdrClient["ping"]> {
    throw new Error("FakeHerdrClient: unexpected call to ping");
  }
  sessionSnapshot(): ReturnType<HerdrClient["sessionSnapshot"]> {
    throw new Error("FakeHerdrClient: unexpected call to sessionSnapshot");
  }
  agentManifests(): ReturnType<HerdrClient["agentManifests"]> {
    throw new Error("FakeHerdrClient: unexpected call to agentManifests");
  }
  agentList(): ReturnType<HerdrClient["agentList"]> {
    throw new Error("FakeHerdrClient: unexpected call to agentList");
  }
  agentPrompt(): ReturnType<HerdrClient["agentPrompt"]> {
    throw new Error("FakeHerdrClient: unexpected call to agentPrompt");
  }
  agentWait(): ReturnType<HerdrClient["agentWait"]> {
    throw new Error("FakeHerdrClient: unexpected call to agentWait");
  }
  agentRead(): ReturnType<HerdrClient["agentRead"]> {
    throw new Error("FakeHerdrClient: unexpected call to agentRead");
  }
  async agentSendKeys(target: string, keys: string[]): Promise<void> {
    this.sendKeysCalls.push({ target, keys });
    throw new Error("FakeHerdrClient: unexpected call to agentSendKeys");
  }
  paneSplit(): ReturnType<HerdrClient["paneSplit"]> {
    throw new Error("FakeHerdrClient: unexpected call to paneSplit");
  }
  paneList(): ReturnType<HerdrClient["paneList"]> {
    throw new Error("FakeHerdrClient: unexpected call to paneList");
  }
  paneClose(): ReturnType<HerdrClient["paneClose"]> {
    throw new Error("FakeHerdrClient: unexpected call to paneClose");
  }
  paneLayout(): ReturnType<HerdrClient["paneLayout"]> {
    throw new Error("FakeHerdrClient: unexpected call to paneLayout");
  }
  tabCreate(): ReturnType<HerdrClient["tabCreate"]> {
    throw new Error("FakeHerdrClient: unexpected call to tabCreate");
  }
  subscribe(): ReturnType<HerdrClient["subscribe"]> {
    throw new Error("FakeHerdrClient: unexpected call to subscribe");
  }
  async close(): Promise<void> {}
}

class FakeLayoutManager implements LayoutManager {
  allocateVisibleCalls: unknown[] = [];
  allocateHeadlessCalls: unknown[] = [];
  releaseCalls: string[] = [];
  private readonly queue: PaneInfo[];

  constructor(panes: PaneInfo[]) {
    this.queue = [...panes];
  }

  async allocateVisiblePane(req: unknown): Promise<PaneInfo> {
    this.allocateVisibleCalls.push(req);
    const next = this.queue.shift();
    if (!next) throw new Error("FakeLayoutManager: no more panes queued");
    return next;
  }
  async allocateHeadlessPane(req: unknown): Promise<PaneInfo> {
    this.allocateHeadlessCalls.push(req);
    const next = this.queue.shift();
    if (!next) throw new Error("FakeLayoutManager: no more panes queued");
    return next;
  }
  async releasePane(paneId: string): Promise<void> {
    this.releaseCalls.push(paneId);
  }
}

class FakePreflight implements Preflight {
  constructor(private readonly report: PreflightReport = { ok: true, checks: [] }) {}
  async run(): Promise<PreflightReport> {
    return this.report;
  }
}

class FakeReusePolicy implements ReusePolicy {
  constructor(private readonly result: LiveAgent | undefined) {}
  async pick(): Promise<LiveAgent | undefined> {
    return this.result;
  }
}

class InMemoryLiveAgentStore implements LiveAgentStore {
  private readonly byId = new Map<string, LiveAgent>();
  async put(agent: LiveAgent): Promise<void> {
    this.byId.set(agent.instanceId, agent);
  }
  async get(instanceId: string): Promise<LiveAgent | undefined> {
    return this.byId.get(instanceId);
  }
  async byLogicalTarget(target: string): Promise<LiveAgent[]> {
    return [...this.byId.values()].filter((a) => a.logicalTarget === target);
  }
  async all(): Promise<LiveAgent[]> {
    return [...this.byId.values()];
  }
  async delete(instanceId: string): Promise<void> {
    this.byId.delete(instanceId);
  }
}

function recordingEventSink(): EventSink & { events: { event: string; fields: Record<string, unknown> }[] } {
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  return {
    events,
    emit(event, fields = {}) {
      events.push({ event, fields });
    },
  };
}

const clock: Clock = {
  now: () => new Date("2026-08-20T00:00:00.000Z"),
  nowIso: () => "2026-08-20T00:00:00.000Z",
  sleep: () => Promise.resolve(),
};

function idGen(prefix = "inst"): IdGenerator {
  let n = 0;
  return {
    taskId: () => "task_x",
    messageId: () => "msg_x",
    instanceId: () => `${prefix}_${++n}`,
    shortId: () => "a81f",
  };
}

const passthroughAdapter: RuntimeAdapter = { kind: "codex" };
const adapters: RuntimeAdapterRegistry = { for: () => passthroughAdapter };

const recovery: RecoveryConfig = { maxLaunchAttempts: 2, maxDeliveryAttempts: 2 };

function makeSpawnManager(opts: {
  herdr: HerdrClient;
  layout: LayoutManager;
  preflight?: Preflight;
  reuse?: ReusePolicy;
  liveAgents?: LiveAgentStore;
  events?: EventSink;
}) {
  return new DefaultSpawnManager({
    herdr: opts.herdr,
    layout: opts.layout,
    preflight: opts.preflight ?? new FakePreflight(),
    reuse: opts.reuse ?? new FakeReusePolicy(undefined),
    liveAgents: opts.liveAgents ?? new InMemoryLiveAgentStore(),
    adapters,
    ids: idGen(),
    clock,
    config: { recovery },
    events: opts.events ?? recordingEventSink(),
    logger: silentLogger,
  });
}

function reusedCandidate(): LiveAgent {
  return {
    instanceId: "inst_reused",
    logicalTarget: "codex",
    runtimeKind: "codex",
    herdrAgentName: "a2a-codex-a81f",
    paneId: "p_existing",
    terminalId: "term_existing",
    sessionRef: "session-existing",
    cwd: "/work/project",
    visibility: "visible",
    createdAt: "2026-08-19T00:00:00.000Z",
  };
}

describe("DefaultSpawnManager.resolveOrSpawn — reuse", () => {
  it("returns the reused candidate without allocating a pane or calling agent.start", async () => {
    const herdr = new FakeHerdrClient();
    const layout = new FakeLayoutManager([]);
    const events = recordingEventSink();
    const manager = makeSpawnManager({ herdr, layout, reuse: new FakeReusePolicy(reusedCandidate()), events });

    const result = await manager.resolveOrSpawn(baseReq());

    expect(result.instanceId).toBe("inst_reused");
    expect(layout.allocateVisibleCalls).toHaveLength(0);
    expect(layout.allocateHeadlessCalls).toHaveLength(0);
    expect(herdr.agentStartCalls).toHaveLength(0);
    expect(events.events.some((e) => e.event === EVENTS.spawnReused)).toBe(true);
  });
});

describe("DefaultSpawnManager.resolveOrSpawn — preflight", () => {
  it("throws AGENT_NOT_LAUNCHABLE when a runtime descriptor is unavailable", async () => {
    const herdr = new FakeHerdrClient();
    const layout = new FakeLayoutManager([]);
    const preflight = new FakePreflight({
      ok: false,
      checks: [{ name: "descriptor_available", ok: false, detail: "not on PATH" }],
    });
    const manager = makeSpawnManager({ herdr, layout, preflight });

    await expect(manager.resolveOrSpawn(baseReq())).rejects.toMatchObject({
      code: ERROR_CODES.AGENT_NOT_LAUNCHABLE,
    });
  });

  it("throws CUSTOM_AGENT_RUNTIME_UNAVAILABLE when a custom descriptor is unavailable", async () => {
    const herdr = new FakeHerdrClient();
    const layout = new FakeLayoutManager([]);
    const preflight = new FakePreflight({
      ok: false,
      checks: [{ name: "descriptor_available", ok: false, detail: "runtime missing" }],
    });
    const req = baseReq({ descriptor: descriptor({ descriptorKind: "custom" }) });
    const manager = makeSpawnManager({ herdr, layout, preflight });

    await expect(manager.resolveOrSpawn(req)).rejects.toMatchObject({
      code: ERROR_CODES.CUSTOM_AGENT_RUNTIME_UNAVAILABLE,
    });
  });

  it("maps cwd_exists failures to INVALID_CWD", async () => {
    const herdr = new FakeHerdrClient();
    const layout = new FakeLayoutManager([]);
    const preflight = new FakePreflight({ ok: false, checks: [{ name: "cwd_exists", ok: false, detail: "no such dir" }] });
    const manager = makeSpawnManager({ herdr, layout, preflight });

    await expect(manager.resolveOrSpawn(baseReq())).rejects.toMatchObject({ code: ERROR_CODES.INVALID_CWD });
  });
});

describe("DefaultSpawnManager.resolveOrSpawn — spawn + recovery", () => {
  it("spawns successfully and captures terminalId/sessionRef/workspaceId/tabId", async () => {
    const startedAgent = agentInfo({
      pane_id: "p1",
      terminal_id: "term_p1",
      workspace_id: "w1",
      tab_id: "w1:t2",
      agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "sess-1" },
    });
    const herdr = new FakeHerdrClient({ agentStart: async () => ({ agent: startedAgent, argv: ["codex"] }) });
    const layout = new FakeLayoutManager([pane("p1")]);
    const liveAgents = new InMemoryLiveAgentStore();
    const events = recordingEventSink();
    const manager = makeSpawnManager({ herdr, layout, liveAgents, events });

    const live = await manager.resolveOrSpawn(baseReq());

    expect(live.paneId).toBe("p1");
    expect(live.terminalId).toBe("term_p1");
    expect(live.sessionRef).toBe("sess-1");
    expect(live.workspaceId).toBe("w1");
    expect(live.tabId).toBe("w1:t2");
    expect(await liveAgents.get(live.instanceId)).toEqual(live);
    expect(events.events.some((e) => e.event === EVENTS.spawnRuntimeReady)).toBe(true);
    expect(layout.releaseCalls).toHaveLength(0);
  });

  it("retries exactly once on a timeout (no agent detected), then fails with RUNTIME_START_TIMEOUT", async () => {
    const herdr = new FakeHerdrClient({
      agentStart: async () => {
        throw new Error("herdr: agent.start timed out");
      },
      paneGet: async (id) => pane(id),
      agentGet: async () => agentInfo({ agent: null }),
    });
    const layout = new FakeLayoutManager([pane("p1")]);
    const manager = makeSpawnManager({ herdr, layout });

    await expect(manager.resolveOrSpawn(baseReq())).rejects.toMatchObject({
      code: ERROR_CODES.RUNTIME_START_TIMEOUT,
    });

    expect(herdr.agentStartCalls).toHaveLength(2);
    expect(layout.releaseCalls).toEqual(["p1"]);
  });

  it("never sends keys and surfaces RUNTIME_START_FAILED when the agent is blocked", async () => {
    const herdr = new FakeHerdrClient({
      agentStart: async () => {
        throw new Error("herdr: agent.start rejected");
      },
      paneGet: async (id) => pane(id),
      agentGet: async () => agentInfo({ agent: "codex", agent_status: "blocked" }),
    });
    const layout = new FakeLayoutManager([pane("p1")]);
    const manager = makeSpawnManager({ herdr, layout });

    await expect(manager.resolveOrSpawn(baseReq())).rejects.toMatchObject({
      code: ERROR_CODES.RUNTIME_START_FAILED,
    });

    // Only one attempt: a blocked classification is terminal, not retried.
    expect(herdr.agentStartCalls).toHaveLength(1);
    expect(herdr.sendKeysCalls).toHaveLength(0);
    expect(layout.releaseCalls).toEqual(["p1"]);
  });

  it("surfaces RUNTIME_NOT_DETECTED without retrying when the pane hosts the wrong kind", async () => {
    const herdr = new FakeHerdrClient({
      agentStart: async () => {
        throw new Error("herdr: agent.start rejected");
      },
      paneGet: async (id) => pane(id),
      agentGet: async () => agentInfo({ agent: "some-other-kind" }),
    });
    const layout = new FakeLayoutManager([pane("p1")]);
    const manager = makeSpawnManager({ herdr, layout });

    await expect(manager.resolveOrSpawn(baseReq())).rejects.toMatchObject({
      code: ERROR_CODES.RUNTIME_NOT_DETECTED,
    });
    expect(herdr.agentStartCalls).toHaveLength(1);
    expect(layout.releaseCalls).toEqual(["p1"]);
  });

  it("allocates a replacement pane once when the pane vanished, then succeeds", async () => {
    let attempt = 0;
    const startedAgent = agentInfo({ pane_id: "p2", terminal_id: "term_p2" });
    const herdr = new FakeHerdrClient({
      agentStart: async (params) => {
        attempt += 1;
        if (attempt === 1) throw new Error("herdr: pane invalid");
        expect(params.paneId).toBe("p2");
        return { agent: startedAgent, argv: [] };
      },
      paneGet: async (id) => {
        if (id === "p1") throw new Error("gone");
        return pane(id);
      },
      agentGet: async () => agentInfo({ agent: null }),
    });
    const layout = new FakeLayoutManager([pane("p1"), pane("p2")]);
    const manager = makeSpawnManager({ herdr, layout });

    const live = await manager.resolveOrSpawn(baseReq());

    expect(live.paneId).toBe("p2");
    expect(layout.allocateVisibleCalls).toHaveLength(2);
    expect(layout.releaseCalls).toHaveLength(0);
  });

  it("releases the allocated pane on a terminal spawn failure", async () => {
    const herdr = new FakeHerdrClient({
      agentStart: async () => {
        throw new Error("boom");
      },
      paneGet: async (id) => pane(id),
      agentGet: async () => agentInfo({ agent: "codex", agent_status: "blocked" }),
    });
    const layout = new FakeLayoutManager([pane("p9")]);
    const manager = makeSpawnManager({ herdr, layout });

    await expect(manager.resolveOrSpawn(baseReq())).rejects.toBeInstanceOf(DelegationFailure);
    expect(layout.releaseCalls).toEqual(["p9"]);
  });
});

describe("DefaultSpawnManager.release", () => {
  it("deletes the live agent and releases its pane", async () => {
    const herdr = new FakeHerdrClient();
    const layout = new FakeLayoutManager([]);
    const liveAgents = new InMemoryLiveAgentStore();
    await liveAgents.put(reusedCandidate());
    const manager = makeSpawnManager({ herdr, layout, liveAgents });

    await manager.release("inst_reused");

    expect(await liveAgents.get("inst_reused")).toBeUndefined();
    expect(layout.releaseCalls).toEqual(["p_existing"]);
  });

  it("is a no-op when the instance is unknown", async () => {
    const herdr = new FakeHerdrClient();
    const layout = new FakeLayoutManager([]);
    const manager = makeSpawnManager({ herdr, layout });

    await expect(manager.release("nope")).resolves.toBeUndefined();
    expect(layout.releaseCalls).toHaveLength(0);
  });
});
