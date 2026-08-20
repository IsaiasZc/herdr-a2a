import { beforeEach, describe, expect, it } from "vitest";

import type { AgentIdentity, RelayMessage } from "../../../src/core/model.js";
import type { Clock } from "../../../src/core/ports.js";
import { openDatabase } from "../../../src/persistence/db.js";
import { SqliteQueueStore } from "../../../src/persistence/repositories/queue-store.js";

function createFakeClock(startIso = "2024-01-01T00:00:00.000Z"): Clock & { set(iso: string): void } {
  let current = startIso;
  return {
    now: () => new Date(current),
    nowIso: () => current,
    sleep: () => Promise.resolve(),
    set(iso: string) {
      current = iso;
    },
  };
}

const from: AgentIdentity = { role: "human", name: "cc" };
const to: AgentIdentity = { role: "peer-agent", name: "codex", ref: "a81f" };

function makeMessage(overrides: Partial<RelayMessage> = {}): RelayMessage {
  return {
    id: "msg_1",
    taskId: "task_1",
    targetInstanceId: "inst_1",
    from,
    to,
    body: "hello",
    state: "QUEUED",
    attempt: 0,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("SqliteQueueStore", () => {
  let clock: ReturnType<typeof createFakeClock>;
  let store: SqliteQueueStore;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    clock = createFakeClock();
    store = new SqliteQueueStore(db, clock);
  });

  it("preserves FIFO order via seq when two messages share the same timestamp", async () => {
    const sameTimestamp = "2024-01-01T00:00:00.000Z";
    const first = makeMessage({ id: "msg_first", createdAt: sameTimestamp, updatedAt: sameTimestamp });
    const second = makeMessage({ id: "msg_second", createdAt: sameTimestamp, updatedAt: sameTimestamp });

    await store.push(first);
    await store.push(second);

    // Both messages share created_at exactly — only `seq` can disambiguate.
    const peeked = await store.peek("inst_1");
    expect(peeked?.id).toBe("msg_first");

    await store.setState("msg_first", "SETTLED");
    const next = await store.peek("inst_1");
    expect(next?.id).toBe("msg_second");
  });

  it("push returns the new queue depth for the target", async () => {
    expect(await store.push(makeMessage({ id: "msg_1" }))).toBe(1);
    expect(await store.push(makeMessage({ id: "msg_2" }))).toBe(2);
    expect(await store.push(makeMessage({ id: "msg_3", targetInstanceId: "inst_2" }))).toBe(1);
  });

  it("peek skips terminal-state messages and returns the oldest live one", async () => {
    await store.push(makeMessage({ id: "msg_1", state: "QUEUED" }));
    await store.push(makeMessage({ id: "msg_2", state: "QUEUED" }));
    await store.push(makeMessage({ id: "msg_3", state: "QUEUED" }));

    // Mark the oldest as terminal (SETTLED) and the second as also terminal (EXPIRED).
    await store.setState("msg_1", "SETTLED");
    await store.setState("msg_2", "EXPIRED");

    const peeked = await store.peek("inst_1");
    expect(peeked?.id).toBe("msg_3");
  });

  it("peek returns undefined when every message for a target is terminal", async () => {
    await store.push(makeMessage({ id: "msg_1", state: "QUEUED" }));
    await store.setState("msg_1", "FAILED");

    expect(await store.peek("inst_1")).toBeUndefined();
  });

  it("setState bumps updated_at and optionally sets attempt", async () => {
    await store.push(makeMessage({ id: "msg_1" }));
    clock.set("2024-01-01T00:10:00.000Z");

    const updated = await store.setState("msg_1", "DELIVERING", 2);
    expect(updated.state).toBe("DELIVERING");
    expect(updated.attempt).toBe(2);
    expect(updated.updatedAt).toBe("2024-01-01T00:10:00.000Z");

    const fetched = await store.get("msg_1");
    expect(fetched?.state).toBe("DELIVERING");
    expect(fetched?.attempt).toBe(2);
  });

  it("setState rejects for an unknown message id", async () => {
    await expect(store.setState("nope", "SETTLED")).rejects.toThrow();
  });

  it("depth and pendingTargets are correct with a mix of states", async () => {
    await store.push(makeMessage({ id: "msg_1", targetInstanceId: "inst_1", state: "QUEUED" }));
    await store.push(makeMessage({ id: "msg_2", targetInstanceId: "inst_1", state: "DELIVERING" }));
    await store.push(makeMessage({ id: "msg_3", targetInstanceId: "inst_1", state: "SETTLED" }));
    await store.push(makeMessage({ id: "msg_4", targetInstanceId: "inst_2", state: "DELIVERED" }));
    await store.push(makeMessage({ id: "msg_5", targetInstanceId: "inst_3", state: "FAILED" }));

    expect(await store.depth("inst_1")).toBe(2);
    expect(await store.depth("inst_2")).toBe(1);
    expect(await store.depth("inst_3")).toBe(0);

    const pending = await store.pendingTargets();
    expect(pending.sort()).toEqual(["inst_1", "inst_2"]);
  });

  it("remove deletes a message", async () => {
    await store.push(makeMessage({ id: "msg_1" }));
    await store.remove("msg_1");
    expect(await store.get("msg_1")).toBeUndefined();
  });

  it("listForTask returns messages ordered by seq", async () => {
    await store.push(makeMessage({ id: "msg_1", taskId: "task_a" }));
    await store.push(makeMessage({ id: "msg_2", taskId: "task_a" }));
    await store.push(makeMessage({ id: "msg_3", taskId: "task_b" }));

    const forTaskA = await store.listForTask("task_a");
    expect(forTaskA.map((m) => m.id)).toEqual(["msg_1", "msg_2"]);
  });
});
