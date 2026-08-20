/**
 * Migration 1 — full schema (spec §47, adapted).
 *
 * Deviations from the spec's suggested SQL, and why:
 *
 * - `tasks` gains a `question` column (`DelegatedTask.question`) and a
 *   `last_relay_message_id` column (`DelegatedTask.lastRelayMessageId`) — both
 *   are real fields on the frozen `DelegatedTask` model that the spec's
 *   sketch omitted. Without them `TaskStore.update`/`get` cannot round-trip
 *   the model.
 * - `relay_messages` splits the spec's single `sender_json` into `from_json`
 *   and `to_json` — `RelayMessage` has both `from` and `to` (`AgentIdentity`),
 *   and the recipient identity is needed to reconstruct the row.
 * - `relay_messages.seq` is the real primary key
 *   (`INTEGER PRIMARY KEY AUTOINCREMENT`, i.e. SQLite's rowid alias), with
 *   `id` demoted to a `UNIQUE NOT NULL` secondary key. SQLite only allows one
 *   PRIMARY KEY per table and `AUTOINCREMENT` is only legal on an
 *   `INTEGER PRIMARY KEY`, so a monotonic, never-reused sequence number and a
 *   caller-supplied text id can't both be the primary key. FIFO ordering
 *   requires the former: two messages pushed within the same millisecond
 *   must still order deterministically, and `created_at` alone can't do that.
 * - `live_agents` gains `terminal_id`, `workspace_id`, `tab_id`, `visibility`,
 *   `model` columns beyond the spec's sketch, again to round-trip the full
 *   `LiveAgent` model.
 * - A `launchability` table is added; it isn't in the spec's list but is
 *   required by the brief for the catalog package's TTL cache.
 */

import type { Database } from "better-sqlite3";

export function migration001(db: Database): void {
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      context_id TEXT,
      caller_json TEXT NOT NULL,
      target_json TEXT NOT NULL,
      live_instance_id TEXT,
      state TEXT NOT NULL,
      question TEXT,
      result_json TEXT,
      error_json TEXT,
      last_relay_message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_tasks_context_id ON tasks (context_id);
    CREATE INDEX idx_tasks_live_instance_id ON tasks (live_instance_id);
    CREATE INDEX idx_tasks_state ON tasks (state);

    CREATE TABLE live_agents (
      instance_id TEXT PRIMARY KEY,
      logical_target TEXT NOT NULL,
      runtime_kind TEXT NOT NULL,
      herdr_agent_name TEXT NOT NULL,
      pane_id TEXT NOT NULL,
      terminal_id TEXT,
      session_ref TEXT,
      workspace_id TEXT,
      tab_id TEXT,
      cwd TEXT NOT NULL,
      visibility TEXT NOT NULL,
      model TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_live_agents_logical_target ON live_agents (logical_target);

    CREATE TABLE relay_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      target_instance_id TEXT NOT NULL,
      from_json TEXT NOT NULL,
      to_json TEXT NOT NULL,
      body TEXT NOT NULL,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_relay_messages_target_state_seq
      ON relay_messages (target_instance_id, state, seq);
    CREATE INDEX idx_relay_messages_task_id ON relay_messages (task_id);

    CREATE TABLE layout_cursor (
      tab_id TEXT PRIMARY KEY,
      anchor_pane_id TEXT NOT NULL,
      next_direction TEXT NOT NULL
    );

    CREATE TABLE launchability (
      kind TEXT PRIMARY KEY,
      launchable TEXT NOT NULL,
      reason TEXT NOT NULL,
      executable_path TEXT,
      checked_at TEXT NOT NULL
    );
  `);
}
