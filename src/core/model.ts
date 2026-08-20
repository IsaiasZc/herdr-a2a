/**
 * Domain model. Frozen contract shared by every module — the A2A gateway, the
 * catalog, the relay, the spawn manager and persistence all speak these types
 * and nothing HTTP- or socket-shaped.
 */

import type { AgentStatus } from "../herdr/types.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export type IdentityRole = "human" | "peer-agent" | "system";

/** Who a message is from or to. Sender attribution is mandatory (spec §10). */
export interface AgentIdentity {
  /** `human`, `peer-agent`, or `system` — never inferred, always explicit. */
  role: IdentityRole;
  /** Logical agent/profile name, e.g. `codex` or `reviewer`. */
  name: string;
  /** Short stable discriminator for a specific live participant, e.g. `a81f`. */
  ref?: string;
  /** Runtime kind behind the name, when known. */
  runtimeKind?: string;
}

export function formatIdentity(id: AgentIdentity): string {
  return id.ref ? `${id.name}:${id.ref}` : id.name;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type Launchable = "yes" | "no" | "unknown";

export type DiscoverySource =
  | "herdr-cli-kinds"
  | "herdr-manifests"
  | "herdr-integrations"
  | "herdr-session"
  | "custom-registry";

/**
 * A base runtime as the installed Herdr describes it. The four facts stay
 * separate on purpose (spec §5.1) — collapsing them into one boolean loses the
 * distinction between "Herdr accepts this kind", "a detection manifest exists",
 * "the executable is on PATH" and "an instance is running".
 */
export interface RuntimeDescriptor {
  kind: string;
  supportedByHerdr: boolean;
  hasDetectionManifest: boolean;
  hasIntegration: boolean;
  launchable: Launchable;
  runningInstances: number;
  /** Every live source that contributed to this record. */
  sources: DiscoverySource[];
  manifestVersion?: string;
  executablePath?: string;
  /** Why launchability resolved the way it did — surfaced by `doctor`. */
  launchableReason?: string;
}

export interface CustomAgentProfile {
  name: string;
  runtime: string;
  model?: string;
  visibility?: Visibility;
  instructions?: string;
  args?: string[];
}

export type AgentDescriptorKind = "runtime" | "custom";

/** What `discover()` and the Agent Card generator consume. */
export interface AgentDescriptor {
  /** Endpoint-safe logical name: the runtime kind, or the custom profile name. */
  name: string;
  descriptorKind: AgentDescriptorKind;
  /** Runtime kind that will actually be started. Equals `name` for runtimes. */
  runtimeKind: string;
  available: boolean;
  unavailableReason?: string;
  runtime: RuntimeDescriptor;
  profile?: CustomAgentProfile;
  description: string;
}

// ---------------------------------------------------------------------------
// Live instances
// ---------------------------------------------------------------------------

export type Visibility = "visible" | "headless";

/**
 * A running worker. `instanceId` is ours and immutable; everything Herdr-owned
 * (pane, terminal, name) can change underneath us, which is why delivery
 * re-verifies identity against `sessionRef`/`terminalId` first (spec §40).
 */
export interface LiveAgent {
  instanceId: string;
  logicalTarget: string;
  runtimeKind: string;
  herdrAgentName: string;
  paneId: string;
  terminalId?: string;
  /** `agent_session.value` — durable identity across pane churn. */
  sessionRef?: string;
  workspaceId?: string;
  tabId?: string;
  cwd: string;
  visibility: Visibility;
  model?: string;
  createdAt: string;
}

/** Deliverability evidence, read straight off `AgentInfo`. */
export interface AgentSnapshot {
  paneId: string;
  terminalId: string;
  agent?: string | null;
  status: AgentStatus;
  interactiveReady: boolean;
  launchPending: boolean;
  stateChangeSeq: number;
  revision: number;
  sessionRef?: string;
  screenDetectionSkipped: boolean;
  stateLabels: Record<string, string>;
  observedAt: string;
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

/**
 * Delivery is staged rather than boolean (spec §11). `DELIVERED` means the
 * terminal accepted text; `TURN_STARTED` means the agent demonstrably began a
 * turn. Those are not the same event and conflating them is the bug this whole
 * layer exists to avoid.
 */
export type RelayState =
  | "QUEUED"
  | "DELIVERING"
  | "DELIVERED"
  | "TURN_STARTED"
  | "SETTLED"
  | "EXPIRED"
  | "FAILED";

export interface RelayMessage {
  id: string;
  taskId: string;
  targetInstanceId: string;

  from: AgentIdentity;
  to: AgentIdentity;

  body: string;

  state: RelayState;
  attempt: number;

  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface RelayReceipt {
  messageId: string;
  state: RelayState;
  queuePosition: number;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** A2A v1.0 task states. */
export type PublicTaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "auth-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";

export const TERMINAL_TASK_STATES: ReadonlySet<PublicTaskState> = new Set<PublicTaskState>([
  "completed",
  "failed",
  "canceled",
  "rejected",
]);

export type ResultSource =
  | "integration"
  | "agent-output"
  | "terminal-read"
  | "adapter"
  | "file-handoff";

export interface TaskResult {
  text: string;
  source: ResultSource;
  /** True when the text is a bounded terminal read rather than a real result. */
  truncated?: boolean;
  artifactName?: string;
}

export interface DelegatedTask {
  id: string;
  contextId?: string;

  caller: AgentIdentity;
  target: AgentIdentity;
  liveInstanceId?: string;

  state: PublicTaskState;

  createdAt: string;
  updatedAt: string;

  lastRelayMessageId?: string;
  /** Set when state is `input-required` / `auth-required`. */
  question?: string;
  result?: TaskResult;
  error?: import("./errors.js").DelegationError;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * The internal shape every entry point (A2A executor, CLI, tests) funnels
 * into. Core code must not depend on HTTP/JSON-RPC details (spec §45).
 */
export interface DelegateRequest {
  agentName: string;
  message: string;

  /**
   * Adopt a caller-supplied task id instead of minting one. The A2A gateway
   * uses this so the id the protocol assigned is the id we persist — otherwise
   * every lookup would need a translation table.
   */
  taskId?: string;

  caller?: AgentIdentity;
  cwd?: string;

  model?: string;
  visibility?: Visibility;
  /** A2A contextId, so a continuation lands on the same worker. */
  contextId?: string;

  metadata?: Record<string, unknown>;
}

export interface SpawnRequest {
  descriptor: AgentDescriptor;
  cwd: string;
  visibility: Visibility;
  model?: string;
  callerPaneId?: string;
  callerTabId?: string;
  callerWorkspaceId?: string;
  args?: string[];
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface LayoutCursor {
  tabId: string;
  anchorPaneId: string;
  nextDirection: "right" | "down";
}

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

/**
 * Why an agent is `blocked`. `permission`, `auth` and `trust` must never be
 * answered automatically (spec §29) — they surface as A2A states instead.
 */
export type BlockerKind = "question" | "permission" | "auth" | "trust" | "unknown";

export interface Blocker {
  kind: BlockerKind;
  /** Verbatim prompt text shown to the caller. */
  text?: string;
}
