import { describe, expect, it } from "vitest";

import { openDatabase } from "../../../src/persistence/db.js";
import { migrate } from "../../../src/persistence/migrations/index.js";

describe("openDatabase / migrate", () => {
  it("opens an in-memory database and creates the full schema", () => {
    const db = openDatabase(":memory:");
    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);

    expect(tables).toEqual(
      expect.arrayContaining([
        "tasks",
        "live_agents",
        "relay_messages",
        "layout_cursor",
        "launchability",
      ]),
    );
    db.close();
  });

  it("sets foreign_keys and busy_timeout pragmas", () => {
    const db = openDatabase(":memory:");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    db.close();
  });

  it("bumps user_version to the latest migration", () => {
    const db = openDatabase(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    db.close();
  });

  it("is idempotent — calling migrate again is a no-op", () => {
    const db = openDatabase(":memory:");
    const before = db.pragma("user_version", { simple: true });

    // Insert a row so we can prove the schema (and data) survive a second call.
    db.prepare(
      `INSERT INTO tasks (id, caller_json, target_json, state, created_at, updated_at)
       VALUES ('task_1', '{}', '{}', 'submitted', 'now', 'now')`,
    ).run();

    expect(() => migrate(db)).not.toThrow();

    const after = db.pragma("user_version", { simple: true });
    expect(after).toBe(before);

    const row = db.prepare("SELECT id FROM tasks WHERE id = 'task_1'").get();
    expect(row).toBeDefined();

    db.close();
  });
});
