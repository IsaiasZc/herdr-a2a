import type { ListTasksRequest, ListTasksResponse, Task } from "@a2a-js/sdk";
import { TaskState } from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore as A2ATaskStore } from "@a2a-js/sdk/server";

import type { DelegatedTask, PublicTaskState } from "../core/model.js";
import type { TaskStore } from "../core/ports.js";
import { toA2aTask } from "./task-mapper.js";

/**
 * Bridges the SDK's protocol-facing `TaskStore` onto our durable SQLite store.
 *
 * The SDK's `InMemoryTaskStore` is scoped to whichever request handler holds
 * it, and this gateway builds one handler per virtual Agent Card. Using it
 * would mean two things a caller can feel:
 *
 * 1. `tasks/get` only recognizes ids created through the *same* endpoint, so a
 *    client holding a task id has to guess which agent to ask — the delegation
 *    surface is meant to be `get(taskId)`, not `get(agent, taskId)`.
 * 2. Nothing survives a gateway restart, even though the task row does.
 *
 * One shared instance of this store across every endpoint fixes both: any
 * endpoint can resolve any task, and the answer comes from the durable record
 * (spec §26 — durable task state outside the LLM context).
 *
 * Writes are intentionally a no-op. The A2A layer is a *projection* of our
 * task; letting the protocol layer write back would give one task two owners
 * and two chances to disagree about its state.
 */
export class DurableA2ATaskStore implements A2ATaskStore {
  constructor(private readonly tasks: TaskStore) {}

  async save(_task: Task, _context: ServerCallContext): Promise<void> {
    // No-op by design; see the class comment. The delegation and task services
    // are the only writers.
  }

  async load(taskId: string, _context: ServerCallContext): Promise<Task | undefined> {
    const task = await this.tasks.get(taskId);
    return task ? toA2aTask(task) : undefined;
  }

  async list(params: ListTasksRequest, _context: ServerCallContext): Promise<ListTasksResponse> {
    const source: DelegatedTask[] = params.contextId
      ? await this.tasks.listByContext(params.contextId)
      : await this.tasks.listActive();

    const wanted = params.status ? publicStateFor(params.status) : undefined;
    const filtered = wanted ? source.filter((t) => t.state === wanted) : source;

    // `pageSize` is clamped the way the protocol describes; a local gateway
    // never has enough tasks for real pagination, so there is no next page.
    const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 100);

    const page = filtered.slice(0, pageSize);
    return {
      tasks: page.map(toA2aTask),
      nextPageToken: "",
      pageSize: page.length,
      totalSize: filtered.length,
    };
  }
}

const STATE_BY_A2A: Partial<Record<TaskState, PublicTaskState>> = {
  [TaskState.TASK_STATE_SUBMITTED]: "submitted",
  [TaskState.TASK_STATE_WORKING]: "working",
  [TaskState.TASK_STATE_INPUT_REQUIRED]: "input-required",
  [TaskState.TASK_STATE_AUTH_REQUIRED]: "auth-required",
  [TaskState.TASK_STATE_COMPLETED]: "completed",
  [TaskState.TASK_STATE_FAILED]: "failed",
  [TaskState.TASK_STATE_CANCELED]: "canceled",
  [TaskState.TASK_STATE_REJECTED]: "rejected",
};

function publicStateFor(state: TaskState): PublicTaskState | undefined {
  return STATE_BY_A2A[state];
}
