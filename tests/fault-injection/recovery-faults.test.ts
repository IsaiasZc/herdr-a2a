import { describe, expect, test, vi } from "vitest";

import { ERROR_CODES } from "../../src/core/errors.js";
import type { AgentSnapshot, DelegatedTask, LiveAgent, RelayMessage } from "../../src/core/model.js";
import type { QueueStore, Relay, RelayReceipt } from "../../src/core/ports.js";
import { StateReconciler } from "../../src/core/reconciliation.js";
import { DelegatedTaskService } from "../../src/core/task-service.js";
import { HerdrSessionCache } from "../../src/herdr/session-cache.js";
import { createStores } from "../../src/persistence/index.js";
import { defaultRuntimeAdapter } from "../../src/runtimes/default-adapter.js";
import { FakeHerdr, RecordingEvents, TestClock, agent, flush, logger, snapshot } from "./helpers/fakes.js";

const adapters = { for: () => defaultRuntimeAdapter };
function live(overrides: Partial<LiveAgent> = {}): LiveAgent {
  return { instanceId: "inst", logicalTarget: "codex", runtimeKind: "codex", herdrAgentName: "one", paneId: "old-pane", terminalId: "one-term", sessionRef: "session-one", cwd: "/tmp", visibility: "headless", createdAt: new Date(0).toISOString(), ...overrides };
}
function task(overrides: Partial<DelegatedTask> = {}): DelegatedTask {
  return { id: "task-1", caller: { role: "peer-agent", name: "caller" }, target: { role: "peer-agent", name: "codex" }, liveInstanceId: "inst", state: "submitted", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), ...overrides };
}
class RelayProbe implements Relay {
  cancels: string[] = [];
  constructor(private readonly queue: QueueStore) {}
  async start() {} async stop() {} async enqueue(message: RelayMessage): Promise<RelayReceipt> { return { messageId: message.id, state: message.state, queuePosition: 1 }; }
  async cancel() {} async cancelForTarget(id: string) { this.cancels.push(id); let head = await this.queue.peek(id); while (head) { await this.queue.remove(head.id); head = await this.queue.peek(id); } }
  onStateChange() { return () => {}; } onTurnStarted() { return () => {}; } onBlocked() { return () => {}; } notifyTargetChanged() {}
}
function setup() {
  const clock = new TestClock(); const stores = createStores({ dbPath: ":memory:", clock }); const herdr = new FakeHerdr(); const events = new RecordingEvents(); const relay = new RelayProbe(stores.queue);
  const taskService = new DelegatedTaskService({ tasks: stores.tasks, liveAgents: stores.liveAgents, herdr, adapters, clock, events, logger });
  const cache = new HerdrSessionCache({ herdr, clock, logger, events, reconnectDelaysMs: [10] });
  const reconciler = new StateReconciler({ herdr, sessionCache: cache, liveAgents: stores.liveAgents, tasks: stores.tasks, queue: stores.queue, relay, taskService, clock, events, logger });
  return { clock, stores, herdr, events, relay, taskService, cache, reconciler };
}
function idle(seq: number): AgentSnapshot { return { paneId: "new-pane", terminalId: "one-term", agent: "codex", status: "idle", interactiveReady: true, launchPending: false, stateChangeSeq: seq, revision: seq, sessionRef: "session-one", screenDetectionSkipped: false, stateLabels: {}, observedAt: new Date(0).toISOString() }; }

describe("fault injection: restart and reconciliation", () => {
  test("gateway restart reattaches by session identity and refreshes a changed pane id", async () => {
    vi.useFakeTimers(); const s = setup();
    await s.stores.liveAgents.put(live());
    s.herdr.list = [agent("one", { pane_id: "new-pane", terminal_id: "new-term", name: "renamed", agent_session: { source: "fake", agent: "codex", kind: "id", value: "session-one" } })];
    const result = await s.reconciler.reconcile();
    expect(result).toEqual({ verified: 1, orphaned: 0 });
    expect(await s.stores.liveAgents.get("inst")).toMatchObject({ paneId: "new-pane", terminalId: "new-term", herdrAgentName: "renamed" });
    expect(s.herdr.calls).toMatchObject({ agentList: 1, agentGet: 0 }); expect(s.relay.cancels).toEqual([]);
    s.stores.close(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });

  test("gateway restart orphans a vanished worker, cancels its queue, and fails the live task TARGET_LOST", async () => {
    vi.useFakeTimers(); const s = setup();
    await s.stores.liveAgents.put(live()); await s.stores.tasks.create(task());
    await s.stores.queue.push({ id: "m1", taskId: "task-1", targetInstanceId: "inst", from: { role: "system", name: "test" }, to: { role: "peer-agent", name: "codex" }, body: "queued", state: "QUEUED", attempt: 0, createdAt: s.clock.nowIso(), updatedAt: s.clock.nowIso() });
    s.herdr.list = [];
    expect(await s.reconciler.reconcile()).toEqual({ verified: 0, orphaned: 1 });
    expect(await s.stores.liveAgents.get("inst")).toBeUndefined();
    expect(await s.stores.queue.get("m1")).toBeUndefined();
    expect(await s.stores.tasks.get("task-1")).toMatchObject({ state: "failed", error: { code: ERROR_CODES.TARGET_LOST } });
    expect(s.herdr.calls).toMatchObject({ agentList: 1, agentGet: 0 }); expect(s.relay.cancels).toEqual(["inst"]);
    s.stores.close(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });

  test("gateway restart re-establishes a working turn baseline, then observe settles only after a later sequence", async () => {
    vi.useFakeTimers(); const s = setup();
    await s.stores.liveAgents.put(live()); await s.stores.tasks.create(task({ state: "working" }));
    s.herdr.list = [agent("one", { pane_id: "new-pane", state_change_seq: 4, revision: 4 })];
    s.herdr.getScript = [agent("one", { pane_id: "new-pane", agent_status: "working", state_change_seq: 4, revision: 4 })];
    await s.reconciler.reconcile();
    await s.taskService.observe("inst", idle(4));
    expect((await s.stores.tasks.get("task-1"))?.state).toBe("working");
    expect((await s.stores.tasks.get("task-1"))?.error).toBeUndefined();
    s.herdr.readText.recent_unwrapped = "final answer";
    await s.taskService.observe("inst", idle(5));
    expect(await s.stores.tasks.get("task-1")).toMatchObject({ state: "completed", result: { text: "final answer" } });
    expect(s.herdr.calls).toMatchObject({ agentList: 1, agentGet: 1, agentRead: 1 });
    s.stores.close(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });

  test("relay settlement completes a working task even when no status event follows", async () => {
    vi.useFakeTimers(); const s = setup();
    await s.stores.liveAgents.put(live()); await s.stores.tasks.create(task({ state: "working" }));
    s.herdr.current = agent("one", { agent_status: "idle", state_change_seq: 7, revision: 7 }); s.herdr.readText.recent_unwrapped = "result without pane.updated";
    await s.taskService.settleFromRelay("task-1", "inst");
    expect(await s.stores.tasks.get("task-1")).toMatchObject({ state: "completed", result: { text: "result without pane.updated" } });
    expect(s.herdr.calls).toMatchObject({ agentGet: 1, agentRead: 1, agentList: 0 });
    s.stores.close(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });

  test("Herdr restart resnapshots before onResync and subscribes only to the global pane.updated feed", async () => {
    vi.useFakeTimers(); const s = setup();
    s.herdr.session = snapshot([agent("one")]);
    let resyncSnapshots = 0;
    s.cache.onResync(() => { resyncSnapshots = s.herdr.calls.snapshot; });
    await s.cache.start(); await vi.runAllTimersAsync(); await flush();
    s.cache.handleDisconnect(); await vi.advanceTimersByTimeAsync(10); await vi.runAllTimersAsync(); await flush();
    expect(resyncSnapshots).toBe(2);
    expect(s.herdr.calls).toMatchObject({ snapshot: 2, subscribe: 2, agentGet: 0 });
    expect(s.herdr.subscriptions.flat().map((sub) => sub.type)).toContain("pane.updated");
    expect(s.herdr.subscriptions.flat().map((sub) => sub.type)).not.toContain("pane.agent_status_changed");
    await s.cache.stop(); s.stores.close(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });
});
