import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ERROR_CODES, DelegationFailure } from "../../src/core/errors.js";
import { KeyedMutex } from "../../src/core/runtime-support.js";
import type { AgentIdentity, DelegatedTask, LiveAgent, RelayMessage } from "../../src/core/model.js";
import { DelegatedTaskService } from "../../src/core/task-service.js";
import { createStores } from "../../src/persistence/index.js";
import { QueuedPromptTransport } from "../../src/relay/queued-prompt-transport.js";
import { defaultRuntimeAdapter } from "../../src/runtimes/default-adapter.js";
import { FakeHerdr, RecordingEvents, TestClock, agent, flush, logger, targetGoneError} from "./helpers/fakes.js";

const sender: AgentIdentity = { role: "peer-agent", name: "caller", ref: "c001" };
const adapters = { for: () => defaultRuntimeAdapter };

function live(id = "one"): LiveAgent {
  return { instanceId: id, logicalTarget: "codex", runtimeKind: "codex", herdrAgentName: id, paneId: `${id}-pane`, terminalId: `${id}-term`, sessionRef: `session-${id}`, cwd: "/tmp", visibility: "headless", createdAt: new Date(0).toISOString() };
}
function message(id = "m1", target = "one", expiresAt?: string): RelayMessage {
  return { id, taskId: `task-${id}`, targetInstanceId: target, from: sender, to: { role: "peer-agent", name: "codex" }, body: `body-${id}`, state: "QUEUED", attempt: 0, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), expiresAt };
}
function task(id = "m1", instance = "one"): DelegatedTask {
  return { id: `task-${id}`, caller: sender, target: { role: "peer-agent", name: "codex" }, liveInstanceId: instance, state: "submitted", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
}

function setup(config: Partial<{ stableWindowMs: number; maxQueueDepth: number; maxDeliveryAttempts: number }> = {}) {
  const clock = new TestClock();
  const stores = createStores({ dbPath: ":memory:", clock });
  const herdr = new FakeHerdr();
  const events = new RecordingEvents();
  const relay = new QueuedPromptTransport({
    herdr, queue: stores.queue, liveAgents: stores.liveAgents, adapters, lock: new KeyedMutex(), clock,
    config: { stableWindowMs: config.stableWindowMs ?? 0, turnStartTimeoutMs: 1_000, settleTimeoutMs: 1_000, messageTtlMs: 10_000, maxQueueDepth: config.maxQueueDepth ?? 4, maxDeliveryAttempts: config.maxDeliveryAttempts ?? 1 },
    events, logger,
  });
  const tasks = new DelegatedTaskService({ tasks: stores.tasks, liveAgents: stores.liveAgents, herdr, adapters, clock, events, logger });
  relay.onTurnStarted((m, preSeq) => { void tasks.noteTurnStarted(m, preSeq); });
  relay.onBlocked((m, blocker) => { void tasks.transition(m.taskId, blocker.kind === "auth" ? "auth-required" : "input-required", blocker.text ? { question: blocker.text } : {}); });
  relay.onStateChange((m) => { if (m.state === "SETTLED") void tasks.settleFromRelay(m.taskId, m.targetInstanceId); });
  return { clock, stores, herdr, events, relay, tasks };
}
async function seed(s: ReturnType<typeof setup>, id = "m1", target = "one", expiresAt?: string) {
  await s.stores.liveAgents.put(live(target));
  await s.stores.tasks.create(task(id, target));
  await s.relay.start();
  await s.relay.enqueue(message(id, target, expiresAt));
}
async function stop(s: ReturnType<typeof setup>) { await s.relay.stop(); s.stores.close(); }

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function failureCode(s: ReturnType<typeof setup>): unknown {
  return [...s.events.entries].reverse().find((e) => e.event === "relay.failed")?.fields.code;
}

describe("fault injection: relay delivery", () => {
  test("Herdr disconnect mid-flight fails once with DELIVERY_FAILED and never leaks a retry timer", async () => {
    const s = setup();
    s.herdr.promptScript = [new Error("ECONNRESET after write")];
    await seed(s); await flush();
    expect(await s.stores.queue.get("m1")).toMatchObject({ state: "FAILED", attempt: 1 });
    expect(failureCode(s)).toBe(ERROR_CODES.DELIVERY_FAILED);
    expect(s.herdr.calls).toMatchObject({ agentGet: 2, agentPrompt: 1, agentRead: 1, agentWait: 0 });
    await stop(s); expect(vi.getTimerCount()).toBe(0);
  });

  test("retry suppression recognizes the task marker after terminal reflow, not the full envelope", async () => {
    const s = setup({ maxDeliveryAttempts: 2 });
    s.herdr.promptScript = [new Error("connection reset")];
    s.herdr.readText.recent_unwrapped = "wrapped output\n task: task-m1\nbody split across rows";
    await seed(s); await flush();
    expect(await s.stores.queue.get("m1")).toMatchObject({ state: "FAILED", attempt: 1 });
    expect(failureCode(s)).toBe(ERROR_CODES.DELIVERY_FAILED);
    expect(s.herdr.calls).toMatchObject({ agentPrompt: 1, agentRead: 1, agentGet: 2 });
    await stop(s); expect(vi.getTimerCount()).toBe(0);
  });

  test("a pane that disappears before its queued delivery fails TARGET_LOST without contacting Herdr", async () => {
    const s = setup();
    await s.stores.tasks.create(task());
    await s.relay.start();
    await s.relay.enqueue(message()); await flush();
    expect(await s.stores.queue.get("m1")).toMatchObject({ state: "FAILED", attempt: 0 });
    expect(failureCode(s)).toBe(ERROR_CODES.TARGET_LOST);
    expect(s.herdr.calls).toMatchObject({ agentGet: 0, agentPrompt: 0, agentRead: 0 });
    await stop(s); expect(vi.getTimerCount()).toBe(0);
  });

  test("a vanished target after bounded queue probes fails TARGET_LOST", async () => {
    const s = setup();
    s.herdr.current = agent("one", { agent_status: "working" });
    s.herdr.getScript = [agent("one", { agent_status: "working" }), agent("one", { agent_status: "working" }), agent("one", { agent_status: "working" }), agent("one", { agent_status: "working" }), targetGoneError("one")];
    await seed(s); await flush();
    await vi.runAllTimersAsync(); await flush();
    expect(await s.stores.queue.get("m1")).toMatchObject({ state: "FAILED" });
    expect(failureCode(s)).toBe(ERROR_CODES.TARGET_LOST);
    expect(s.herdr.calls).toMatchObject({ agentGet: 5, agentPrompt: 0, agentRead: 0 });
    await stop(s); expect(vi.getTimerCount()).toBe(0);
  });

  test("a human turn while queued refreshes the bounded probe budget, then stops after four new probes", async () => {
    const s = setup();
    s.herdr.current = agent("one", { agent_status: "working" });
    await seed(s); await flush();
    s.relay.notifyTargetChanged("one"); await flush();
    await vi.runAllTimersAsync(); await flush();
    expect(await s.stores.queue.get("m1")).toMatchObject({ state: "QUEUED", attempt: 0 });
    expect(s.herdr.calls).toMatchObject({ agentGet: 6, agentPrompt: 0, agentRead: 0 });
    await stop(s); expect(vi.getTimerCount()).toBe(0);
  });

  test("a replacement occupant in the same pane fails TARGET_IDENTITY_CHANGED before any prompt", async () => {
    const s = setup();
    s.herdr.current = agent("one", { agent_session: { source: "fake", agent: "codex", kind: "id", value: "replacement-session" } });
    await seed(s); await flush();
    expect(await s.stores.queue.get("m1")).toMatchObject({ state: "FAILED", attempt: 0 });
    expect(failureCode(s)).toBe(ERROR_CODES.TARGET_IDENTITY_CHANGED);
    expect(s.herdr.calls).toMatchObject({ agentGet: 1, agentPrompt: 0, agentRead: 0 });
    await stop(s); expect(vi.getTimerCount()).toBe(0);
  });

  test("a permission/auth blocker stays queued, surfaces auth-required, and never sends keys", async () => {
    const s = setup();
    s.herdr.current = agent("one", { agent_status: "blocked" });
    s.herdr.readText.detection = "Please log in to continue";
    await seed(s); await flush();
    expect(await s.stores.queue.get("m1")).toMatchObject({ state: "QUEUED", attempt: 0 });
    expect((await s.stores.tasks.get("task-m1"))?.state).toBe("auth-required");
    expect((await s.stores.tasks.get("task-m1"))?.error).toBeUndefined();
    expect(s.herdr.calls).toMatchObject({ agentGet: 1, agentPrompt: 0, agentSendKeys: 0, agentRead: 1 });
    await stop(s); expect(vi.getTimerCount()).toBe(0);
  });

  test("unchanged working sequence is not a turn start and fails TURN_DID_NOT_START without extra prompts", async () => {
    const s = setup();
    s.herdr.promptScript = [agent("one", { agent_status: "working", state_change_seq: 1, revision: 2 })];
    s.herdr.waitScript = [agent("one", { agent_status: "working", state_change_seq: 1, revision: 2 })];
    await seed(s); await flush();
    expect(await s.stores.queue.get("m1")).toMatchObject({ state: "FAILED", attempt: 1 });
    expect(failureCode(s)).toBe(ERROR_CODES.TURN_DID_NOT_START);
    expect(s.herdr.calls).toMatchObject({ agentGet: 2, agentPrompt: 1, agentWait: 1, agentRead: 1 });
    await stop(s); expect(vi.getTimerCount()).toBe(0);
  });

  test("agent_prompt_stalled maps directly to TURN_DID_NOT_START and skips agent.wait", async () => {
    const s = setup();
    s.herdr.promptScript = [new DelegationFailure(ERROR_CODES.HERDR_API_ERROR, "stalled", { herdrCode: "agent_prompt_stalled" })];
    await seed(s); await flush();
    expect(await s.stores.queue.get("m1")).toMatchObject({ state: "FAILED", attempt: 1 });
    expect(failureCode(s)).toBe(ERROR_CODES.TURN_DID_NOT_START);
    expect(s.herdr.calls).toMatchObject({ agentGet: 2, agentPrompt: 1, agentWait: 0, agentRead: 1 });
    await stop(s); expect(vi.getTimerCount()).toBe(0);
  });

  test("queue overflow rejects QUEUE_FULL without changing the two FIFO entries", async () => {
    const s = setup({ maxQueueDepth: 2 });
    s.herdr.current = agent("one", { agent_status: "working" });
    await s.stores.liveAgents.put(live()); await s.relay.start();
    await s.relay.enqueue(message("first")); await flush();
    await s.relay.enqueue(message("second")); await flush();
    await expect(s.relay.enqueue(message("third"))).rejects.toMatchObject({ code: ERROR_CODES.QUEUE_FULL });
    expect(await s.stores.queue.get("first")).toMatchObject({ state: "QUEUED" });
    expect(await s.stores.queue.get("second")).toMatchObject({ state: "QUEUED" });
    expect(s.herdr.calls).toMatchObject({ agentPrompt: 0, agentGet: 2, agentRead: 0 });
    await stop(s); expect(vi.getTimerCount()).toBe(0);
  });

  test("TTL expiry terminalizes the head and allows the next FIFO message to settle", async () => {
    const s = setup();
    await s.stores.liveAgents.put(live()); await s.stores.tasks.create(task("old")); await s.stores.tasks.create(task("next")); await s.relay.start();
    await s.relay.enqueue(message("old", "one", new Date(1_000).toISOString()));
    await s.relay.enqueue(message("next")); await flush();
    expect(await s.stores.queue.get("old")).toMatchObject({ state: "EXPIRED", attempt: 0 });
    expect(await s.stores.queue.get("next")).toMatchObject({ state: "SETTLED", attempt: 1 });
    expect(s.herdr.calls).toMatchObject({ agentPrompt: 1, agentGet: 3, agentWait: 1 });
    await stop(s); expect(vi.getTimerCount()).toBe(0);
  });

  test("two callers to one target do not interleave a second prompt before the first turn starts", async () => {
    const s = setup();
    let release: (() => void) | undefined;
    s.herdr.promptScript = [];
    s.herdr.agentPrompt = async (params) => {
      s.herdr.calls.agentPrompt += 1; s.herdr.promptTexts.push(params.text); s.herdr.promptTargets.push(params.target);
      return new Promise((resolve) => { release = () => { s.herdr.current = agent("one", { agent_status: "working", state_change_seq: 2, revision: 2 }); resolve(s.herdr.current); }; });
    };
    s.herdr.agentWait = async () => new Promise(() => {});
    await s.stores.liveAgents.put(live()); await s.stores.tasks.create(task("first")); await s.stores.tasks.create(task("second")); await s.relay.start();
    await Promise.all([s.relay.enqueue(message("first")), s.relay.enqueue(message("second"))]); await flush();
    expect(s.herdr.calls).toMatchObject({ agentPrompt: 1, agentGet: 2 });
    release?.(); await flush();
    expect(await s.stores.queue.get("second")).toMatchObject({ state: "QUEUED", attempt: 0 });
    expect(s.herdr.calls.agentPrompt).toBe(1);
    await stop(s); expect(vi.getTimerCount()).toBe(0);
  });

  test("an agent that exits after accepting a prompt fails TARGET_LOST", async () => {
    const s = setup();
    s.herdr.promptScript = [agent("one", { agent_status: "working", state_change_seq: 2, revision: 2 })];
    s.herdr.waitScript = [targetGoneError("one")];
    await seed(s); await flush();
    expect(await s.stores.queue.get("m1")).toMatchObject({ state: "FAILED" });
    expect(failureCode(s)).toBe(ERROR_CODES.TARGET_LOST);
    expect(s.herdr.calls).toMatchObject({ agentGet: 2, agentPrompt: 1, agentWait: 1, agentRead: 0 });
    await stop(s); expect(vi.getTimerCount()).toBe(0);
  });
});
