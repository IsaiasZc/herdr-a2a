/**
 * Forward-only migration runner keyed off `PRAGMA user_version`. Each
 * migration is a plain function; `migrate()` applies every migration whose
 * index is greater than the current `user_version`, inside one transaction,
 * and leaves `user_version` at the highest applied index. Calling `migrate()`
 * again when already at the latest version is a no-op.
 */

import type { Database } from "better-sqlite3";

import { migration001 } from "./001-initial-schema.js";

/** Ordered 1-indexed; `migrations[0]` is version 1. */
const migrations: readonly ((db: Database) => void)[] = [migration001];

export function migrate(db: Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;

  if (current >= migrations.length) return;

  const run = db.transaction(() => {
    for (let version = current + 1; version <= migrations.length; version++) {
      const step = migrations[version - 1];
      if (!step) continue;
      step(db);
      db.pragma(`user_version = ${version}`);
    }
  });

  run();
}
