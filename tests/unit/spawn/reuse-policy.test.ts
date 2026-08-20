import { describe, expect, it } from "vitest";

import { DefaultReusePolicy } from "../../../src/spawn/reuse-policy.js";
import { silentLogger } from "../../../src/observability/logger.js";
import type { HerdrClient } from "../../../src/core/ports.js";
import type { AgentDescriptor, LiveAgent, SpawnRequest } from "../../../src/core/model.js";
import type { AgentInfo } from "../../../src/herdr/types.js";

/**
 * Minimal hand-written fake: only `agentGet` is ever exercised by
 * `ReusePolicy`, so every other method throws loudly on an unexpected call.
 */
class FakeHerdrClient implements HerdrClient {
  constructor(private readonly onAgentGet: HerdrClient["agentGet"]) {}

  agentGet: HerdrClient["agentGet"] = (target) => this.onAgentGet(target);

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
  agentStart(): ReturnType<HerdrClient["agentStart"]> {
    throw new Error("FakeHerdrClient: unexpected call to agentStart");
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
  agentSendKeys(): ReturnType<HerdrClient["agentSendKeys"]> {
    throw new Error("FakeHerdrClient: unexpected call to agentSendKeys");
  }
  paneSplit(): ReturnType<HerdrClient["paneSplit"]> {
    throw new Error("FakeHerdrClient: unexpected call to paneSplit");
  }
  paneGet(): ReturnType<HerdrClient["paneGet"]> {
    throw new Error("FakeHerdrClient: unexpected call to paneGet");
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

function descriptor(name: string): AgentDescriptor {
  return {
    name,
    descriptorKind: "runtime",
    runtimeKind: name,
    available: true,
    runtime: {
      kind: name,
      supportedByHerdr: true,
      hasDetectionManifest: true,
      hasIntegration: true,
      launchable: "yes",
      runningInstances: 1,
      sources: ["herdr-cli-kinds"],
    },
    description: `${name} runtime`,
  };
}

function baseReq(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    descriptor: descriptor("codex"),
    cwd: "/work/project",
    visibility: "visible",
    ...overrides,
  };
}

function baseCandidate(overrides: Partial<LiveAgent> = {}): LiveAgent {
  return {
    instanceId: "inst_1",
    logicalTarget: "codex",
    runtimeKind: "codex",
    herdrAgentName: "a2a-codex-a81f",
    paneId: "p1",
    terminalId: "term_1",
    sessionRef: "session-abc",
    cwd: "/work/project",
    visibility: "visible",
    createdAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

function agentInfo(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    terminal_id: "term_1",
    agent_status: "idle",
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "p1",
    focused: false,
    revision: 5,
    agent: "codex",
    interactive_ready: true,
    launch_pending: false,
    agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "session-abc" },
    ...overrides,
  };
}

function makePolicy(opts: { agentGet?: HerdrClient["agentGet"]; hasActiveTask?: (id: string) => Promise<boolean> } = {}) {
  const herdr = new FakeHerdrClient(opts.agentGet ?? (async () => agentInfo()));
  return new DefaultReusePolicy({
    herdr,
    hasActiveTask: opts.hasActiveTask ?? (async () => false),
    logger: silentLogger,
  });
}

describe("DefaultReusePolicy", () => {
  it("reuses an eligible candidate", async () => {
    const policy = makePolicy();
    const candidate = baseCandidate();
    const picked = await policy.pick(baseReq(), [candidate]);
    expect(picked?.instanceId).toBe(candidate.instanceId);
  });

  it("refuses reuse when cwd differs", async () => {
    const policy = makePolicy();
    const candidate = baseCandidate({ cwd: "/somewhere/else" });
    const picked = await policy.pick(baseReq(), [candidate]);
    expect(picked).toBeUndefined();
  });

  it("refuses reuse when the requested model differs", async () => {
    const policy = makePolicy();
    const candidate = baseCandidate({ model: "gpt-5" });
    const picked = await policy.pick(baseReq({ model: "gpt-6" }), [candidate]);
    expect(picked).toBeUndefined();
  });

  it("refuses reuse when the live agent is working", async () => {
    const policy = makePolicy({ agentGet: async () => agentInfo({ agent_status: "working" }) });
    const candidate = baseCandidate();
    const picked = await policy.pick(baseReq(), [candidate]);
    expect(picked).toBeUndefined();
  });

  it("refuses reuse when the live agent is blocked", async () => {
    const policy = makePolicy({ agentGet: async () => agentInfo({ agent_status: "blocked" }) });
    const candidate = baseCandidate();
    const picked = await policy.pick(baseReq(), [candidate]);
    expect(picked).toBeUndefined();
  });

  it("refuses reuse when the candidate has an active task", async () => {
    const policy = makePolicy({ hasActiveTask: async () => true });
    const candidate = baseCandidate();
    const picked = await policy.pick(baseReq(), [candidate]);
    expect(picked).toBeUndefined();
  });

  it("refuses reuse when sessionRef no longer matches (pane occupant replaced)", async () => {
    const policy = makePolicy({
      agentGet: async () =>
        agentInfo({ agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: "someone-elses-session" } }),
    });
    const candidate = baseCandidate();
    const picked = await policy.pick(baseReq(), [candidate]);
    expect(picked).toBeUndefined();
  });

  it("refuses reuse when interactive_ready is false or launch_pending is true", async () => {
    const policyNotReady = makePolicy({ agentGet: async () => agentInfo({ interactive_ready: false }) });
    expect(await policyNotReady.pick(baseReq(), [baseCandidate()])).toBeUndefined();

    const policyPending = makePolicy({ agentGet: async () => agentInfo({ launch_pending: true }) });
    expect(await policyPending.pick(baseReq(), [baseCandidate()])).toBeUndefined();
  });

  it("refuses reuse when the agent is gone from Herdr entirely", async () => {
    const policy = makePolicy({
      agentGet: async () => {
        throw new Error("not found");
      },
    });
    const picked = await policy.pick(baseReq(), [baseCandidate()]);
    expect(picked).toBeUndefined();
  });

  it("refuses reuse when the visibility differs", async () => {
    const policy = makePolicy();
    const candidate = baseCandidate({ visibility: "headless" });
    const picked = await policy.pick(baseReq({ visibility: "visible" }), [candidate]);
    expect(picked).toBeUndefined();
  });

  it("prefers the most recently created eligible candidate", async () => {
    const policy = makePolicy();
    const older = baseCandidate({ instanceId: "inst_old", createdAt: "2026-08-01T00:00:00.000Z", paneId: "p1", terminalId: "term_1" });
    const newer = baseCandidate({ instanceId: "inst_new", createdAt: "2026-08-19T00:00:00.000Z", paneId: "p1", terminalId: "term_1" });
    const picked = await policy.pick(baseReq(), [older, newer]);
    expect(picked?.instanceId).toBe("inst_new");
  });
});
