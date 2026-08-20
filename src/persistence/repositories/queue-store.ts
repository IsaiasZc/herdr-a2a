/**
 * `QueueStore` (src/core/ports.ts) backed by the `relay_messages` table.
 *
 * FIFO ordering comes from the monotonic `seq` column (SQLite rowid alias,
 * `INTEGER PRIMARY KEY AUTOINCREMENT`), never from `created_at` — two
 * messages pushed within the same clock tick must still order deterministically.
 */

import type { Database } from "better-sqlite3";

import type { AgentIdentity, RelayMessage, RelayState } from "../../core/model.js";
import { ERROR_CODES, fail } from "../../core/errors.js";
import type { Clock, QueueStore } from "../../core/ports.js";

/** States `peek`/`pendingTargets`/`depth` treat as "still in flight" (spec §11). */
const NON_TERMINAL_STATES: readonly RelayState[] = ["QUEUED", "DELIVERING", "DELIVERED"];

interface RelayMessageRow {
  seq: number;
  id: string;
  task_id: string;
  target_instance_id: string;
  from_json: string;
  to_json: string;
  body: string;
  state: string;
  attempt: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToMessage(row: RelayMessageRow): RelayMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    targetInstanceId: row.target_instance_id,
    from: JSON.parse(row.from_json) as AgentIdentity,
    to: JSON.parse(row.to_json) as AgentIdentity,
    body: row.body,
    state: row.state as RelayState,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at != null ? { expiresAt: row.expires_at } : {}),
  };
}

export class SqliteQueueStore implements QueueStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  push(message: RelayMessage): Promise<number> {
    this.db
      .prepare(
        `INSERT INTO relay_messages (
          id, task_id, target_instance_id, from_json, to_json, body, state,
          attempt, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.taskId,
        message.targetInstanceId,
        JSON.stringify(message.from),
        JSON.stringify(message.to),
        message.body,
        message.state,
        message.attempt,
        message.expiresAt ?? null,
        message.createdAt,
        message.updatedAt,
      );
    return this.depth(message.targetInstanceId);
  }

  peek(targetInstanceId: string): Promise<RelayMessage | undefined> {
    const placeholders = NON_TERMINAL_STATES.map(() => "?").join(", ");
    const row = this.db
      .prepare<
        [string, ...string[]],
        RelayMessageRow
      >(
        `SELECT * FROM relay_messages
         WHERE target_instance_id = ? AND state IN (${placeholders})
         ORDER BY seq ASC LIMIT 1`,
      )
      .get(targetInstanceId, ...NON_TERMINAL_STATES);
    return Promise.resolve(row ? rowToMessage(row) : undefined);
  }

  get(messageId: string): Promise<RelayMessage | undefined> {
    const row = this.db
      .prepare<[string], RelayMessageRow>("SELECT * FROM relay_messages WHERE id = ?")
      .get(messageId);
    return Promise.resolve(row ? rowToMessage(row) : undefined);
  }

  // async so a missing-message throw becomes a rejected Promise, not a
  // synchronous throw at the call site (the interface promises the latter).
  async setState(messageId: string, state: RelayState, attempt?: number): Promise<RelayMessage> {
    const row = this.db
      .prepare<[string], RelayMessageRow>("SELECT * FROM relay_messages WHERE id = ?")
      .get(messageId);
    // No error code in errors.ts targets "relay message not found" specifically
    // (unlike TASK_NOT_FOUND for tasks); DELIVERY_FAILED is the closest fit.
    if (!row) throw fail(ERROR_CODES.DELIVERY_FAILED, `No relay message with id ${messageId}`, { messageId });

    const updatedAt = this.clock.nowIso();
    const nextAttempt = attempt ?? row.attempt;
    this.db
      .prepare("UPDATE relay_messages SET state = ?, attempt = ?, updated_at = ? WHERE id = ?")
      .run(state, nextAttempt, updatedAt, messageId);

    return Promise.resolve(rowToMessage({ ...row, state, attempt: nextAttempt, updated_at: updatedAt }));
  }

  remove(messageId: string): Promise<void> {
    this.db.prepare("DELETE FROM relay_messages WHERE id = ?").run(messageId);
    return Promise.resolve();
  }

  pendingTargets(): Promise<string[]> {
    const placeholders = NON_TERMINAL_STATES.map(() => "?").join(", ");
    const rows = this.db
      .prepare<
        string[],
        { target_instance_id: string }
      >(
        `SELECT DISTINCT target_instance_id FROM relay_messages WHERE state IN (${placeholders})`,
      )
      .all(...NON_TERMINAL_STATES);
    return Promise.resolve(rows.map((r) => r.target_instance_id));
  }

  depth(targetInstanceId: string): Promise<number> {
    const placeholders = NON_TERMINAL_STATES.map(() => "?").join(", ");
    const row = this.db
      .prepare<
        [string, ...string[]],
        { count: number }
      >(
        `SELECT COUNT(*) AS count FROM relay_messages
         WHERE target_instance_id = ? AND state IN (${placeholders})`,
      )
      .get(targetInstanceId, ...NON_TERMINAL_STATES);
    return Promise.resolve(row?.count ?? 0);
  }

  listForTask(taskId: string): Promise<RelayMessage[]> {
    const rows = this.db
      .prepare<[string], RelayMessageRow>("SELECT * FROM relay_messages WHERE task_id = ? ORDER BY seq ASC")
      .all(taskId);
    return Promise.resolve(rows.map(rowToMessage));
  }
}
