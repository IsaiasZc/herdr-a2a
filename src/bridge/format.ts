import { TaskState, type Message, type Part, type SendMessageResult, type Task } from "@a2a-js/sdk";

/**
 * Human-readable rendering for the bridge CLI, plus a `--json` passthrough.
 * Nothing here decides success/failure policy beyond reading the wire's own
 * `TaskState` — that keeps this module a pure presentation layer.
 */

const STATE_NAMES: Record<number, string> = {
  [TaskState.TASK_STATE_UNSPECIFIED]: "unspecified",
  [TaskState.TASK_STATE_SUBMITTED]: "submitted",
  [TaskState.TASK_STATE_WORKING]: "working",
  [TaskState.TASK_STATE_COMPLETED]: "completed",
  [TaskState.TASK_STATE_FAILED]: "failed",
  [TaskState.TASK_STATE_CANCELED]: "canceled",
  [TaskState.TASK_STATE_INPUT_REQUIRED]: "input-required",
  [TaskState.TASK_STATE_REJECTED]: "rejected",
  [TaskState.TASK_STATE_AUTH_REQUIRED]: "auth-required",
};

/** Converts the wire's numeric `TaskState` into its readable name — a caller
 * must never see `state: 6` (spec §55: task lifecycle correctly exposed). */
export function stateName(state: number): string {
  return STATE_NAMES[state] ?? `unknown(${state})`;
}

/** `--json`: print the raw structured payload, nothing else. */
export function renderJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function firstText(parts: readonly Part[] | undefined): string | undefined {
  if (!parts) return undefined;
  for (const part of parts) {
    if (part.content?.$case === "text") return part.content.value;
  }
  return undefined;
}

/** The wire types `Task.status` as possibly `undefined`; every reader here
 * goes through this so "no status yet" reliably means `TASK_STATE_UNSPECIFIED`. */
function taskState(task: Task): TaskState {
  return task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
}

/** `completed` exits 0; a task the agent failed or refused exits 1. Every
 * other state (submitted/working/input-required/auth-required/canceled) is a
 * successful CLI operation that simply reports where the task stands. */
export function exitCodeForTask(task: Task): 0 | 1 {
  const state = taskState(task);
  return state === TaskState.TASK_STATE_FAILED || state === TaskState.TASK_STATE_REJECTED ? 1 : 0;
}

/** id, state, target, then whichever of {error, pending question, result} applies. */
export function renderTaskText(task: Task): string {
  const state = taskState(task);
  const lines: string[] = [`id: ${task.id}`, `state: ${stateName(state)}`];

  const metadata = (task.metadata ?? {}) as Record<string, unknown>;
  const target = typeof metadata["target"] === "string" ? metadata["target"] : "unknown";
  lines.push(`target: ${target}`);

  const error = metadata["error"] as { code?: unknown; message?: unknown } | undefined;
  if (error && typeof error.code === "string" && typeof error.message === "string") {
    lines.push(`error: ${error.code}: ${error.message}`);
    return lines.join("\n");
  }

  if (state === TaskState.TASK_STATE_INPUT_REQUIRED || state === TaskState.TASK_STATE_AUTH_REQUIRED) {
    lines.push(`question: ${firstText(task.status?.message?.parts) ?? "The target agent is waiting for input."}`);
    return lines.join("\n");
  }

  const resultText = firstText(task.artifacts[0]?.parts);
  if (resultText !== undefined) {
    lines.push(`result: ${resultText}`);
    return lines.join("\n");
  }

  const statusText = firstText(task.status?.message?.parts);
  if (statusText !== undefined) lines.push(`message: ${statusText}`);

  return lines.join("\n");
}

/** A bare `Message` result (no task minted — e.g. an empty prompt was refused). */
export function renderMessageText(message: Message): string {
  return firstText(message.parts) ?? "(no text)";
}

export function isTask(result: SendMessageResult): result is Task {
  return (result as Task).status !== undefined;
}

interface DiscoverAgentLike {
  name?: unknown;
  runtime?: unknown;
  available?: unknown;
  unavailableReason?: unknown;
  url?: unknown;
}

/** Renders `GET /agents` — the local catalog helper (spec §7), not an A2A method. */
export function renderDiscoverText(data: unknown): string {
  const obj = (data ?? {}) as { baseUrl?: unknown; agents?: unknown };
  const baseUrl = typeof obj.baseUrl === "string" ? obj.baseUrl : undefined;
  const agents = Array.isArray(obj.agents) ? (obj.agents as DiscoverAgentLike[]) : [];

  const lines: string[] = [];
  if (baseUrl !== undefined) lines.push(`gateway: ${baseUrl}`);
  if (agents.length === 0) {
    lines.push("agents: (none discovered)");
    return lines.join("\n");
  }
  lines.push("agents:");
  for (const agent of agents) {
    const name = typeof agent.name === "string" ? agent.name : "?";
    const runtime = typeof agent.runtime === "string" ? agent.runtime : "?";
    const available = agent.available === true;
    const reason = typeof agent.unavailableReason === "string" ? ` (${agent.unavailableReason})` : "";
    const url = typeof agent.url === "string" ? agent.url : "";
    lines.push(`  ${name}  ${available ? "available" : "unavailable"}${reason}  runtime=${runtime}  ${url}`);
  }
  return lines.join("\n");
}

interface DoctorCheckLike {
  name?: unknown;
  ok?: unknown;
  detail?: unknown;
}

/** Renders `GET /doctor` — an operator/diagnostic report, not part of the delegation surface. */
export function renderDoctorText(data: unknown): string {
  const obj = (data ?? {}) as { ok?: unknown; herdrVersion?: unknown; protocol?: unknown; checks?: unknown };
  const lines: string[] = [`ok: ${obj.ok === true}`];

  if (typeof obj.herdrVersion === "string") {
    const protocol = typeof obj.protocol === "number" ? ` (protocol ${obj.protocol})` : "";
    lines.push(`herdr: ${obj.herdrVersion}${protocol}`);
  }

  const checks = Array.isArray(obj.checks) ? (obj.checks as DoctorCheckLike[]) : [];
  if (checks.length > 0) {
    lines.push("checks:");
    for (const check of checks) {
      const name = typeof check.name === "string" ? check.name : "?";
      const detail = typeof check.detail === "string" ? `: ${check.detail}` : "";
      lines.push(`  [${check.ok === true ? "ok" : "FAIL"}] ${name}${detail}`);
    }
  }
  return lines.join("\n");
}

/** `true` only when the doctor payload explicitly reports `ok: true`. */
export function isDoctorOk(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as Record<string, unknown>)["ok"] === true;
}
