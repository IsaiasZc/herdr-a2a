import { ERROR_CODES } from "./errors.js";
import { toSnapshot } from "./identities.js";
import { EVENTS } from "../observability/events.js";
import { TERMINAL_TASK_STATES } from "./model.js";
import type { LiveAgent } from "./model.js";
import type {
  Clock,
  EventSink,
  HerdrClient,
  LiveAgentStore,
  Logger,
  QueueStore,
  Reconciler,
  Relay,
  SessionCache,
  TaskStore,
} from "./ports.js";
import type { DelegatedTaskService } from "./task-service.js";
import type { AgentInfo } from "../herdr/types.js";

export interface ReconcilerOptions {
  herdr: HerdrClient;
  sessionCache: SessionCache;
  liveAgents: LiveAgentStore;
  tasks: TaskStore;
  queue: QueueStore;
  relay: Relay;
  taskService: DelegatedTaskService;
  clock: Clock;
  events: EventSink;
  logger: Logger;
}

/**
 * Re-verifies persisted state against live Herdr after a gateway or Herdr
 * restart (spec §40).
 *
 * The governing rule: a queued message is never delivered to a replacement
 * occupant merely because it reused the same pane. So identity is matched on
 * `agent_session.value` first and `terminal_id` second, and a pane id that
 * merely *looks* familiar counts for nothing.
 */
export class StateReconciler implements Reconciler {
  constructor(private readonly opts: ReconcilerOptions) {}

  async reconcile(): Promise<{ verified: number; orphaned: number }> {
    this.opts.events.emit(EVENTS.reconcileStarted);

    const live = await this.opts.herdr.agentList();
    const stored = await this.opts.liveAgents.all();

    let verified = 0;
    let orphaned = 0;

    for (const record of stored) {
      const match = this.match(record, live);
      if (match) {
        await this.reattach(record, match);
        verified += 1;
      } else {
        await this.orphan(record);
        orphaned += 1;
      }
    }

    await this.rebaselineTurns();

    this.opts.events.emit(EVENTS.reconcileCompleted, { verified, orphaned });
    return { verified, orphaned };
  }

  /**
   * Identity match, strongest anchor first. `pane_id` is deliberately absent
   * from the comparison — it is a location, not an identity.
   */
  private match(record: LiveAgent, live: AgentInfo[]): AgentInfo | undefined {
    if (record.sessionRef) {
      const bySession = live.find((a) => a.agent_session?.value === record.sessionRef);
      if (bySession) return bySession;
    }
    if (record.terminalId) {
      const byTerminal = live.find((a) => a.terminal_id === record.terminalId);
      // A terminal that now hosts a different runtime is not our worker.
      if (byTerminal && byTerminal.agent === record.runtimeKind) return byTerminal;
    }
    return undefined;
  }

  /** Refreshes the location fields, which are the only ones allowed to drift. */
  private async reattach(record: LiveAgent, info: AgentInfo): Promise<void> {
    const moved = record.paneId !== info.pane_id;
    await this.opts.liveAgents.put({
      ...record,
      paneId: info.pane_id,
      terminalId: info.terminal_id,
      workspaceId: info.workspace_id,
      tabId: info.tab_id,
      ...(info.agent_session?.value ? { sessionRef: info.agent_session.value } : {}),
      ...(info.name ? { herdrAgentName: info.name } : {}),
    });

    if (moved) {
      this.opts.logger.log("info", "reconcile: worker moved pane", {
        instance: record.instanceId,
        from: record.paneId,
        to: info.pane_id,
      });
    }
  }

  /** The worker is gone: drop its queue and fail its live tasks explicitly. */
  private async orphan(record: LiveAgent): Promise<void> {
    await this.opts.relay.cancelForTarget(record.instanceId).catch(() => {});

    const tasks = await this.opts.tasks.listByInstance(record.instanceId);
    for (const task of tasks) {
      if (TERMINAL_TASK_STATES.has(task.state)) continue;
      await this.opts.taskService.transition(task.id, "failed", {
        error: {
          code: ERROR_CODES.TARGET_LOST,
          message: `the worker for this task (${record.logicalTarget}) did not survive the restart`,
          retryable: false,
        },
      });
    }

    await this.opts.liveAgents.delete(record.instanceId);
    this.opts.logger.log("warn", "reconcile: orphaned worker", {
      instance: record.instanceId,
      target: record.logicalTarget,
      tasks: tasks.length,
    });
  }

  /**
   * Turn baselines live in memory, so a restart loses them. Re-baseline from
   * the *current* lifecycle counter rather than assuming the stored task is
   * mid-turn — and when the worker is already settled, hand the snapshot to the
   * task service so a turn that finished during the downtime is not waited on
   * forever.
   */
  private async rebaselineTurns(): Promise<void> {
    for (const task of await this.opts.tasks.listActive()) {
      if (task.state !== "working" || !task.liveInstanceId) continue;

      const record = await this.opts.liveAgents.get(task.liveInstanceId);
      if (!record) continue;

      let info: AgentInfo;
      try {
        info = await this.opts.herdr.agentGet(record.herdrAgentName);
      } catch {
        continue;
      }

      const snapshot = toSnapshot(info, this.opts.clock);
      const settled = snapshot.status === "idle" || snapshot.status === "done";

      // For a settled worker, baseline one step *below* the current counter so
      // the very next observation recognizes the turn as finished. For a still
      // working one, baseline at the current counter and wait for the real
      // advance.
      this.opts.taskService.rebaseline(
        task.id,
        record.instanceId,
        settled ? Math.max(snapshot.stateChangeSeq - 1, 0) : snapshot.stateChangeSeq,
      );

      if (settled || snapshot.status === "blocked") {
        await this.opts.taskService.observe(record.instanceId, snapshot);
      }
    }
  }
}
