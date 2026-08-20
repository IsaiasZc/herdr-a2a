/**
 * Persistence package barrel. `createStores` is the entry point every other
 * package should use — it opens the database, runs migrations, and wires up
 * one instance of each repository.
 */

import type { Database } from "better-sqlite3";

import type { Clock } from "../core/ports.js";
import { openDatabase } from "./db.js";
import { SqliteCursorStore } from "./repositories/cursor-store.js";
import { SqliteLaunchabilityCache } from "./repositories/launchability-cache.js";
import { SqliteLiveAgentStore } from "./repositories/live-agent-store.js";
import { SqliteQueueStore } from "./repositories/queue-store.js";
import { SqliteTaskStore } from "./repositories/task-store.js";

export { openDatabase } from "./db.js";
export { migrate } from "./migrations/index.js";
export { SqliteTaskStore } from "./repositories/task-store.js";
export { SqliteLiveAgentStore } from "./repositories/live-agent-store.js";
export { SqliteQueueStore } from "./repositories/queue-store.js";
export { SqliteCursorStore } from "./repositories/cursor-store.js";
export {
  SqliteLaunchabilityCache,
  type LaunchabilityCache,
  type LaunchabilityRecord,
} from "./repositories/launchability-cache.js";

export interface Stores {
  db: Database;
  tasks: SqliteTaskStore;
  liveAgents: SqliteLiveAgentStore;
  queue: SqliteQueueStore;
  cursors: SqliteCursorStore;
  launchability: SqliteLaunchabilityCache;
  close(): void;
}

export function createStores(opts: { dbPath: string; clock: Clock }): Stores {
  const db = openDatabase(opts.dbPath);

  return {
    db,
    tasks: new SqliteTaskStore(db, opts.clock),
    liveAgents: new SqliteLiveAgentStore(db, opts.clock),
    queue: new SqliteQueueStore(db, opts.clock),
    cursors: new SqliteCursorStore(db, opts.clock),
    launchability: new SqliteLaunchabilityCache(db, opts.clock),
    close: () => db.close(),
  };
}
