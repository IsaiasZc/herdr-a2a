import { ERROR_CODES, toDelegationError, type ErrorCode } from "./errors.js";
import { toSnapshot } from "./identities.js";
import { EVENTS } from "../observability/events.js";
import type {
  AgentSnapshot,
  Blocker,
  DelegatedTask,
  PublicTaskState,
  RelayMessage,
  TaskResult,
} from "./model.js";
import { TERMINAL_TASK_STATES } from "./model.js";
import type {
  Clock,
  EventSink,
  HerdrClient,
  LiveAgentStore,
  Logger,
  RuntimeAdapterRegistry,
  TaskService,
  TaskStore,
} from "./ports.js";

/** What we remember about an in-flight turn. Rebuilt by reconciliation. */
interface TurnWatch {
  instanceId: string;
  /** `state_change_seq` observed when the turn started. */
  startSeq: number;
}

export interface TaskServiceOptions {
  tasks: TaskStore;
  liveAgents: LiveAgentStore;
  herdr: HerdrClient;
  adapters: RuntimeAdapterRegistry;
  clock: Clock;
  events: EventSink;
  logger: Logger;
}

/**
 * Owns the A2A task lifecycle (spec §13). Two rules shape the whole class:
 *
 * - `idle` is not `completed`. Per docs/herdr-contract.md §4, `idle` and `done`
 *   differ only by whether the tab has been seen, and neither proves the
 *   delegated task produced its final semantic result. A settle is only
 *   recognized when the lifecycle counter has advanced past the value captured
 *   when *our* turn started.
 * - a blocker is never answered, only classified and surfaced (spec §29).
 */
export class DelegatedTaskService implements TaskService {
  /**
   * In-memory turn baselines. Deliberately not persisted: the durable record is
   * the task row, and a gateway restart re-baselines from live Herdr state
   * during reconciliation rather than trusting a stale sequence number.
   */
  private readonly watches = new Map<string, TurnWatch>();

  private readonly changeHandlers = new Set<(task: DelegatedTask) => void>();

  constructor(private readonly opts: TaskServiceOptions) {}

  /** Fires after every persisted state change. Used by the A2A stream. */
  onChange(handler: (task: DelegatedTask) => void): () => void {
    this.changeHandlers.add(handler);
    return () => this.changeHandlers.delete(handler);
  }

  /** Called by the relay when a message reaches TURN_STARTED. */
  async noteTurnStarted(message: RelayMessage, startSeq: number): Promise<void> {
    this.watches.set(message.taskId, { instanceId: message.targetInstanceId, startSeq });
    await this.transition(message.taskId, "working", { lastRelayMessageId: message.id });
  }

  /** Re-baselines a turn without claiming it just started. Used on restart. */
  rebaseline(taskId: string, instanceId: string, seq: number): void {
    this.watches.set(taskId, { instanceId, startSeq: seq });
  }

  forget(taskId: string): void {
    this.watches.delete(taskId);
  }

  /**
   * Fed by every agent status change for a managed instance. Only advances a
   * task that is already `working`; a task still `submitted` is waiting on the
   * relay, and moving it here would mark work as started that never was
   * (spec §38 — do not silently mark a task working).
   */
  async observe(instanceId: string, snapshot: AgentSnapshot): Promise<void> {
    const tasks = await this.opts.tasks.listByInstance(instanceId);
    const active = tasks.filter((t) => !TERMINAL_TASK_STATES.has(t.state));
    if (active.length === 0) return;

    for (const task of active) {
      try {
        await this.observeTask(task, instanceId, snapshot);
      } catch (err) {
        this.opts.logger.log("warn", "task observation failed", {
          task_id: task.id,
          error: String(err),
        });
      }
    }
  }

  private async observeTask(
    task: DelegatedTask,
    instanceId: string,
    snapshot: AgentSnapshot,
  ): Promise<void> {
    if (task.state !== "working") return;

    // Without a baseline we cannot tell our turn from the previous one, so hold
    // rather than guess. Reconciliation supplies the baseline after a restart.
    const watch = this.watches.get(task.id);
    if (!watch || watch.instanceId !== instanceId) return;

    if (snapshot.status === "blocked") {
      await this.handleBlocked(task, snapshot);
      return;
    }

    const settled = snapshot.status === "idle" || snapshot.status === "done";
    if (!settled) return;
    if (snapshot.stateChangeSeq <= watch.startSeq) return;

    await this.settle(task, snapshot);
  }

  private async handleBlocked(task: DelegatedTask, snapshot: AgentSnapshot): Promise<void> {
    const live = await this.opts.liveAgents.get(task.liveInstanceId ?? "");
    const adapter = this.opts.adapters.for(live?.runtimeKind ?? task.target.runtimeKind ?? "");

    let detection = "";
    try {
      detection = await this.opts.herdr.agentRead({
        target: live?.herdrAgentName ?? snapshot.paneId,
        source: "detection",
        lines: 60,
      });
    } catch {
      // A failed read is not fatal: classification degrades to `unknown`, which
      // still surfaces as input-required rather than being auto-answered.
    }

    const blocker: Blocker = adapter.classifyBlocker?.(snapshot, detection) ?? { kind: "unknown" };
    const state: PublicTaskState = blocker.kind === "auth" ? "auth-required" : "input-required";

    // Trust and permission prompts carry real authority; they must reach a human
    // or the delegating caller, never be typed through (spec §29, §39).
    await this.transition(task.id, state, {
      ...(blocker.text ? { question: blocker.text } : { question: detection.trim().slice(-2_000) }),
    });
  }

  private async settle(task: DelegatedTask, snapshot: AgentSnapshot): Promise<void> {
    const live = await this.opts.liveAgents.get(task.liveInstanceId ?? "");
    if (!live) {
      await this.transition(task.id, "failed", {
        error: {
          code: ERROR_CODES.TARGET_LOST,
          message: "target instance disappeared before its result could be read",
          retryable: false,
        },
      });
      return;
    }

    const adapter = this.opts.adapters.for(live.runtimeKind);
    let result: TaskResult | undefined;
    try {
      result = await adapter.extractResult?.({
        task,
        live,
        herdr: this.opts.herdr,
        preTurn: snapshot,
      });
    } catch (err) {
      this.opts.logger.log("warn", "result extraction failed", {
        task_id: task.id,
        error: String(err),
      });
    }

    if (!result) {
      // The turn genuinely ended, so the task is not still working — but we
      // cannot fabricate a result. RESULT_UNAVAILABLE tells the caller exactly
      // that, instead of returning an empty `completed` (spec §14).
      await this.transition(task.id, "failed", {
        error: {
          code: ERROR_CODES.RESULT_UNAVAILABLE,
          message:
            "the target finished its turn but no result could be extracted; the response may have scrolled off the alternate screen",
          retryable: false,
        },
      });
      return;
    }

    await this.transition(task.id, "completed", { result });
  }

  /**
   * Settles a task on the relay's own evidence.
   *
   * The relay proved the turn started (a `state_change_seq` advance) and then
   * observed it end, so by the time it reports SETTLED the sequence gate in
   * `observeTask` has already been satisfied. Driving completion from here
   * rather than waiting for a status event closes a real gap: in a live run the
   * relay settled correctly while the task sat at `working` forever, because
   * completion depended on a `pane.updated` event that never came.
   */
  async settleFromRelay(taskId: string, instanceId: string): Promise<void> {
    const task = await this.opts.tasks.get(taskId);
    if (!task || task.state !== "working") return;

    const live = await this.opts.liveAgents.get(instanceId);
    if (!live) {
      await this.transition(taskId, "failed", {
        error: {
          code: ERROR_CODES.TARGET_LOST,
          message: "the worker disappeared before its result could be read",
          retryable: false,
        },
      });
      return;
    }

    let snapshot: AgentSnapshot;
    try {
      snapshot = toSnapshot(await this.opts.herdr.agentGet(live.herdrAgentName), this.opts.clock);
    } catch (err) {
      this.opts.logger.log("warn", "settle read failed", { task_id: taskId, error: String(err) });
      return;
    }

    // A blocked target is a question, not a completion.
    if (snapshot.status === "blocked") {
      await this.handleBlocked(task, snapshot);
      return;
    }
    await this.settle(task, snapshot);
  }

  async transition(
    taskId: string,
    state: PublicTaskState,
    patch: Partial<DelegatedTask> = {},
  ): Promise<DelegatedTask> {
    const updated = await this.opts.tasks.update(taskId, { ...patch, state });

    if (TERMINAL_TASK_STATES.has(state)) this.watches.delete(taskId);

    const event = TASK_EVENTS[state];
    if (event) {
      this.opts.events.emit(event, {
        task_id: taskId,
        state,
        ...(updated.liveInstanceId ? { target_instance: updated.liveInstanceId } : {}),
      });
    }

    for (const handler of this.changeHandlers) {
      try {
        handler(updated);
      } catch (err) {
        this.opts.logger.log("warn", "task change handler threw", { task_id: taskId, error: String(err) });
      }
    }

    return updated;
  }

  /** Turns any thrown value into a `failed` task with a taxonomy code. */
  async failFrom(taskId: string, err: unknown, fallback: ErrorCode = ERROR_CODES.TASK_FAILED): Promise<DelegatedTask> {
    return this.transition(taskId, "failed", { error: toDelegationError(err, fallback) });
  }
}

const TASK_EVENTS: Partial<Record<PublicTaskState, string>> = {
  submitted: EVENTS.taskCreated,
  working: EVENTS.taskWorking,
  "input-required": EVENTS.taskInputRequired,
  "auth-required": EVENTS.taskAuthRequired,
  completed: EVENTS.taskCompleted,
  failed: EVENTS.taskFailed,
  canceled: EVENTS.taskCanceled,
};
