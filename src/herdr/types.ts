/**
 * Herdr socket API types, transcribed from the installed schema
 * (protocol 20, schema_version 1). See docs/herdr-contract.md.
 *
 * These are hand-written rather than generated because the layer touches a
 * small, stable subset of the 91 methods. `scripts/capture-contract.mjs`
 * refreshes the fixtures that tests assert this file against.
 */

export const REQUIRED_PROTOCOL = 20;

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type SplitDirection = "right" | "down";

/** Socket spelling. The CLI spells the third one `recent-unwrapped`. */
export type ReadSource = "visible" | "recent" | "recent_unwrapped" | "detection";

export type ReadFormat = "text" | "ansi";

export interface AgentSessionInfo {
  source: string;
  agent: string;
  kind: "id" | "path";
  value: string;
}

/** Result of `agent.get`, `agent.start`, `agent.prompt`, `agent.wait`. */
export interface AgentInfo {
  terminal_id: string;
  agent_status: AgentStatus;
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  focused: boolean;
  revision: number;

  agent?: string | null;
  display_agent?: string | null;
  name?: string | null;
  title?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  agent_session?: AgentSessionInfo | null;

  /** Authoritative readiness for interactive input. */
  interactive_ready?: boolean;
  /** True while a start is still settling. Never deliver into this. */
  launch_pending?: boolean;
  /** Monotonic lifecycle counter; the turn-start primitive. */
  state_change_seq?: number;
  /** True when a direct integration owns state instead of screen detection. */
  screen_detection_skipped?: boolean;
  state_labels?: Record<string, string>;
  tokens?: Record<string, string>;
}

export interface PaneScrollInfo {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
}

export interface PaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent_status: AgentStatus;
  revision: number;

  agent?: string | null;
  display_agent?: string | null;
  label?: string | null;
  title?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  agent_session?: AgentSessionInfo | null;
  scroll?: PaneScrollInfo | null;
  state_labels?: Record<string, string>;
}

export interface TabInfo {
  tab_id: string;
  workspace_id: string;
  number: number;
  label?: string | null;
  focused: boolean;
  pane_count: number;
  agent_status?: AgentStatus;
}

export interface WorkspaceInfo {
  workspace_id: string;
  number: number;
  label?: string | null;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id?: string;
  agent_status?: AgentStatus;
}

export interface PaneLayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PaneLayoutPane {
  pane_id: string;
  focused: boolean;
  rect: PaneLayoutRect;
}

export interface PaneLayoutSplit {
  direction: SplitDirection;
  ratio: number;
  rect?: PaneLayoutRect;
}

export interface PaneLayoutSnapshot {
  workspace_id: string;
  tab_id: string;
  zoomed: boolean;
  area: PaneLayoutRect;
  focused_pane_id: string;
  panes: PaneLayoutPane[];
  splits: PaneLayoutSplit[];
}

export interface SessionSnapshot {
  version: string;
  protocol: number;
  focused_workspace_id: string;
  focused_tab_id: string;
  focused_pane_id: string;
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  layouts: PaneLayoutSnapshot[];
  agents: AgentInfo[];
}

/** One entry of `server.agent_manifests`. */
export interface AgentManifestEntry {
  agent: string;
  source: string;
  source_kind: string;
  active_version?: string | null;
  cached_remote_version?: string | null;
  local_override_shadowing_remote?: boolean;
  remote_update_result?: string | null;
  remote_last_checked_unix?: number | null;
}

export interface AgentManifestStatus {
  last_check_unix?: number | null;
  last_result?: string | null;
  manifests: AgentManifestEntry[];
}

export interface PongResult {
  version: string;
  protocol: number;
  capabilities: Record<string, boolean>;
}

/**
 * `pane.process_info` result. The available-shell test that `agent.start`
 * requires is exactly `foreground_process_group_id === shell_pid`: the shell
 * itself is in the foreground with no foreground command, editor or agent.
 */
export interface PaneProcessInfo {
  pane_id: string;
  shell_pid: number;
  foreground_process_group_id: number;
  foreground_processes: { pid: number; name: string; argv: string[]; cmdline: string; cwd?: string }[];
}

export interface PaneReadResult {
  pane_id: string;
  source: ReadSource;
  text?: string;
  lines?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Request params
// ---------------------------------------------------------------------------

export interface AgentStartParams {
  name: string;
  kind: string;
  pane_id: string;
  args?: string[];
  /** Must be > 3000 and <= 300000. */
  timeout_ms?: number;
}

export interface AgentPromptWaitOptions {
  until?: AgentStatus[];
  timeout_ms?: number;
}

export interface AgentPromptParams {
  target: string;
  text: string;
  wait?: AgentPromptWaitOptions | null;
}

export interface AgentWaitParams {
  target: string;
  until?: AgentStatus[];
  timeout_ms?: number;
}

export interface AgentReadParams {
  target: string;
  source: ReadSource;
  lines?: number;
  format?: ReadFormat;
  strip_ansi?: boolean;
}

export interface PaneSplitParams {
  direction: SplitDirection;
  target_pane_id?: string | null;
  workspace_id?: string | null;
  cwd?: string | null;
  env?: Record<string, string>;
  focus?: boolean;
  ratio?: number | null;
}

export interface TabCreateParams {
  workspace_id?: string | null;
  cwd?: string | null;
  env?: Record<string, string>;
  label?: string | null;
  focus?: boolean;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type SubscriptionKind =
  | "workspace.created"
  | "workspace.updated"
  | "workspace.metadata_updated"
  | "workspace.renamed"
  | "workspace.moved"
  | "workspace.reordered"
  | "workspace.closed"
  | "workspace.focused"
  | "worktree.created"
  | "worktree.opened"
  | "worktree.removed"
  | "tab.created"
  | "tab.closed"
  | "tab.focused"
  | "tab.renamed"
  | "tab.moved"
  | "pane.created"
  | "pane.closed"
  | "pane.updated"
  | "pane.focused"
  | "pane.moved"
  | "pane.exited"
  | "pane.agent_detected"
  | "pane.output_matched"
  | "pane.agent_status_changed"
  | "pane.scroll_changed"
  | "layout.updated";

export type Subscription =
  | { type: Exclude<SubscriptionKind, "pane.agent_status_changed" | "pane.output_matched" | "pane.scroll_changed"> }
  /**
   * `pane_id` is REQUIRED — verified against 0.8.0, which rejects a filterless
   * subscription with `missing field pane_id`. There is therefore no global
   * agent-status feed; `pane.updated` is the only session-wide status signal.
   */
  | { type: "pane.agent_status_changed"; pane_id: string; agent_status?: AgentStatus | null }
  | { type: "pane.scroll_changed"; pane_id: string }
  | {
      type: "pane.output_matched";
      pane_id: string;
      source: ReadSource;
      match: unknown;
      lines?: number | null;
      strip_ansi?: boolean;
    };

/**
 * Payload of a `pane.agent_status_changed` event. Note what is ABSENT:
 * `state_change_seq`, `interactive_ready` and `launch_pending`. The event says
 * *that* status changed, not enough to decide deliverability or prove a turn —
 * an `agent.get` is still required for that.
 */
export interface PaneAgentStatusChanged {
  pane_id: string;
  workspace_id: string;
  agent_status: AgentStatus;
  agent?: string | null;
  display_agent?: string | null;
  title?: string | null;
  state_labels?: Record<string, string>;
}

/**
 * An unsolicited frame on the subscription connection.
 *
 * Note: `events.subscribe` backfills current state for every matching resource
 * before streaming live changes. The first frame per resource is a baseline,
 * not a transition.
 */
export interface HerdrEventFrame {
  event: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface HerdrRequestFrame {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface HerdrErrorBody {
  code: string;
  message: string;
}

export type HerdrResponseFrame =
  | { id: string; result: Record<string, unknown> & { type: string } }
  | { id: string; error: HerdrErrorBody };
