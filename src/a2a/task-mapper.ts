import { Role, TaskState, type Artifact, type Message, type Part, type Task, type TaskStatus } from "@a2a-js/sdk";

import type { DelegatedTask, PublicTaskState } from "../core/model.js";

/**
 * `PublicTaskState` → A2A `TaskState` (spec §13). The mapping is intentionally
 * conservative: nothing here can produce `completed` from a mere `idle`, because
 * the task layer only ever sets `completed` alongside an extracted result.
 */
const STATE_MAP: Record<PublicTaskState, TaskState> = {
  submitted: TaskState.TASK_STATE_SUBMITTED,
  working: TaskState.TASK_STATE_WORKING,
  "input-required": TaskState.TASK_STATE_INPUT_REQUIRED,
  "auth-required": TaskState.TASK_STATE_AUTH_REQUIRED,
  completed: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  canceled: TaskState.TASK_STATE_CANCELED,
  rejected: TaskState.TASK_STATE_REJECTED,
};

export function toA2aState(state: PublicTaskState): TaskState {
  return STATE_MAP[state];
}

export function textPart(value: string): Part {
  return {
    content: { $case: "text", value },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  } as Part;
}

export function agentMessage(task: DelegatedTask, text: string): Message {
  return {
    messageId: `${task.id}-status-${task.updatedAt}`,
    contextId: task.contextId ?? task.id,
    taskId: task.id,
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

/**
 * Chooses the status message a caller sees. Questions and errors are surfaced
 * verbatim so the caller can act on them without reading a pane.
 */
function statusMessage(task: DelegatedTask): Message | undefined {
  if (task.state === "input-required" || task.state === "auth-required") {
    return agentMessage(task, task.question ?? "The target agent is waiting for input.");
  }
  if (task.error) {
    return agentMessage(task, `${task.error.code}: ${task.error.message}`);
  }
  return undefined;
}

export function toA2aTask(task: DelegatedTask): Task {
  const status: TaskStatus = {
    state: toA2aState(task.state),
    message: statusMessage(task),
    timestamp: task.updatedAt,
  };

  const artifacts: Artifact[] = task.result
    ? [
        {
          artifactId: `${task.id}-result`,
          name: task.result.artifactName ?? "result",
          description: describeResultSource(task.result.source, task.result.truncated === true),
          parts: [textPart(task.result.text)],
          metadata: {
            source: task.result.source,
            ...(task.result.truncated === true ? { truncated: true } : {}),
          },
          extensions: [],
        },
      ]
    : [];

  return {
    id: task.id,
    contextId: task.contextId ?? task.id,
    status,
    artifacts,
    history: [],
    metadata: {
      target: task.target.name,
      ...(task.target.runtimeKind ? { runtime: task.target.runtimeKind } : {}),
      ...(task.liveInstanceId ? { instance: task.liveInstanceId } : {}),
      caller: task.caller.name,
      ...(task.error ? { error: task.error } : {}),
    },
  };
}

/**
 * Provenance matters to the caller: a bounded terminal read is weaker evidence
 * than an integration-supplied result, and saying so beats implying parity.
 */
function describeResultSource(source: string, truncated: boolean): string {
  const base =
    source === "terminal-read"
      ? "Read back from the target's terminal output"
      : source === "integration"
        ? "Reported directly by the target's Herdr integration"
        : source === "file-handoff"
          ? "Written to a file by the target and read back"
          : "Extracted from the target's final output";
  return truncated ? `${base} (bounded read; may be incomplete)` : base;
}
