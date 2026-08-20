import { DelegationFailure, ERROR_CODES, fail } from "../core/errors.js";
import type { AgentSnapshot, Blocker, LiveAgent, RelayMessage, RelayState } from "../core/model.js";
import type { DelegationError } from "../core/errors.js";
import type {
  Clock,
  EventSink,
  HerdrClient,
  LiveAgentStore,
  Logger,
  Mutex,
  QueueStore,
  RelayConfig,
  RuntimeAdapterRegistry,
} from "../core/ports.js";
import { EVENTS } from "../observability/events.js";
import { assertTargetIdentity, isDeliverable, isStableSince, snapshotFromAgentInfo, type StabilitySample } from "./deliverability.js";
import { deliveryMarker, formatRelayEnvelope } from "./envelope.js";
import { transition } from "./state-machine.js";

export interface DeliveryWorkerOptions {
  herdr: HerdrClient;
  queue: QueueStore;
  liveAgents: LiveAgentStore;
  adapters: RuntimeAdapterRegistry;
  lock: Mutex;
  clock: Clock;
  config: RelayConfig;
  events: EventSink;
  logger: Logger;
  onStateChange(message: RelayMessage): void;
  onTurnStarted(message: RelayMessage, preSeq: number): void;
  onBlocker(message: RelayMessage, blocker: Blocker): void;
  /**
   * A message that will never be delivered. Without this the task layer has no
   * way to learn that its delegation is dead, and the task sits at `submitted`
   * or `working` forever.
   */
  onFailed(message: RelayMessage, error: DelegationError): void;
}

/**
 * Fallback re-check schedule for a target that has a pending message but is not
 * yet deliverable.
 *
 * Delivery is event-driven, but events are not guaranteed: if a target reached
 * a ready state before we began observing it, no further status change ever
 * arrives and a queued message waits indefinitely — seen in a live run as a
 * 44-second stall. These are a strictly BOUNDED safety net, not a poll: a
 * handful of backed-off probes, then the target is left to the event stream.
 */
const RECHECK_BACKOFF_MS = [200, 600, 1_800, 5_000] as const;

const EVENT_FOR_STATE: Partial<Record<RelayState, string>> = {
  QUEUED: EVENTS.relayQueued,
  DELIVERING: EVENTS.relayDelivering,
  DELIVERED: EVENTS.relayDelivered,
  TURN_STARTED: EVENTS.relayTurnStarted,
  SETTLED: EVENTS.relaySettled,
  EXPIRED: EVENTS.relayExpired,
  FAILED: EVENTS.relayFailed,
};

/**
 * Processes one FIFO head at a time per target. The target mutex deliberately
 * ends immediately after turn-start proof; settlement is a separate observer
 * so a slow turn cannot starve either another target or later status handling.
 */
export class DeliveryWorker {
  private readonly samples = new Map<string, StabilitySample>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Consecutive fallback probes already spent per target. */
  private readonly rechecks = new Map<string, number>();
  private stopped = true;

  constructor(private readonly opts: DeliveryWorkerOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    for (const target of await this.opts.queue.pendingTargets()) this.notifyTargetChanged(target);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.samples.clear();
    this.rechecks.clear();
  }

  /** Called on enqueue and on any observed target change: resets the budget. */
  resetRecheckBudget(instanceId: string): void {
    this.rechecks.delete(instanceId);
  }

  notifyTargetChanged(instanceId: string): void {
    if (this.stopped) return;
    this.clearTimer(instanceId);
    void this.pump(instanceId).catch((err: unknown) => {
      this.opts.logger.log("warn", "relay pump failed", { instanceId, error: String(err) });
    });
  }

  private async pump(instanceId: string): Promise<void> {
    if (this.stopped) return;
    await this.opts.lock.runExclusive(instanceId, async () => {
      if (this.stopped) return;
      const message = await this.opts.queue.peek(instanceId);
      if (!message) return;
      if (this.expired(message)) {
        await this.setState(message, "EXPIRED");
        this.notifyTargetChanged(instanceId);
        return;
      }

      const live = await this.opts.liveAgents.get(instanceId);
      if (!live) {
        await this.fail(message, fail(ERROR_CODES.TARGET_LOST, "delivery target no longer exists", { instanceId }));
        return;
      }

      let current: AgentSnapshot;
      try {
        current = await this.readVerified(live);
      } catch (err) {
        await this.fail(message, this.classify(err));
        return;
      }

      if (current.status === "blocked") {
        await this.reportBlocker(message, live, current);
        return;
      }
      if (!isDeliverable(current)) {
        this.samples.delete(instanceId);
        this.scheduleRecheck(instanceId);
        return;
      }
      // Deliverable again: any fallback probes we owed this target are spent.
      this.rechecks.delete(instanceId);

      const now = this.opts.clock.now().getTime();
      const previous = this.samples.get(instanceId);
      if (!isStableSince(previous, current, now, this.opts.config.stableWindowMs)) {
        this.samples.set(instanceId, {
          stateChangeSeq: current.stateChangeSeq,
          revision: current.revision,
          observedAtMs: now,
        });
        if (this.opts.config.stableWindowMs > 0) {
          this.schedule(instanceId, this.opts.config.stableWindowMs);
          return;
        }
      }

      // The check and prompt stay in the same target critical section (§12).
      let before: AgentSnapshot;
      try {
        before = await this.readVerified(live);
      } catch (err) {
        await this.fail(message, this.classify(err));
        return;
      }
      if (before.status === "blocked") {
        await this.reportBlocker(message, live, before);
        return;
      }
      if (
        !isDeliverable(before) ||
        before.stateChangeSeq !== current.stateChangeSeq ||
        before.revision !== current.revision
      ) {
        this.samples.set(instanceId, {
          stateChangeSeq: before.stateChangeSeq,
          revision: before.revision,
          observedAtMs: this.opts.clock.now().getTime(),
        });
        this.schedule(instanceId, this.opts.config.stableWindowMs);
        return;
      }

      const delivering = await this.setState(message, "DELIVERING", message.attempt + 1);
      const adapter = this.opts.adapters.for(live.runtimeKind);
      const text = formatRelayEnvelope(delivering, adapter);
      let after: AgentSnapshot | undefined;
      try {
        const result = await this.opts.herdr.agentPrompt({
          target: live.herdrAgentName,
          text,
          wait: { until: ["working"], timeoutMs: this.opts.config.turnStartTimeoutMs },
        });
        after = snapshotFromAgentInfo(result, this.opts.clock);
        assertTargetIdentity(live, after);
      } catch (err) {
        if (this.isPromptStalled(err)) {
          await this.retryOrFail(delivering, live, fail(ERROR_CODES.TURN_DID_NOT_START, "agent prompt stalled"));
        } else {
          await this.retryOrFail(delivering, live, err);
        }
        return;
      }

      const delivered = await this.setState(delivering, "DELIVERED", delivering.attempt);
      if (!this.hasTurnStarted(before, after)) {
        try {
          const waited = snapshotFromAgentInfo(
            await this.opts.herdr.agentWait({
              target: live.herdrAgentName,
              until: ["working"],
              timeoutMs: this.opts.config.turnStartTimeoutMs,
            }),
            this.opts.clock,
          );
          assertTargetIdentity(live, waited);
          after = waited;
        } catch (err) {
          await this.retryOrFail(delivered, live, this.isPromptStalled(err)
            ? fail(ERROR_CODES.TURN_DID_NOT_START, "agent prompt stalled")
            : err);
          return;
        }
      }

      if (!this.hasTurnStarted(before, after)) {
        await this.retryOrFail(delivered, live, fail(ERROR_CODES.TURN_DID_NOT_START, "target did not start a new turn"));
        return;
      }

      const started = await this.setState(delivered, "TURN_STARTED", delivered.attempt);
      this.samples.delete(instanceId);
      this.opts.onTurnStarted(started, before.stateChangeSeq);
      void this.observeSettlement(started, live, before.stateChangeSeq);
      // The head is now terminal from the queue's perspective; another nudge
      // (normally the working→ready event) admits the next FIFO message.
    });
  }

  private async observeSettlement(message: RelayMessage, live: LiveAgent, startSeq: number): Promise<void> {
    try {
      const info = await this.opts.herdr.agentWait({
        target: live.herdrAgentName,
        until: ["idle", "done", "blocked"],
        timeoutMs: this.opts.config.settleTimeoutMs,
      });
      if (this.stopped) return;
      const snapshot = snapshotFromAgentInfo(info, this.opts.clock);
      assertTargetIdentity(live, snapshot);
      if (snapshot.status === "blocked") await this.reportBlocker(message, live, snapshot);
      if ((snapshot.status === "idle" || snapshot.status === "done") && snapshot.stateChangeSeq > startSeq) {
        await this.setState(message, "SETTLED");
        this.notifyTargetChanged(live.instanceId);
      }
    } catch (err) {
      // A target that vanished mid-turn will never settle, so swallowing this
      // would leave the task at `working` forever. Anything else (a settle
      // timeout, a transient read) is genuinely not a delivery failure.
      if (this.isTargetGone(err)) {
        await this.fail(message, this.classify(err));
        return;
      }
      this.opts.logger.log("debug", "relay settlement observation ended", { messageId: message.id, error: String(err) });
    }
  }

  private hasTurnStarted(before: AgentSnapshot, after: AgentSnapshot): boolean {
    return after.status === "working" && after.stateChangeSeq > before.stateChangeSeq;
  }

  private async readVerified(live: LiveAgent): Promise<AgentSnapshot> {
    const snapshot = snapshotFromAgentInfo(await this.opts.herdr.agentGet(live.herdrAgentName), this.opts.clock);
    assertTargetIdentity(live, snapshot);
    return snapshot;
  }

  private async reportBlocker(message: RelayMessage, live: LiveAgent, snapshot: AgentSnapshot): Promise<void> {
    const adapter = this.opts.adapters.for(live.runtimeKind);
    let text = "";
    try {
      text = await this.opts.herdr.agentRead({ target: live.herdrAgentName, source: "detection", stripAnsi: true });
    } catch {
      // The classified blocked status remains more useful than an unreadable screen.
    }
    this.opts.onBlocker(message, adapter.classifyBlocker?.(snapshot, text) ?? { kind: "unknown", ...(text ? { text } : {}) });
  }

  private async retryOrFail(message: RelayMessage, live: LiveAgent, cause: unknown): Promise<void> {
    if (cause instanceof DelegationFailure && cause.code === ERROR_CODES.TARGET_IDENTITY_CHANGED) {
      await this.fail(message, cause);
      return;
    }
    // An agent that vanished after accepting the prompt is terminal too:
    // there is nothing left to retry into, and probing its output would only
    // produce another `agent_not_found`.
    if (this.isTargetGone(cause)) {
      await this.fail(message, this.classify(cause));
      return;
    }
    if (await this.textAlreadyLanded(live, message)) {
      await this.fail(message, fail(ERROR_CODES.DELIVERY_FAILED, "delivery retry suppressed because prompt text already landed"));
      return;
    }
    if (message.attempt >= this.opts.config.maxDeliveryAttempts) {
      await this.fail(message, cause);
      return;
    }
    const queued = await this.setState(message, "QUEUED", message.attempt);
    this.opts.events.emit(EVENTS.relayRetry, { messageId: queued.id, attempt: queued.attempt, cause: String(cause) });
    this.notifyTargetChanged(queued.targetInstanceId);
  }

  /**
   * Retry suppression evidence. Matches a short single-line marker rather than
   * the whole envelope: the terminal soft-wraps and reflows, so a multi-line
   * comparison would essentially never match and the check would be dead code
   * that lets duplicate prompts through. See `deliveryMarker`.
   */
  private async textAlreadyLanded(live: LiveAgent, message: RelayMessage): Promise<boolean> {
    try {
      const recent = await this.opts.herdr.agentRead({
        target: live.herdrAgentName,
        source: "recent_unwrapped",
        stripAnsi: true,
      });
      return recent.includes(deliveryMarker(message));
    } catch {
      // No evidence either way. Fall through to the attempt budget rather than
      // assuming the text landed, so a readable failure still gets its retry.
      return false;
    }
  }

  private isPromptStalled(err: unknown): boolean {
    return err instanceof DelegationFailure && err.details?.["herdrCode"] === "agent_prompt_stalled";
  }

  /**
   * `agent_not_found` is Herdr's stable code for a target that no longer
   * exists (verified against 0.8.0 for both an unknown name and a stale pane
   * id). It deserves `TARGET_LOST` rather than a generic delivery failure, and
   * it is never worth retrying — the agent is gone, not busy.
   */
  private isTargetGone(err: unknown): boolean {
    return err instanceof DelegationFailure && err.details?.["herdrCode"] === "agent_not_found";
  }

  /** Recasts a Herdr error into the taxonomy the caller reasons about. */
  private classify(err: unknown): unknown {
    if (!this.isTargetGone(err)) return err;
    return fail(ERROR_CODES.TARGET_LOST, "the delivery target no longer exists");
  }

  private expired(message: RelayMessage): boolean {
    return message.expiresAt !== undefined && Date.parse(message.expiresAt) <= this.opts.clock.now().getTime();
  }

  private async fail(message: RelayMessage, err: unknown): Promise<void> {
    const failed = await this.setState(message, "FAILED", message.attempt);
    const failure = err instanceof DelegationFailure ? err : fail(ERROR_CODES.DELIVERY_FAILED, String(err));
    this.opts.events.emit(EVENTS.relayFailed, { messageId: failed.id, code: failure.code, retryable: failure.retryable });
    this.opts.onFailed(failed, failure.toJSON());
  }

  private async setState(message: RelayMessage, state: RelayState, attempt = message.attempt): Promise<RelayMessage> {
    transition(message.state, state);
    const updated = await this.opts.queue.setState(message.id, state, attempt);
    this.opts.onStateChange(updated);
    const event = EVENT_FOR_STATE[state];
    if (event) this.opts.events.emit(event, { messageId: updated.id, targetInstanceId: updated.targetInstanceId, attempt: updated.attempt });
    return updated;
  }

  /**
   * Schedules the next bounded fallback probe, or gives up and waits for an
   * event. Bounded on purpose: an unbounded re-check would be a poll loop, and
   * spec §52 requires every path to terminate deterministically.
   */
  private scheduleRecheck(instanceId: string): void {
    const spent = this.rechecks.get(instanceId) ?? 0;
    const delay = RECHECK_BACKOFF_MS[spent];
    if (delay === undefined) return;
    this.rechecks.set(instanceId, spent + 1);
    this.schedule(instanceId, delay);
  }

  private schedule(instanceId: string, delayMs: number): void {
    if (this.stopped || this.timers.has(instanceId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(instanceId);
      this.notifyTargetChanged(instanceId);
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.timers.set(instanceId, timer);
  }

  private clearTimer(instanceId: string): void {
    const timer = this.timers.get(instanceId);
    if (timer) clearTimeout(timer);
    this.timers.delete(instanceId);
  }
}
