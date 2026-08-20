import { describe, expect, test, vi } from "vitest";

import { DelegationFailure, ERROR_CODES } from "../../../src/core/errors.js";
import { KeyedMutex } from "../../../src/core/runtime-support.js";
import type { AgentIdentity, LiveAgent, RelayMessage, RelayState } from "../../../src/core/model.js";
import type { Clock, EventSink, HerdrClient, LiveAgentStore, Logger, QueueStore, RelayConfig, RuntimeAdapterRegistry } from "../../../src/core/ports.js";
import type { AgentInfo, AgentStatus } from "../../../src/herdr/types.js";
import { defaultRuntimeAdapter } from "../../../src/runtimes/default-adapter.js";
import { QueuedPromptTransport } from "../../../src/relay/queued-prompt-transport.js";
import { isStableSince } from "../../../src/relay/deliverability.js";

class FakeClock implements Clock {
  private ms = 1_000;
  now(): Date { return new Date(this.ms); }
  nowIso(): string { return this.now().toISOString(); }
  sleep(_ms: number): Promise<void> { return Promise.resolve(); }
  advance(ms: number): void { this.ms += ms; }
}

class MemoryQueue implements QueueStore {
  readonly values: RelayMessage[] = [];
  async push(message: RelayMessage): Promise<number> { this.values.push({ ...message }); return this.depth(message.targetInstanceId); }
  async peek(target: string): Promise<RelayMessage | undefined> {
    return this.values.find((m) => m.targetInstanceId === target && ["QUEUED", "DELIVERING", "DELIVERED"].includes(m.state));
  }
  async get(id: string): Promise<RelayMessage | undefined> { return this.values.find((m) => m.id === id); }
  async setState(id: string, state: RelayState, attempt?: number): Promise<RelayMessage> {
    const message = this.values.find((m) => m.id === id);
    if (!message) throw new Error("missing");
    message.state = state;
    if (attempt !== undefined) message.attempt = attempt;
    return { ...message };
  }
  async remove(id: string): Promise<void> { const index = this.values.findIndex((m) => m.id === id); if (index >= 0) this.values.splice(index, 1); }
  async pendingTargets(): Promise<string[]> { return [...new Set(this.values.filter((m) => ["QUEUED", "DELIVERING", "DELIVERED"].includes(m.state)).map((m) => m.targetInstanceId))]; }
  async depth(target: string): Promise<number> { return this.values.filter((m) => m.targetInstanceId === target && ["QUEUED", "DELIVERING", "DELIVERED"].includes(m.state)).length; }
  async listForTask(task: string): Promise<RelayMessage[]> { return this.values.filter((m) => m.taskId === task); }
}

class MemoryLiveAgents implements LiveAgentStore {
  constructor(private readonly agents: LiveAgent[]) {}
  async put(agent: LiveAgent): Promise<void> { this.agents.push(agent); }
  async get(id: string): Promise<LiveAgent | undefined> { return this.agents.find((a) => a.instanceId === id); }
  async byLogicalTarget(target: string): Promise<LiveAgent[]> { return this.agents.filter((a) => a.logicalTarget === target); }
  async all(): Promise<LiveAgent[]> { return [...this.agents]; }
  async delete(id: string): Promise<void> { const i = this.agents.findIndex((a) => a.instanceId === id); if (i >= 0) this.agents.splice(i, 1); }
}

class ScriptedHerdr implements HerdrClient {
  readonly prompts: { target: string; text: string }[] = [];
  readonly gets: string[] = [];
  status: AgentStatus = "idle";
  seq = 1;
  revision = 1;
  promptResult: () => Promise<AgentInfo> = async () => this.info("working", this.seq + 1, this.revision + 1);
  waitResult: () => Promise<AgentInfo> = async () => this.info("working", this.seq, this.revision);
  recentText = "";
  detectionText = "";
  info(status = this.status, seq = this.seq, revision = this.revision, target = "agent"): AgentInfo {
    return { terminal_id: `${target}-term`, agent_status: status, workspace_id: "w", tab_id: "t", pane_id: `${target}-pane`, focused: false, revision, agent: "codex", interactive_ready: true, launch_pending: false, state_change_seq: seq };
  }
  async ping(): Promise<any> { throw new Error("unused"); }
  async sessionSnapshot(): Promise<any> { throw new Error("unused"); }
  async agentManifests(): Promise<any> { throw new Error("unused"); }
  async agentList(): Promise<AgentInfo[]> { return []; }
  async agentGet(target: string): Promise<AgentInfo> { this.gets.push(target); return this.info(this.status, this.seq, this.revision, target); }
  async agentStart(): Promise<any> { throw new Error("unused"); }
  async agentPrompt(params: { target: string; text: string }): Promise<AgentInfo> { this.prompts.push(params); return this.promptResult(); }
  async agentWait(): Promise<AgentInfo> { return this.waitResult(); }
  async agentRead(params: { source: string }): Promise<string> { return params.source === "detection" ? this.detectionText : this.recentText; }
  async agentSendKeys(): Promise<void> { throw new Error("must not send keys"); }
  async paneSplit(): Promise<any> { throw new Error("unused"); }
  async paneGet(): Promise<any> { throw new Error("unused"); }
  async paneList(): Promise<any[]> { return []; }
  async paneClose(): Promise<void> {}
  async paneLayout(): Promise<any> { throw new Error("unused"); }
  async tabCreate(): Promise<any> { throw new Error("unused"); }
  async subscribe(): Promise<any> { throw new Error("unused"); }
  async close(): Promise<void> {}
}

const logger: Logger = { log: () => {}, child: () => logger };
const sender: AgentIdentity = { role: "peer-agent", name: "claude", ref: "a81f" };
const adapterRegistry: RuntimeAdapterRegistry = { for: () => defaultRuntimeAdapter };

function live(id = "one"): LiveAgent {
  return { instanceId: id, logicalTarget: "codex", runtimeKind: "codex", herdrAgentName: id, paneId: `${id}-pane`, terminalId: `${id}-term`, cwd: "/tmp", visibility: "headless", createdAt: new Date(0).toISOString() };
}

function message(id = "m1", target = "one", expiresAt?: string): RelayMessage {
  return { id, taskId: `task-${id}`, targetInstanceId: target, from: sender, to: { role: "peer-agent", name: "codex" }, body: `body-${id}`, state: "QUEUED", attempt: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), expiresAt };
}

async function flush(): Promise<void> { for (let i = 0; i < 50; i += 1) await Promise.resolve(); }

function setup(overrides: Partial<RelayConfig> = {}, agents = [live()]): { relay: QueuedPromptTransport; queue: MemoryQueue; herdr: ScriptedHerdr; clock: FakeClock; emitted: { event: string; fields?: Record<string, unknown> }[] } {
  const clock = new FakeClock();
  const queue = new MemoryQueue();
  const herdr = new ScriptedHerdr();
  const emitted: { event: string; fields?: Record<string, unknown> }[] = [];
  const eventSink: EventSink = { emit: (event, fields) => emitted.push({ event, fields }) };
  const relay = new QueuedPromptTransport({ herdr, queue, liveAgents: new MemoryLiveAgents(agents), adapters: adapterRegistry, lock: new KeyedMutex(), clock, config: { stableWindowMs: 0, turnStartTimeoutMs: 10, settleTimeoutMs: 10, messageTtlMs: 100, maxQueueDepth: 4, maxDeliveryAttempts: 2, ...overrides }, events: eventSink, logger });
  return { relay, queue, herdr, clock, emitted };
}

describe("QueuedPromptTransport", () => {
  test("preserves sender attribution in delivered text", async () => {
    const { relay, herdr } = setup();
    await relay.start(); await relay.enqueue(message()); await flush();
    expect(herdr.prompts[0]?.text).toContain("from: claude:a81f");
    expect(herdr.prompts[0]?.text).toContain("body-m1");
    await relay.stop();
  });

  test("delivers FIFO heads in order for one target", async () => {
    const { relay, herdr } = setup();
    await relay.start(); await relay.enqueue(message("first")); await relay.enqueue(message("second")); await flush();
    expect(herdr.prompts.map((prompt) => prompt.text.includes("body-first") ? "first" : "second")).toEqual(["first", "second"]);
    await relay.stop();
  });

  test("does not count unchanged working state as TURN_STARTED", async () => {
    const { relay, queue, herdr } = setup({ maxDeliveryAttempts: 1 });
    herdr.promptResult = async () => herdr.info("working", 1, 2, "one");
    herdr.waitResult = async () => herdr.info("working", 1, 2, "one");
    await relay.start(); await relay.enqueue(message()); await flush();
    expect((await queue.get("m1"))?.state).toBe("FAILED");
    await relay.stop();
  });

  test("proves turn start only when working advances past the pre-prompt sequence", async () => {
    const { relay, queue, herdr } = setup();
    herdr.promptResult = async () => herdr.info("working", 2, 2, "one");
    const starts: number[] = []; relay.onTurnStarted((_m, preSeq) => starts.push(preSeq));
    await relay.start(); await relay.enqueue(message()); await flush();
    expect((await queue.get("m1"))?.state).toBe("TURN_STARTED");
    expect(starts).toEqual([1]);
    await relay.stop();
  });

  test("short-circuits agent_prompt_stalled without waiting for turn timeout", async () => {
    const { relay, queue, herdr } = setup({ maxDeliveryAttempts: 1, turnStartTimeoutMs: 999_999 });
    herdr.promptResult = async () => { throw new DelegationFailure(ERROR_CODES.HERDR_API_ERROR, "stalled", { herdrCode: "agent_prompt_stalled" }); };
    await relay.start(); await relay.enqueue(message()); await flush();
    expect((await queue.get("m1"))?.state).toBe("FAILED");
    expect(herdr.prompts).toHaveLength(1);
    await relay.stop();
  });

  test("retries exactly maxDeliveryAttempts times then fails", async () => {
    const { relay, queue, herdr } = setup({ maxDeliveryAttempts: 2 });
    herdr.promptResult = async () => herdr.info("working", 1, 2, "one");
    herdr.waitResult = async () => herdr.info("working", 1, 2, "one");
    await relay.start(); await relay.enqueue(message()); await flush();
    expect(herdr.prompts).toHaveLength(2);
    expect((await queue.get("m1"))?.state).toBe("FAILED");
    await relay.stop();
  });

  test("suppresses a retry when a post-failure read proves the prompt already landed", async () => {
    const { relay, queue, herdr } = setup({ maxDeliveryAttempts: 2 });
    herdr.promptResult = async () => { throw new Error("connection dropped after write"); };
    herdr.recentText = "[peer-agent message]\nfrom: claude:a81f\ntask: task-m1\n\nbody-m1";
    await relay.start(); await relay.enqueue(message()); await flush();
    expect(herdr.prompts).toHaveLength(1);
    expect((await queue.get("m1"))?.state).toBe("FAILED");
    await relay.stop();
  });

  test("keeps blocked work queued, reports its classified blocker, and sends no prompt", async () => {
    const { relay, queue, herdr } = setup();
    herdr.status = "blocked"; herdr.detectionText = "Please log in to continue";
    const blockers: string[] = []; relay.onBlocked((_m, blocker) => blockers.push(blocker.kind));
    await relay.start(); await relay.enqueue(message()); await flush();
    expect((await queue.get("m1"))?.state).toBe("QUEUED");
    expect(herdr.prompts).toHaveLength(0); expect(blockers).toEqual(["auth"]);
    await relay.stop();
  });

  test("expires an old head and proceeds to the next FIFO message", async () => {
    const { relay, queue, herdr, clock } = setup();
    await relay.start();
    await relay.enqueue(message("old", "one", new Date(999).toISOString()));
    await relay.enqueue(message("new"));
    await flush();
    expect((await queue.get("old"))?.state).toBe("EXPIRED");
    expect(herdr.prompts[0]?.text).toContain("body-new");
    clock.advance(1); await relay.stop();
  });

  test("is idempotent for duplicate message ids and rejects an overfull target queue", async () => {
    const { relay } = setup({ maxQueueDepth: 1 });
    const first = await relay.enqueue(message());
    const duplicate = await relay.enqueue(message());
    expect(duplicate.messageId).toBe(first.messageId);
    await expect(relay.enqueue(message("m2"))).rejects.toMatchObject({ code: ERROR_CODES.QUEUE_FULL });
    await relay.stop();
  });

  test("fails identity drift without retrying or typing", async () => {
    const { relay, queue, herdr, emitted } = setup();
    herdr.info = (status = herdr.status, seq = herdr.seq, revision = herdr.revision, target = "agent") => ({ terminal_id: `${target}-replacement`, agent_status: status, workspace_id: "w", tab_id: "t", pane_id: `${target}-pane`, focused: false, revision, agent: "codex", interactive_ready: true, launch_pending: false, state_change_seq: seq });
    await relay.start(); await relay.enqueue(message()); await flush();
    expect((await queue.get("m1"))?.state).toBe("FAILED"); expect(herdr.prompts).toHaveLength(0);
    expect(emitted.some((entry) => entry.fields?.["code"] === ERROR_CODES.TARGET_IDENTITY_CHANGED)).toBe(true);
    await relay.stop();
  });

  test("restarts the stability window after state_change_seq changes", async () => {
    vi.useFakeTimers();
    const { relay, herdr, clock } = setup({ stableWindowMs: 10 });
    let reads = 0;
    herdr.agentGet = async (target: string) => { reads += 1; return herdr.info("idle", reads < 2 ? 1 : 2, reads < 2 ? 1 : 2, target); };
    await relay.start(); await relay.enqueue(message()); await flush();
    clock.advance(10); await vi.advanceTimersByTimeAsync(10); await flush();
    expect(herdr.prompts).toHaveLength(0);
    clock.advance(10); await vi.advanceTimersByTimeAsync(10); await flush();
    expect(herdr.prompts).toHaveLength(1);
    await relay.stop(); vi.useRealTimers();
  });

  test("does not interleave callers targeting the same worker", async () => {
    const { relay, herdr } = setup();
    let release!: () => void;
    herdr.promptResult = () => new Promise<AgentInfo>((resolve) => { release = () => { herdr.status = "working"; herdr.seq = 2; herdr.revision = 2; resolve(herdr.info("working", 2, 2, "one")); }; });
    await relay.start(); await Promise.all([relay.enqueue(message("m1")), relay.enqueue(message("m2"))]); await flush();
    expect(herdr.prompts).toHaveLength(1);
    release(); await flush(); expect(herdr.prompts).toHaveLength(1);
    await relay.stop();
  });

  test("does not serialize two different targets behind a long settlement", async () => {
    const agents = [live("one"), live("two")]; const { relay, herdr } = setup({}, agents);
    herdr.promptResult = async () => herdr.info("working", 2, 2, "one");
    herdr.agentWait = async () => new Promise<AgentInfo>(() => {});
    await relay.start(); await Promise.all([relay.enqueue(message("m1", "one")), relay.enqueue(message("m2", "two"))]); await flush();
    expect(herdr.prompts.map((p) => p.target).sort()).toEqual(["one", "two"]);
    await relay.stop();
  });

  test("stop clears the pending stability timer", async () => {
    vi.useFakeTimers();
    const { relay } = setup({ stableWindowMs: 100 });
    await relay.start(); await relay.enqueue(message()); await flush();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await relay.stop(); expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe("deliverability stability", () => {
  test("requires both sequence and revision to remain unchanged", () => {
    const snapshot = { stateChangeSeq: 4, revision: 9 } as any;
    expect(isStableSince({ stateChangeSeq: 4, revision: 8, observedAtMs: 0 }, snapshot, 100, 100)).toBe(false);
    expect(isStableSince({ stateChangeSeq: 4, revision: 9, observedAtMs: 0 }, snapshot, 100, 100)).toBe(true);
  });
});
