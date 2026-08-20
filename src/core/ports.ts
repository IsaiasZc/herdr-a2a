/**
 * Ports — the seams between modules. Implementations live in their own
 * directories and must not import each other directly; they meet here.
 */

import type {
  AgentDescriptor,
  AgentIdentity,
  AgentSnapshot,
  Blocker,
  DelegateRequest,
  DelegatedTask,
  LayoutCursor,
  LiveAgent,
  PublicTaskState,
  RelayMessage,
  RelayReceipt,
  RelayState,
  SpawnRequest,
  TaskResult,
  Visibility,
} from "./model.js";
import type {
  AgentInfo,
  AgentManifestStatus,
  AgentStatus,
  PaneInfo,
  PaneLayoutSnapshot,
  PaneProcessInfo,
  PaneSplitParams,
  PongResult,
  ReadSource,
  SessionSnapshot,
  Subscription,
  TabCreateParams,
  TabInfo,
} from "../herdr/types.js";

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
  nowIso(): string;
  sleep(ms: number): Promise<void>;
}

export interface IdGenerator {
  /** e.g. `task_1a2b3c`. */
  taskId(): string;
  /** e.g. `msg_1a2b3c`. */
  messageId(): string;
  /** e.g. `inst_1a2b3c`. */
  instanceId(): string;
  /** 4-char lowercase hex, for agent names and identity refs. */
  shortId(): string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** Structured domain events (spec §48). Names are `dot.separated`. */
export interface EventSink {
  emit(event: string, fields?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Herdr access
// ---------------------------------------------------------------------------

export interface HerdrEventHandler {
  (event: string, data: Record<string, unknown>): void;
}

export interface HerdrSubscription {
  close(): void;
}

/**
 * Typed facade over the Herdr socket. Everything above this line is Herdr-free.
 */
export interface HerdrClient {
  ping(): Promise<PongResult>;
  sessionSnapshot(): Promise<SessionSnapshot>;
  agentManifests(): Promise<AgentManifestStatus>;

  agentList(): Promise<AgentInfo[]>;
  agentGet(target: string): Promise<AgentInfo>;
  agentStart(params: {
    name: string;
    kind: string;
    paneId: string;
    args?: string[];
    timeoutMs?: number;
  }): Promise<{ agent: AgentInfo; argv: string[] }>;
  agentPrompt(params: {
    target: string;
    text: string;
    wait?: { until?: AgentStatus[]; timeoutMs?: number };
  }): Promise<AgentInfo>;
  agentWait(params: { target: string; until?: AgentStatus[]; timeoutMs?: number }): Promise<AgentInfo>;
  agentRead(params: {
    target: string;
    source: ReadSource;
    lines?: number;
    stripAnsi?: boolean;
  }): Promise<string>;
  agentSendKeys(target: string, keys: string[]): Promise<void>;

  paneSplit(params: PaneSplitParams): Promise<PaneInfo>;
  paneGet(paneId: string): Promise<PaneInfo>;
  paneList(params?: { workspaceId?: string }): Promise<PaneInfo[]>;
  paneClose(paneId: string): Promise<void>;
  paneLayout(params?: { paneId?: string; tabId?: string }): Promise<PaneLayoutSnapshot>;
  paneProcessInfo(paneId: string): Promise<PaneProcessInfo>;

  tabCreate(params: TabCreateParams): Promise<TabInfo>;

  subscribe(subscriptions: Subscription[], handler: HerdrEventHandler): Promise<HerdrSubscription>;

  close(): Promise<void>;
}

/** Live mirror of Herdr state, fed by snapshot + events (spec §41). */
export interface SessionCache {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): SessionSnapshot | undefined;
  agents(): AgentInfo[];
  agentByPane(paneId: string): AgentInfo | undefined;
  agentBySessionRef(sessionRef: string): AgentInfo | undefined;
  pane(paneId: string): PaneInfo | undefined;
  /** Fires after a reconnect + resnapshot, so queues can be re-verified. */
  onResync(handler: () => void): () => void;
  onAgentStatus(handler: (agent: AgentInfo) => void): () => void;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface AgentCatalog {
  refresh(): Promise<void>;
  list(): Promise<AgentDescriptor[]>;
  get(name: string): Promise<AgentDescriptor | undefined>;
}

/** Reads the three live kind sources described in docs/herdr-contract.md §6. */
export interface HerdrDiscovery {
  /** Kinds the installed binary accepts, parsed from its own usage text. */
  supportedKinds(): Promise<string[]>;
  /** Kinds with a loaded detection manifest. */
  manifests(): Promise<AgentManifestStatus>;
  /** Kinds with a built-in integration. */
  integrationKinds(): Promise<string[]>;
}

/** Deterministic PATH/preflight resolution with a TTL cache (spec §5, §36). */
export interface LaunchabilityResolver {
  resolve(kind: string): Promise<{ launchable: "yes" | "no" | "unknown"; reason: string; executablePath?: string }>;
  invalidate(kind?: string): void;
}

// ---------------------------------------------------------------------------
// Runtime adapters
// ---------------------------------------------------------------------------

export interface RuntimeContext {
  runtimeKind: string;
  model?: string;
  cwd: string;
  profileArgs?: string[];
}

export interface TaskContext {
  task: DelegatedTask;
  live: LiveAgent;
  herdr: HerdrClient;
  /** Snapshot captured just before the delegated turn began. */
  preTurn?: AgentSnapshot;
}

export interface RuntimeAdapter {
  kind: string;
  validateOptions?(ctx: RuntimeContext): Promise<void>;
  buildAgentArgs?(ctx: RuntimeContext): Promise<string[]>;
  classifyBlocker?(snapshot: AgentSnapshot, detectionText: string): Blocker | undefined;
  extractResult?(ctx: TaskContext): Promise<TaskResult | undefined>;
  formatPeerMessage?(message: RelayMessage): string;
}

export interface RuntimeAdapterRegistry {
  for(kind: string): RuntimeAdapter;
}

// ---------------------------------------------------------------------------
// Layout & spawn
// ---------------------------------------------------------------------------

export interface LayoutManager {
  /** Allocates an unfocused pane for a visible worker, or overflows to a tab. */
  allocateVisiblePane(req: {
    tabId: string;
    workspaceId: string;
    anchorPaneId: string;
    cwd: string;
  }): Promise<PaneInfo>;
  /** Background, never-focused pane for headless workers (spec §23). */
  allocateHeadlessPane(req: { cwd: string; workspaceId?: string }): Promise<PaneInfo>;
  releasePane(paneId: string): Promise<void>;
}

export interface CursorStore {
  get(tabId: string): Promise<LayoutCursor | undefined>;
  set(cursor: LayoutCursor): Promise<void>;
  delete(tabId: string): Promise<void>;
}

export interface SpawnManager {
  resolveOrSpawn(req: SpawnRequest): Promise<LiveAgent>;
  release(instanceId: string): Promise<void>;
}

export interface PreflightReport {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}

export interface Preflight {
  run(req: SpawnRequest): Promise<PreflightReport>;
}

export interface ReusePolicy {
  /** Picks a reusable live instance, or undefined to force a spawn (spec §25). */
  pick(req: SpawnRequest, candidates: LiveAgent[]): Promise<LiveAgent | undefined>;
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

/**
 * Transport seam (spec §9.1). `QueuedPromptTransport` is the MVP shim; a
 * `NativeHerdrSendTransport` can replace it without touching the task layer.
 */
export interface AgentTransport {
  enqueue(message: RelayMessage): Promise<RelayReceipt>;
  cancel(messageId: string): Promise<void>;
  /** Drops every pending message for a target, e.g. when it is lost. */
  cancelForTarget(targetInstanceId: string): Promise<void>;
}

export interface Relay extends AgentTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  onStateChange(handler: (message: RelayMessage) => void): () => void;
  /**
   * Fires when a turn is *proved* started, carrying the `state_change_seq`
   * observed immediately before the prompt. The task layer needs that baseline
   * to tell this turn's settle from the previous turn's, so it belongs on the
   * port rather than only on the MVP transport.
   */
  onTurnStarted(handler: (message: RelayMessage, preSeq: number) => void): () => void;
  /**
   * Fires when a queued message cannot be delivered because the target is
   * blocked. The blocker is classified, never answered (spec §29, §39).
   */
  onBlocked(handler: (message: RelayMessage, blocker: Blocker) => void): () => void;
  /**
   * Fires when a message will never be delivered. Without it the task layer
   * cannot learn that its delegation is dead, and the task sits at `submitted`
   * or `working` forever.
   */
  onFailed(handler: (message: RelayMessage, error: import("./errors.js").DelegationError) => void): () => void;
  /**
   * Event-driven nudge: a target's state changed, so the pump should re-check
   * it. Keeps delivery off a fixed polling interval (spec §53).
   */
  notifyTargetChanged(instanceId: string): void;
}

export interface QueueStore {
  push(message: RelayMessage): Promise<number>;
  /** Oldest non-terminal message for a target, or undefined. */
  peek(targetInstanceId: string): Promise<RelayMessage | undefined>;
  get(messageId: string): Promise<RelayMessage | undefined>;
  setState(messageId: string, state: RelayState, attempt?: number): Promise<RelayMessage>;
  remove(messageId: string): Promise<void>;
  pendingTargets(): Promise<string[]>;
  depth(targetInstanceId: string): Promise<number>;
  listForTask(taskId: string): Promise<RelayMessage[]>;
}

/** Serializes access per key so two callers cannot interleave a delivery. */
export interface Mutex {
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface TaskStore {
  create(task: DelegatedTask): Promise<DelegatedTask>;
  get(taskId: string): Promise<DelegatedTask | undefined>;
  update(taskId: string, patch: Partial<Omit<DelegatedTask, "id" | "createdAt">>): Promise<DelegatedTask>;
  listByContext(contextId: string): Promise<DelegatedTask[]>;
  listByInstance(instanceId: string): Promise<DelegatedTask[]>;
  listActive(): Promise<DelegatedTask[]>;
}

export interface LiveAgentStore {
  put(agent: LiveAgent): Promise<void>;
  get(instanceId: string): Promise<LiveAgent | undefined>;
  byLogicalTarget(target: string): Promise<LiveAgent[]>;
  all(): Promise<LiveAgent[]>;
  delete(instanceId: string): Promise<void>;
}

export interface TaskService {
  observe(instanceId: string, snapshot: AgentSnapshot): Promise<void>;
  transition(taskId: string, state: PublicTaskState, patch?: Partial<DelegatedTask>): Promise<DelegatedTask>;
}

export interface DelegationService {
  delegate(req: DelegateRequest): Promise<DelegatedTask>;
  continueTask(taskId: string, message: string, caller?: AgentIdentity): Promise<DelegatedTask>;
  get(taskId: string): Promise<DelegatedTask>;
  cancel(taskId: string): Promise<DelegatedTask>;
}

export interface Reconciler {
  /** Re-verifies persisted instances against live Herdr state (spec §40). */
  reconcile(): Promise<{ verified: number; orphaned: number }>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LayoutConfig {
  minColumns: number;
  minRows: number;
  overflow: "new_tab";
}

export interface RelayConfig {
  /** Consecutive-ms window the target must stay deliverable (spec §12.1). */
  stableWindowMs: number;
  turnStartTimeoutMs: number;
  settleTimeoutMs: number;
  messageTtlMs: number;
  maxQueueDepth: number;
  maxDeliveryAttempts: number;
}

export interface RecoveryConfig {
  maxLaunchAttempts: number;
  maxDeliveryAttempts: number;
}

export interface GatewayConfig {
  host: string;
  port: number;
  baseUrl: string;
}

export interface AppConfig {
  gateway: GatewayConfig;
  layout: LayoutConfig;
  relay: RelayConfig;
  recovery: RecoveryConfig;
  defaults: {
    visibility: Visibility;
    focusNewAgent: boolean;
  };
  agents: Record<string, import("./model.js").CustomAgentProfile>;
  dbPath: string;
  herdr: {
    socketPath?: string;
    binPath: string;
    launchabilityTtlMs: number;
  };
}
