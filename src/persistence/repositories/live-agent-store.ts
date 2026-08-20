/**
 * `LiveAgentStore` (src/core/ports.ts) backed by the `live_agents` table.
 */

import type { Database } from "better-sqlite3";

import type { LiveAgent } from "../../core/model.js";
import type { Clock, LiveAgentStore } from "../../core/ports.js";

interface LiveAgentRow {
  instance_id: string;
  logical_target: string;
  runtime_kind: string;
  herdr_agent_name: string;
  pane_id: string;
  terminal_id: string | null;
  session_ref: string | null;
  workspace_id: string | null;
  tab_id: string | null;
  cwd: string;
  visibility: string;
  model: string | null;
  created_at: string;
}

function rowToLiveAgent(row: LiveAgentRow): LiveAgent {
  return {
    instanceId: row.instance_id,
    logicalTarget: row.logical_target,
    runtimeKind: row.runtime_kind,
    herdrAgentName: row.herdr_agent_name,
    paneId: row.pane_id,
    ...(row.terminal_id != null ? { terminalId: row.terminal_id } : {}),
    ...(row.session_ref != null ? { sessionRef: row.session_ref } : {}),
    ...(row.workspace_id != null ? { workspaceId: row.workspace_id } : {}),
    ...(row.tab_id != null ? { tabId: row.tab_id } : {}),
    cwd: row.cwd,
    visibility: row.visibility as LiveAgent["visibility"],
    ...(row.model != null ? { model: row.model } : {}),
    createdAt: row.created_at,
  };
}

export class SqliteLiveAgentStore implements LiveAgentStore {
  constructor(
    private readonly db: Database,
    /** Unused here — kept for constructor-shape consistency across stores. */
    private readonly clock: Clock,
  ) {}

  put(agent: LiveAgent): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO live_agents (
          instance_id, logical_target, runtime_kind, herdr_agent_name, pane_id,
          terminal_id, session_ref, workspace_id, tab_id, cwd, visibility, model,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (instance_id) DO UPDATE SET
          logical_target = excluded.logical_target,
          runtime_kind = excluded.runtime_kind,
          herdr_agent_name = excluded.herdr_agent_name,
          pane_id = excluded.pane_id,
          terminal_id = excluded.terminal_id,
          session_ref = excluded.session_ref,
          workspace_id = excluded.workspace_id,
          tab_id = excluded.tab_id,
          cwd = excluded.cwd,
          visibility = excluded.visibility,
          model = excluded.model`,
      )
      .run(
        agent.instanceId,
        agent.logicalTarget,
        agent.runtimeKind,
        agent.herdrAgentName,
        agent.paneId,
        agent.terminalId ?? null,
        agent.sessionRef ?? null,
        agent.workspaceId ?? null,
        agent.tabId ?? null,
        agent.cwd,
        agent.visibility,
        agent.model ?? null,
        agent.createdAt,
      );
    return Promise.resolve();
  }

  get(instanceId: string): Promise<LiveAgent | undefined> {
    const row = this.db
      .prepare<[string], LiveAgentRow>("SELECT * FROM live_agents WHERE instance_id = ?")
      .get(instanceId);
    return Promise.resolve(row ? rowToLiveAgent(row) : undefined);
  }

  byLogicalTarget(target: string): Promise<LiveAgent[]> {
    const rows = this.db
      .prepare<[string], LiveAgentRow>(
        "SELECT * FROM live_agents WHERE logical_target = ? ORDER BY created_at ASC",
      )
      .all(target);
    return Promise.resolve(rows.map(rowToLiveAgent));
  }

  all(): Promise<LiveAgent[]> {
    const rows = this.db.prepare<[], LiveAgentRow>("SELECT * FROM live_agents ORDER BY created_at ASC").all();
    return Promise.resolve(rows.map(rowToLiveAgent));
  }

  delete(instanceId: string): Promise<void> {
    this.db.prepare("DELETE FROM live_agents WHERE instance_id = ?").run(instanceId);
    return Promise.resolve();
  }
}
