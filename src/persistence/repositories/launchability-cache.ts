/**
 * TTL-backed cache for `LaunchabilityResolver` (src/core/ports.ts), consumed
 * by the catalog package. Not itself a port interface — `ports.ts` only
 * defines the resolver contract, not its persistence — so the interface is
 * defined and exported here per the persistence package's own brief.
 *
 * The TTL is enforced by the reader (the catalog package, comparing
 * `checkedAt` against its configured `launchabilityTtlMs`), not by this
 * table: SQLite has no notion of row expiry, and baking a TTL into the
 * schema would duplicate config that already lives in `AppConfig.herdr`.
 */

import type { Database } from "better-sqlite3";

import type { Launchable } from "../../core/model.js";
import type { Clock } from "../../core/ports.js";

export interface LaunchabilityRecord {
  launchable: Launchable;
  reason: string;
  executablePath?: string;
  checkedAt: string;
}

export interface LaunchabilityCache {
  get(kind: string): Promise<LaunchabilityRecord | undefined>;
  set(kind: string, record: LaunchabilityRecord): Promise<void>;
  invalidate(kind?: string): Promise<void>;
}

interface LaunchabilityRow {
  kind: string;
  launchable: string;
  reason: string;
  executable_path: string | null;
  checked_at: string;
}

function rowToRecord(row: LaunchabilityRow): LaunchabilityRecord {
  return {
    launchable: row.launchable as Launchable,
    reason: row.reason,
    ...(row.executable_path != null ? { executablePath: row.executable_path } : {}),
    checkedAt: row.checked_at,
  };
}

export class SqliteLaunchabilityCache implements LaunchabilityCache {
  constructor(
    private readonly db: Database,
    /** Unused here — kept for constructor-shape consistency across stores. */
    private readonly clock: Clock,
  ) {}

  get(kind: string): Promise<LaunchabilityRecord | undefined> {
    const row = this.db
      .prepare<[string], LaunchabilityRow>("SELECT * FROM launchability WHERE kind = ?")
      .get(kind);
    return Promise.resolve(row ? rowToRecord(row) : undefined);
  }

  set(kind: string, record: LaunchabilityRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO launchability (kind, launchable, reason, executable_path, checked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (kind) DO UPDATE SET
           launchable = excluded.launchable,
           reason = excluded.reason,
           executable_path = excluded.executable_path,
           checked_at = excluded.checked_at`,
      )
      .run(kind, record.launchable, record.reason, record.executablePath ?? null, record.checkedAt);
    return Promise.resolve();
  }

  invalidate(kind?: string): Promise<void> {
    if (kind === undefined) {
      this.db.prepare("DELETE FROM launchability").run();
    } else {
      this.db.prepare("DELETE FROM launchability WHERE kind = ?").run(kind);
    }
    return Promise.resolve();
  }
}
