/**
 * `TaskStore` (src/core/ports.ts) backed by the `tasks` table (spec §47).
 */

import type { Database } from "better-sqlite3";

import { ERROR_CODES, fail } from "../../core/errors.js";
import { TERMINAL_TASK_STATES, type DelegatedTask } from "../../core/model.js";
import type { Clock, TaskStore } from "../../core/ports.js";

interface TaskRow {
  id: string;
  context_id: string | null;
  caller_json: string;
  target_json: string;
  live_instance_id: string | null;
  state: string;
  question: string | null;
  result_json: string | null;
  error_json: string | null;
  last_relay_message_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): DelegatedTask {
  return {
    id: row.id,
    ...(row.context_id != null ? { contextId: row.context_id } : {}),
    caller: JSON.parse(row.caller_json),
    target: JSON.parse(row.target_json),
    ...(row.live_instance_id != null ? { liveInstanceId: row.live_instance_id } : {}),
    state: row.state as DelegatedTask["state"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_relay_message_id != null ? { lastRelayMessageId: row.last_relay_message_id } : {}),
    ...(row.question != null ? { question: row.question } : {}),
    ...(row.result_json != null ? { result: JSON.parse(row.result_json) } : {}),
    ...(row.error_json != null ? { error: JSON.parse(row.error_json) } : {}),
  };
}

export class SqliteTaskStore implements TaskStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  create(task: DelegatedTask): Promise<DelegatedTask> {
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, context_id, caller_json, target_json, live_instance_id, state,
          question, result_json, error_json, last_relay_message_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.contextId ?? null,
        JSON.stringify(task.caller),
        JSON.stringify(task.target),
        task.liveInstanceId ?? null,
        task.state,
        task.question ?? null,
        task.result ? JSON.stringify(task.result) : null,
        task.error ? JSON.stringify(task.error) : null,
        task.lastRelayMessageId ?? null,
        task.createdAt,
        task.updatedAt,
      );
    return Promise.resolve(task);
  }

  get(taskId: string): Promise<DelegatedTask | undefined> {
    const row = this.db.prepare<[string], TaskRow>("SELECT * FROM tasks WHERE id = ?").get(taskId);
    return Promise.resolve(row ? rowToTask(row) : undefined);
  }

  // async so a missing-task throw becomes a rejected Promise, not a
  // synchronous throw at the call site (the interface promises the latter).
  async update(taskId: string, patch: Partial<Omit<DelegatedTask, "id" | "createdAt">>): Promise<DelegatedTask> {
    const row = this.db.prepare<[string], TaskRow>("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!row) throw fail(ERROR_CODES.TASK_NOT_FOUND, `No task with id ${taskId}`, { taskId });

    const current = rowToTask(row);
    const merged: DelegatedTask = { ...current, ...patch, updatedAt: this.clock.nowIso() };

    this.db
      .prepare(
        `UPDATE tasks SET
          context_id = ?, caller_json = ?, target_json = ?, live_instance_id = ?,
          state = ?, question = ?, result_json = ?, error_json = ?,
          last_relay_message_id = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        merged.contextId ?? null,
        JSON.stringify(merged.caller),
        JSON.stringify(merged.target),
        merged.liveInstanceId ?? null,
        merged.state,
        merged.question ?? null,
        merged.result ? JSON.stringify(merged.result) : null,
        merged.error ? JSON.stringify(merged.error) : null,
        merged.lastRelayMessageId ?? null,
        merged.updatedAt,
        taskId,
      );

    return Promise.resolve(merged);
  }

  listByContext(contextId: string): Promise<DelegatedTask[]> {
    const rows = this.db
      .prepare<[string], TaskRow>("SELECT * FROM tasks WHERE context_id = ? ORDER BY created_at ASC")
      .all(contextId);
    return Promise.resolve(rows.map(rowToTask));
  }

  listByInstance(instanceId: string): Promise<DelegatedTask[]> {
    const rows = this.db
      .prepare<[string], TaskRow>("SELECT * FROM tasks WHERE live_instance_id = ? ORDER BY created_at ASC")
      .all(instanceId);
    return Promise.resolve(rows.map(rowToTask));
  }

  listActive(): Promise<DelegatedTask[]> {
    const placeholders = [...TERMINAL_TASK_STATES].map(() => "?").join(", ");
    const rows = this.db
      .prepare<
        string[],
        TaskRow
      >(`SELECT * FROM tasks WHERE state NOT IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...TERMINAL_TASK_STATES);
    return Promise.resolve(rows.map(rowToTask));
  }
}
