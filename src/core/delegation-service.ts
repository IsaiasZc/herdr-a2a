import { existsSync, statSync } from "node:fs";

import { ERROR_CODES, fail } from "./errors.js";
import { SYSTEM_IDENTITY, targetIdentity, toSnapshot } from "./identities.js";
import { TERMINAL_TASK_STATES } from "./model.js";
import { EVENTS } from "../observability/events.js";
import type {
  AgentDescriptor,
  AgentIdentity,
  DelegateRequest,
  DelegatedTask,
  RelayMessage,
  Visibility,
} from "./model.js";
import type {
  AgentCatalog,
  AppConfig,
  Clock,
  DelegationService,
  EventSink,
  HerdrClient,
  IdGenerator,
  LiveAgentStore,
  Logger,
  QueueStore,
  Relay,
  RuntimeAdapterRegistry,
  SpawnManager,
  TaskStore,
} from "./ports.js";
import type { DelegatedTaskService } from "./task-service.js";

export interface DelegationServiceOptions {
  catalog: AgentCatalog;
  spawn: SpawnManager;
  relay: Relay;
  queue: QueueStore;
  tasks: TaskStore;
  taskService: DelegatedTaskService;
  liveAgents: LiveAgentStore;
  adapters: RuntimeAdapterRegistry;
  herdr: HerdrClient;
  config: AppConfig;
  ids: IdGenerator;
  clock: Clock;
  events: EventSink;
  logger: Logger;
  /** Resolves the caller's identity once per request. */
  resolveCaller: () => AgentIdentity;
  /** Caller pane context, so visible workers land next to the caller. */
  callerContext: () => { paneId?: string; tabId?: string; workspaceId?: string; cwd?: string };
}

/**
 * The product abstraction (spec §7, §60): the caller says *who* and *what*;
 * this class resolves *how*. Nothing here leaks a pane id, a split direction or
 * a runtime flag back to the caller.
 */
export class HerdrDelegationService implements DelegationService {
  constructor(private readonly opts: DelegationServiceOptions) {}

  async delegate(req: DelegateRequest): Promise<DelegatedTask> {
    const descriptor = await this.resolveDescriptor(req.agentName);
    const cwd = this.resolveCwd(req.cwd);
    const visibility = this.resolveVisibility(req, descriptor);
    const model = this.resolveModel(req, descriptor);
    const caller = req.caller ?? this.opts.resolveCaller();
    const ctx = this.opts.callerContext();

    // Precedence: the requesting orchestrator's OWN pane/tab (threaded in via
    // transport headers, spec: multi-orchestrator tab targeting) beats the
    // gateway's `callerContext()` fallback (live session focus, or — as a
    // last resort — the gateway process's own frozen env). Two orchestrators
    // delegating concurrently from different tabs must each land in their own
    // tab, never wherever a single session-wide focus signal happens to be.
    const paneId = req.callerPaneId ?? ctx.paneId;
    const tabId = req.callerTabId ?? ctx.tabId;
    const workspaceId = req.callerWorkspaceId ?? ctx.workspaceId;

    const live = await this.opts.spawn.resolveOrSpawn({
      descriptor,
      cwd,
      visibility,
      ...(model ? { model } : {}),
      ...(paneId ? { callerPaneId: paneId } : {}),
      ...(tabId ? { callerTabId: tabId } : {}),
      ...(workspaceId ? { callerWorkspaceId: workspaceId } : {}),
      ...(descriptor.profile?.args ? { args: descriptor.profile.args } : {}),
    });

    const now = this.opts.clock.nowIso();
    const task = await this.opts.tasks.create({
      id: req.taskId ?? this.opts.ids.taskId(),
      ...(req.contextId ? { contextId: req.contextId } : {}),
      caller,
      target: targetIdentity(descriptor.name, descriptor.runtimeKind, live.instanceId.slice(-4)),
      liveInstanceId: live.instanceId,
      state: "submitted",
      createdAt: now,
      updatedAt: now,
    });

    this.opts.events.emit("task.created", {
      task_id: task.id,
      target: descriptor.name,
      runtime: descriptor.runtimeKind,
      target_instance: live.instanceId,
      visibility,
    });

    try {
      await this.enqueue(task, this.composeBody(descriptor, req.message), caller);
    } catch (err) {
      // A failed hand-off must not leave a task stuck at `submitted` forever.
      await this.opts.taskService.failFrom(task.id, err, ERROR_CODES.DELIVERY_FAILED);
      throw err;
    }

    return (await this.opts.tasks.get(task.id)) ?? task;
  }

  async continueTask(taskId: string, message: string, caller?: AgentIdentity): Promise<DelegatedTask> {
    const task = await this.get(taskId);

    if (TERMINAL_TASK_STATES.has(task.state)) {
      throw fail(
        ERROR_CODES.TASK_FAILED,
        `task ${taskId} is ${task.state} and cannot be continued`,
        { state: task.state },
      );
    }

    const live = task.liveInstanceId ? await this.opts.liveAgents.get(task.liveInstanceId) : undefined;
    if (!live) {
      // Spec §32: a continuation reuses the same worker. If it is gone the task
      // is dead — silently spawning a fresh agent would lose all the context
      // the caller is continuing *from*.
      throw fail(ERROR_CODES.TARGET_LOST, `the worker for task ${taskId} is no longer available`);
    }

    const identity = caller ?? task.caller;
    await this.opts.taskService.transition(taskId, "submitted");
    await this.enqueue(task, message, identity);
    return this.get(taskId);
  }

  async get(taskId: string): Promise<DelegatedTask> {
    const task = await this.opts.tasks.get(taskId);
    if (!task) throw fail(ERROR_CODES.TASK_NOT_FOUND, `unknown task ${taskId}`);
    return task;
  }

  async cancel(taskId: string): Promise<DelegatedTask> {
    const task = await this.get(taskId);
    if (TERMINAL_TASK_STATES.has(task.state)) return task;

    // Always drop anything still queued for this task — that part is ours.
    for (const message of await this.opts.queue.listForTask(taskId)) {
      await this.opts.relay.cancel(message.id).catch(() => {});
    }

    if (task.state === "working") await this.interruptTurn(task);

    this.opts.taskService.forget(taskId);
    return this.opts.taskService.transition(taskId, "canceled", {
      error: {
        code: ERROR_CODES.TASK_CANCELED,
        message: "canceled by the delegating caller",
        retryable: false,
      },
    });
  }

  /**
   * Interrupts a turn we started, by the same identity discipline delivery
   * uses. Typing into a target whose identity no longer matches would interrupt
   * a stranger's work, so a mismatch means we cancel our bookkeeping only and
   * leave the terminal alone.
   */
  private async interruptTurn(task: DelegatedTask): Promise<void> {
    const live = task.liveInstanceId ? await this.opts.liveAgents.get(task.liveInstanceId) : undefined;
    if (!live) return;

    try {
      const info = await this.opts.herdr.agentGet(live.herdrAgentName);
      const snapshot = toSnapshot(info, this.opts.clock);
      const anchorMatches = live.sessionRef
        ? snapshot.sessionRef === live.sessionRef
        : snapshot.terminalId === live.terminalId;

      if (!anchorMatches) {
        this.opts.logger.log("warn", "cancel: identity drifted, leaving the terminal untouched", {
          task_id: task.id,
          instance: live.instanceId,
        });
        return;
      }
      if (snapshot.status !== "working") return;

      await this.opts.herdr.agentSendKeys(live.herdrAgentName, ["esc"]);
    } catch (err) {
      this.opts.logger.log("warn", "cancel: could not interrupt the turn", {
        task_id: task.id,
        error: String(err),
      });
    }
  }

  /**
   * Tears down the pane/process behind a *finished* task, on demand — never
   * automatic (spec: an agent stays alive after completing so it can be
   * inspected or reused; the orchestrator decides when it's really done with
   * it, mirroring how a background subagent stays live until explicitly
   * stopped). Requires `cancel` first if the task is still in flight, so
   * `close` stays a pure teardown verb rather than an implicit interrupt.
   */
  async close(taskId: string): Promise<DelegatedTask> {
    const task = await this.get(taskId);

    if (!TERMINAL_TASK_STATES.has(task.state)) {
      throw fail(
        ERROR_CODES.TASK_NOT_TERMINAL,
        `task ${taskId} is ${task.state}; cancel it first`,
        { state: task.state },
      );
    }

    if (!task.liveInstanceId) return task;

    const others = await this.opts.tasks.listByInstance(task.liveInstanceId);
    const stillActive = others.some((t) => t.id !== task.id && !TERMINAL_TASK_STATES.has(t.state));
    if (stillActive) {
      throw fail(
        ERROR_CODES.INSTANCE_STILL_ACTIVE,
        `the worker for task ${taskId} is still handling another active task`,
        { instance: task.liveInstanceId },
      );
    }

    await this.opts.spawn.release(task.liveInstanceId);
    this.opts.events.emit(EVENTS.spawnReleased, { task_id: task.id, instance_id: task.liveInstanceId });
    return task;
  }

  // -------------------------------------------------------------------------

  private async enqueue(task: DelegatedTask, body: string, from: AgentIdentity): Promise<void> {
    if (!task.liveInstanceId) {
      throw fail(ERROR_CODES.TARGET_LOST, `task ${task.id} has no target instance`);
    }
    const now = this.opts.clock.nowIso();
    const message: RelayMessage = {
      id: this.opts.ids.messageId(),
      taskId: task.id,
      targetInstanceId: task.liveInstanceId,
      from,
      to: task.target,
      body,
      state: "QUEUED",
      attempt: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(this.opts.clock.now().getTime() + this.opts.config.relay.messageTtlMs).toISOString(),
    };
    await this.opts.relay.enqueue(message);
    await this.opts.tasks.update(task.id, { lastRelayMessageId: message.id });
  }

  private async resolveDescriptor(name: string): Promise<AgentDescriptor> {
    const descriptor = await this.opts.catalog.get(name);
    if (!descriptor) {
      throw fail(ERROR_CODES.AGENT_NOT_FOUND, `no agent named "${name}" in the current catalog`, {
        agent: name,
      });
    }
    if (descriptor.available) return descriptor;

    const code =
      descriptor.descriptorKind === "custom"
        ? ERROR_CODES.CUSTOM_AGENT_RUNTIME_UNAVAILABLE
        : ERROR_CODES.AGENT_NOT_LAUNCHABLE;
    throw fail(code, descriptor.unavailableReason ?? `"${name}" is not launchable`, {
      agent: name,
      runtime: descriptor.runtimeKind,
    });
  }

  private resolveCwd(requested?: string): string {
    const cwd = requested ?? this.opts.callerContext().cwd ?? process.cwd();
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw fail(ERROR_CODES.INVALID_CWD, `cwd is not a directory: ${cwd}`, { cwd });
    }
    return cwd;
  }

  private resolveVisibility(req: DelegateRequest, descriptor: AgentDescriptor): Visibility {
    return req.visibility ?? descriptor.profile?.visibility ?? this.opts.config.defaults.visibility;
  }

  /** Spec §19: explicit request > custom profile default > runtime native default. */
  private resolveModel(req: DelegateRequest, descriptor: AgentDescriptor): string | undefined {
    return req.model ?? descriptor.profile?.model;
  }

  /**
   * Spec §33: a custom profile's instructions are merged with the task so the
   * caller never needs to know which runtime implements the profile. The
   * instructions lead, because they are the profile's standing brief.
   */
  private composeBody(descriptor: AgentDescriptor, message: string): string {
    const instructions = descriptor.profile?.instructions?.trim();
    if (!instructions) return message;
    return `${instructions}\n\n---\n\n${message}`;
  }
}

export { SYSTEM_IDENTITY };
