/**
 * SQLite connection management (spec §47). `better-sqlite3` is synchronous;
 * every repository wraps its calls in `Promise.resolve(...)` to match the
 * async port signatures in `src/core/ports.ts`.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { migrate } from "./migrations/index.js";

export type { Database as DatabaseHandle } from "better-sqlite3";

/**
 * Opens (creating if needed) the SQLite file at `path`, applies pragmas, and
 * runs pending migrations. Pass `":memory:"` for an ephemeral test database.
 */
export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  }

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  migrate(db);

  return db;
}
