import { beforeEach, describe, expect, it } from "vitest";

import { ERROR_CODES } from "../../../src/core/errors.js";
import type { AgentIdentity, DelegatedTask } from "../../../src/core/model.js";
import type { Clock } from "../../../src/core/ports.js";
import { openDatabase } from "../../../src/persistence/db.js";
import { SqliteTaskStore } from "../../../src/persistence/repositories/task-store.js";

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

const caller: AgentIdentity = { role: "human", name: "cc" };
const target: AgentIdentity = { role: "peer-agent", name: "codex", ref: "a81f", runtimeKind: "codex" };

function makeTask(overrides: Partial<DelegatedTask> = {}): DelegatedTask {
  return {
    id: "task_1",
    contextId: "ctx_1",
    caller,
    target,
    liveInstanceId: "inst_1",
    state: "submitted",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("SqliteTaskStore", () => {
  let clock: ReturnType<typeof createFakeClock>;
  let store: SqliteTaskStore;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    clock = createFakeClock();
    store = new SqliteTaskStore(db, clock);
  });

  it("round-trips create/get including JSON columns", async () => {
    const task = makeTask();
    await store.create(task);

    const fetched = await store.get("task_1");
    expect(fetched).toEqual(task);
  });

  it("round-trips result and error objects through update", async () => {
    await store.create(makeTask());

    clock.set("2024-01-01T00:05:00.000Z");
    const updated = await store.update("task_1", {
      state: "completed",
      result: { text: "done", source: "agent-output" },
    });

    expect(updated.state).toBe("completed");
    expect(updated.result).toEqual({ text: "done", source: "agent-output" });
    expect(updated.updatedAt).toBe("2024-01-01T00:05:00.000Z");

    const fetched = await store.get("task_1");
    expect(fetched?.result).toEqual({ text: "done", source: "agent-output" });

    clock.set("2024-01-01T00:06:00.000Z");
    const failed = await store.update("task_1", {
      state: "failed",
      error: { code: ERROR_CODES.TASK_FAILED, message: "boom", retryable: false },
    });
    expect(failed.error).toEqual({ code: ERROR_CODES.TASK_FAILED, message: "boom", retryable: false });

    const refetched = await store.get("task_1");
    expect(refetched?.error).toEqual({ code: ERROR_CODES.TASK_FAILED, message: "boom", retryable: false });
  });

  it("throws TASK_NOT_FOUND when updating a missing task", async () => {
    await expect(store.update("nope", { state: "completed" })).rejects.toMatchObject({
      code: ERROR_CODES.TASK_NOT_FOUND,
    });
  });

  it("returns undefined from get() for a missing task", async () => {
    await expect(store.get("nope")).resolves.toBeUndefined();
  });

  it("listByContext and listByInstance filter correctly", async () => {
    await store.create(makeTask({ id: "task_1", contextId: "ctx_1", liveInstanceId: "inst_1" }));
    await store.create(makeTask({ id: "task_2", contextId: "ctx_1", liveInstanceId: "inst_2" }));
    await store.create(makeTask({ id: "task_3", contextId: "ctx_2", liveInstanceId: "inst_1" }));

    const byContext = await store.listByContext("ctx_1");
    expect(byContext.map((t) => t.id).sort()).toEqual(["task_1", "task_2"]);

    const byInstance = await store.listByInstance("inst_1");
    expect(byInstance.map((t) => t.id).sort()).toEqual(["task_1", "task_3"]);
  });

  it("listActive excludes completed/failed/canceled/rejected", async () => {
    await store.create(makeTask({ id: "task_submitted", state: "submitted" }));
    await store.create(makeTask({ id: "task_working", state: "working" }));
    await store.create(makeTask({ id: "task_input_required", state: "input-required" }));
    await store.create(makeTask({ id: "task_completed", state: "completed" }));
    await store.create(makeTask({ id: "task_failed", state: "failed" }));
    await store.create(makeTask({ id: "task_canceled", state: "canceled" }));
    await store.create(makeTask({ id: "task_rejected", state: "rejected" }));

    const active = await store.listActive();
    expect(active.map((t) => t.id).sort()).toEqual(
      ["task_input_required", "task_submitted", "task_working"].sort(),
    );
  });
});
