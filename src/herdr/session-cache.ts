import { ERROR_CODES, fail } from "../core/errors.js";
import type {
  Clock,
  EventSink,
  HerdrClient,
  HerdrSubscription,
  Logger,
  SessionCache,
} from "../core/ports.js";
import type { AgentInfo, PaneInfo, SessionSnapshot, Subscription } from "./types.js";

/**
 * Everything the delegation layer needs to observe.
 *
 * `pane.agent_status_changed` is deliberately absent: it REQUIRES a `pane_id`
 * (verified against 0.8.0), so there is no session-wide agent-status feed.
 * `pane.updated` is the only global status signal — noisier, because it also
 * fires on output, which is why a status re-read is gated on an actual change.
 */
const SUBSCRIPTIONS: Subscription[] = [
  { type: "pane.updated" },
  { type: "pane.agent_detected" },
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.exited" },
  { type: "pane.moved" },
  { type: "tab.closed" },
  { type: "workspace.focused" },
  { type: "tab.focused" },
  { type: "pane.focused" },
];

export interface SessionCacheOptions {
  herdr: HerdrClient;
  clock: Clock;
  logger: Logger;
  events: EventSink;
  /** Backoff schedule for reconnect attempts, in ms. */
  reconnectDelaysMs?: number[];
}

const DEFAULT_RECONNECT_DELAYS = [250, 500, 1_000, 2_000, 5_000];

/**
 * Local mirror of Herdr state, seeded by `session.snapshot` and maintained by
 * events (spec §41). Two disciplines matter here:
 *
 * 1. `events.subscribe` **backfills** current state for every matching resource
 *    before streaming live changes. The backfill is a baseline, not a
 *    transition, so status listeners must not fire for it — otherwise every
 *    subscribe looks like every agent just changed state.
 *
 * 2. On reconnect we resnapshot and fire `onResync` rather than trusting the
 *    old cache. Consumers use that to re-verify identity before resuming
 *    queues (spec §40).
 */
export class HerdrSessionCache implements SessionCache {
  private snap: SessionSnapshot | undefined;
  private readonly agentsByPane = new Map<string, AgentInfo>();
  private readonly panesById = new Map<string, PaneInfo>();

  private focusedWorkspaceId: string | undefined;
  private focusedTabId: string | undefined;
  private focusedPaneId: string | undefined;

  private subscription: HerdrSubscription | undefined;
  private readonly resyncHandlers = new Set<() => void>();
  private readonly statusHandlers = new Set<(agent: AgentInfo) => void>();

  /** Panes whose baseline backfill frame has already been absorbed. */
  private readonly seeded = new Set<string>();
  private priming = false;

  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: SessionCacheOptions) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.prime();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.subscription?.close();
    this.subscription = undefined;
    this.resyncHandlers.clear();
    this.statusHandlers.clear();
  }

  /** Snapshot, then subscribe. Order matters: the snapshot is the baseline. */
  private async prime(): Promise<void> {
    const snapshot = await this.opts.herdr.sessionSnapshot();
    this.applySnapshot(snapshot);

    this.subscription?.close();
    // Suppress status callbacks while Herdr replays current state on subscribe.
    this.priming = true;
    this.subscription = await this.opts.herdr.subscribe(SUBSCRIPTIONS, (event, data) =>
      this.onEvent(event, data),
    );
    // The backfill arrives on the same connection right after the ack. Release
    // the guard on the next macrotask so replayed frames land as baselines.
    setTimeout(() => {
      this.priming = false;
    }, 0).unref?.();

    this.reconnectAttempt = 0;
  }

  private applySnapshot(snapshot: SessionSnapshot): void {
    this.snap = snapshot;
    this.agentsByPane.clear();
    this.panesById.clear();
    this.seeded.clear();
    for (const pane of snapshot.panes) {
      this.panesById.set(pane.pane_id, pane);
      this.seeded.add(pane.pane_id);
    }
    for (const agent of snapshot.agents) {
      this.agentsByPane.set(agent.pane_id, agent);
    }
    this.focusedWorkspaceId = snapshot.focused_workspace_id;
    this.focusedTabId = snapshot.focused_tab_id;
    this.focusedPaneId = snapshot.focused_pane_id;
  }

  /** Called by the socket client when the connection drops. */
  handleDisconnect(): void {
    if (!this.running) return;
    this.subscription?.close();
    this.subscription = undefined;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delays = this.opts.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS;
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)] ?? 5_000;
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.prime().then(
        () => {
          this.opts.logger.log("info", "herdr: resynced after reconnect", {
            attempt: this.reconnectAttempt,
          });
          for (const handler of this.resyncHandlers) {
            try {
              handler();
            } catch (err) {
              this.opts.logger.log("warn", "resync handler threw", { error: String(err) });
            }
          }
        },
        (err) => {
          this.opts.logger.log("warn", "herdr: resync failed", { error: String(err) });
          this.scheduleReconnect();
        },
      );
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private onEvent(event: string, data: Record<string, unknown>): void {
    const pane = data["pane"] as PaneInfo | undefined;
    const agent = data["agent"] as AgentInfo | undefined;

    switch (event) {
      case "pane.closed":
      case "pane.exited": {
        const paneId = pane?.pane_id ?? (data["pane_id"] as string | undefined);
        if (paneId) {
          this.panesById.delete(paneId);
          this.agentsByPane.delete(paneId);
          this.seeded.delete(paneId);
        }
        return;
      }
      case "tab.closed": {
        const tabId = (data["tab"] as { tab_id?: string } | undefined)?.tab_id ?? (data["tab_id"] as string | undefined);
        if (!tabId) return;
        for (const [paneId, info] of [...this.panesById]) {
          if (info.tab_id !== tabId) continue;
          this.panesById.delete(paneId);
          this.agentsByPane.delete(paneId);
          this.seeded.delete(paneId);
        }
        return;
      }
      // Flat payloads (spec: `{ type: "workspace_focused", workspace_id }`,
      // `{ type: "tab_focused", tab_id, workspace_id }`,
      // `{ type: "pane_focused", pane_id, workspace_id }`) — not nested under
      // a `pane`/`tab` object like `pane.updated`/`tab.closed` are.
      case "workspace.focused": {
        const workspaceId = data["workspace_id"] as string | undefined;
        if (workspaceId) this.focusedWorkspaceId = workspaceId;
        return;
      }
      case "tab.focused": {
        const tabId = data["tab_id"] as string | undefined;
        const workspaceId = data["workspace_id"] as string | undefined;
        if (tabId) this.focusedTabId = tabId;
        if (workspaceId) this.focusedWorkspaceId = workspaceId;
        return;
      }
      case "pane.focused": {
        const paneId = data["pane_id"] as string | undefined;
        const workspaceId = data["workspace_id"] as string | undefined;
        if (paneId) this.focusedPaneId = paneId;
        if (workspaceId) this.focusedWorkspaceId = workspaceId;
        return;
      }
      default:
        break;
    }

    const record = agent ?? pane;
    if (!record) return;

    const paneId = record.pane_id;
    const previousStatus = this.panesById.get(paneId)?.agent_status;
    const previousAgent = this.panesById.get(paneId)?.agent ?? null;
    if (pane) this.panesById.set(pane.pane_id, pane);

    // A pane without a detected agent is not an agent record. Drop any stale
    // binding: the previous occupant may have exited or been replaced, and a
    // queued message must never inherit the new occupant (spec §40).
    const nextAgent = (record as AgentInfo).agent ?? (record as PaneInfo).agent ?? null;
    if (!nextAgent) {
      this.agentsByPane.delete(paneId);
      this.seeded.add(paneId);
      return;
    }

    const baseline = this.priming && !this.seeded.has(paneId);
    this.seeded.add(paneId);
    if (baseline) {
      this.stash(paneId, record as AgentInfo & PaneInfo);
      return;
    }

    // `pane.updated` also fires on output, so re-read only when the agent
    // identity or its status actually moved. Otherwise a chatty worker would
    // generate one `agent.get` per frame of output.
    const changed = nextAgent !== previousAgent || record.agent_status !== previousStatus;
    if (!changed) {
      this.stash(paneId, record as AgentInfo & PaneInfo);
      return;
    }

    void this.refreshAgent(paneId, record as AgentInfo & PaneInfo);
  }

  /**
   * A pane event carries only `PaneInfo`: no `state_change_seq`, no
   * `interactive_ready`, no `launch_pending`. Those three are exactly what
   * deliverability and turn-start proof depend on, so an observed change is
   * followed by an authoritative `agent.get` rather than being published from
   * the event alone.
   */
  private async refreshAgent(paneId: string, fallback: AgentInfo & PaneInfo): Promise<void> {
    let info: AgentInfo;
    try {
      info = await this.opts.herdr.agentGet(paneId);
    } catch {
      // The agent may have vanished between the event and the read. Publish the
      // weaker event-derived record so a status change is never simply lost;
      // consumers already treat missing evidence as "not ready".
      info = this.stash(paneId, fallback);
      this.publish(info);
      return;
    }

    this.agentsByPane.set(paneId, info);
    this.publish(info);
  }

  private stash(paneId: string, incoming: AgentInfo & PaneInfo): AgentInfo {
    // Keep the richer fields from the last authoritative read rather than
    // regressing them to undefined.
    const previous = this.agentsByPane.get(paneId);
    const merged = { ...(previous ?? {}), ...incoming } as AgentInfo;
    this.agentsByPane.set(paneId, merged);
    return merged;
  }

  private publish(info: AgentInfo): void {
    for (const handler of this.statusHandlers) {
      try {
        handler(info);
      } catch (err) {
        this.opts.logger.log("warn", "status handler threw", { error: String(err) });
      }
    }
  }

  snapshot(): SessionSnapshot | undefined {
    return this.snap;
  }

  focusedContext(): { workspaceId: string; tabId: string; paneId: string } | undefined {
    if (!this.focusedWorkspaceId || !this.focusedTabId || !this.focusedPaneId) return undefined;
    return { workspaceId: this.focusedWorkspaceId, tabId: this.focusedTabId, paneId: this.focusedPaneId };
  }

  agents(): AgentInfo[] {
    return [...this.agentsByPane.values()];
  }

  agentByPane(paneId: string): AgentInfo | undefined {
    return this.agentsByPane.get(paneId);
  }

  agentBySessionRef(sessionRef: string): AgentInfo | undefined {
    for (const agent of this.agentsByPane.values()) {
      if (agent.agent_session?.value === sessionRef) return agent;
    }
    return undefined;
  }

  pane(paneId: string): PaneInfo | undefined {
    return this.panesById.get(paneId);
  }

  onResync(handler: () => void): () => void {
    this.resyncHandlers.add(handler);
    return () => this.resyncHandlers.delete(handler);
  }

  onAgentStatus(handler: (agent: AgentInfo) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /** Forces a fresh snapshot. Used by `doctor` and by reconciliation. */
  async resnapshot(): Promise<SessionSnapshot> {
    if (!this.running) throw fail(ERROR_CODES.HERDR_SESSION_STALE, "session cache is not running");
    const snapshot = await this.opts.herdr.sessionSnapshot();
    this.applySnapshot(snapshot);
    return snapshot;
  }
}
