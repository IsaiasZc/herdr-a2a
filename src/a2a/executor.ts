import { AgentEvent, STATE_HEADERS_KEY, type RequestHeaders } from "@a2a-js/sdk/server";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { TaskState, type Message } from "@a2a-js/sdk";

import { readCallerContextHeaders } from "./caller-context.js";
import { DelegationFailure, ERROR_CODES, toDelegationError } from "../core/errors.js";
import { TERMINAL_TASK_STATES, type DelegatedTask } from "../core/model.js";
import type { AppConfig, DelegationService, Logger } from "../core/ports.js";
import type { DelegatedTaskService } from "../core/task-service.js";
import { parseExecutionOptions } from "./execution-options.js";
import { agentMessage, toA2aState, toA2aTask } from "./task-mapper.js";

export interface DelegatingExecutorOptions {
  /** The logical agent this endpoint is bound to. One executor per card. */
  agentName: string;
  delegation: DelegationService;
  taskService: DelegatedTaskService;
  config: AppConfig;
  logger: Logger;
}

/**
 * Bridges one virtual Agent Card's endpoint onto the delegation service.
 *
 * The executor holds the caller's stream open and republishes our task state as
 * A2A status updates, which is what removes the caller's polling loop
 * (spec §53: zero manual polling on the happy path).
 */
export class DelegatingExecutor implements AgentExecutor {
  constructor(private readonly opts: DelegatingExecutorOptions) {}

  execute = async (ctx: RequestContext, bus: ExecutionEventBus): Promise<void> => {
    const text = extractText(ctx.userMessage);
    if (!text.trim()) {
      // Nothing to delegate. Answer as a message rather than minting a task, so
      // an empty prompt does not create a worker.
      bus.publish(AgentEvent.message(errorMessage(ctx, "The message contained no text to delegate.")));
      bus.finished();
      return;
    }

    let task: DelegatedTask;
    try {
      const options = parseExecutionOptions(ctx.userMessage.metadata ?? undefined);
      const headers = ctx.context.state?.get(STATE_HEADERS_KEY) as RequestHeaders | undefined;
      const callerContext = readCallerContextHeaders(headers);

      task = ctx.task
        ? // A continuation: same task, same worker, same context (spec §32).
          await this.opts.delegation.continueTask(ctx.task.id, text)
        : await this.opts.delegation.delegate({
            agentName: this.opts.agentName,
            message: text,
            taskId: ctx.taskId,
            contextId: ctx.contextId,
            ...(options.model ? { model: options.model } : {}),
            ...(options.visibility ? { visibility: options.visibility } : {}),
            ...callerContext,
          });
    } catch (err) {
      const failure = toDelegationError(err, ERROR_CODES.TASK_FAILED);
      this.opts.logger.log("warn", "delegation rejected", {
        agent: this.opts.agentName,
        code: failure.code,
      });
      // A rejection before a worker exists is not a failed task — it is a
      // refused request, so report it as a message and leave no task behind.
      bus.publish(AgentEvent.message(errorMessage(ctx, `${failure.code}: ${failure.message}`)));
      bus.finished();
      return;
    }

    bus.publish(AgentEvent.task(toA2aTask(task)));

    if (TERMINAL_TASK_STATES.has(task.state)) {
      bus.finished();
      return;
    }

    await this.streamUntilSettled(task.id, bus);
  };

  /**
   * Republishes state changes until the task reaches a terminal or interrupted
   * state. `input-required` / `auth-required` end the stream on purpose: the
   * caller has to answer, and holding the connection open would just make the
   * question invisible until it times out.
   */
  private async streamUntilSettled(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const settle = new Promise<void>((resolve) => {
      const unsubscribe = this.opts.taskService.onChange((updated) => {
        if (updated.id !== taskId) return;

        const a2a = toA2aTask(updated);
        for (const artifact of a2a.artifacts) {
          bus.publish(
            AgentEvent.artifactUpdate({
              taskId: updated.id,
              contextId: a2a.contextId,
              artifact,
              append: false,
              lastChunk: true,
              metadata: undefined,
            }),
          );
        }

        const interrupted = updated.state === "input-required" || updated.state === "auth-required";
        const final = interrupted || TERMINAL_TASK_STATES.has(updated.state);

        // A2A v1.0 has no `final` flag on a status update: finality is the
        // terminal state plus `bus.finished()`. Interrupted states are final
        // for this stream even though the task can still be continued.
        bus.publish(
          AgentEvent.statusUpdate({
            taskId: updated.id,
            contextId: a2a.contextId,
            status: {
              state: toA2aState(updated.state),
              message: a2a.status?.message,
              timestamp: updated.updatedAt,
            },
            metadata: undefined,
          }),
        );

        if (!final) return;
        unsubscribe();
        resolve();
      });

      // Backstop: a worker that never settles must not pin the stream forever.
      const timer = setTimeout(
        () => {
          unsubscribe();
          resolve();
        },
        this.opts.config.relay.settleTimeoutMs + this.opts.config.relay.turnStartTimeoutMs,
      );
      timer.unref?.();
    });

    await settle;
    bus.finished();
  }

  cancelTask = async (taskId: string, bus: ExecutionEventBus): Promise<void> => {
    try {
      const canceled = await this.opts.delegation.cancel(taskId);
      const a2a = toA2aTask(canceled);
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId: a2a.contextId,
          status: {
            state: TaskState.TASK_STATE_CANCELED,
            message: undefined,
            timestamp: canceled.updatedAt,
          },
          metadata: undefined,
        }),
      );
    } catch (err) {
      const failure = err instanceof DelegationFailure ? err.toJSON() : toDelegationError(err);
      this.opts.logger.log("warn", "cancel failed", { task_id: taskId, code: failure.code });
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId: taskId,
          status: {
            state: TaskState.TASK_STATE_FAILED,
            message: undefined,
            timestamp: new Date().toISOString(),
          },
          metadata: undefined,
        }),
      );
    }
    bus.finished();
  };
}

/** Concatenates every text part; other part kinds are ignored for now. */
function extractText(message: Message): string {
  return message.parts
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .filter(Boolean)
    .join("\n");
}

function errorMessage(ctx: RequestContext, text: string): Message {
  return agentMessage(
    {
      id: ctx.taskId,
      contextId: ctx.contextId,
      updatedAt: new Date().toISOString(),
    } as DelegatedTask,
    text,
  );
}
