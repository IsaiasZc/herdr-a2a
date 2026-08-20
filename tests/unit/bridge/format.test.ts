import { Role, TaskState, type Task } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";

import { exitCodeForTask, renderTaskText, stateName } from "../../../src/bridge/format.js";

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    contextId: "ctx-1",
    status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: "2026-08-20T00:00:00.000Z" },
    artifacts: [],
    history: [],
    metadata: { target: "codex" },
    ...overrides,
  };
}

describe("stateName", () => {
  it("renders every numeric TaskState as a readable name", () => {
    expect(stateName(TaskState.TASK_STATE_SUBMITTED)).toBe("submitted");
    expect(stateName(TaskState.TASK_STATE_WORKING)).toBe("working");
    expect(stateName(TaskState.TASK_STATE_COMPLETED)).toBe("completed");
    expect(stateName(TaskState.TASK_STATE_FAILED)).toBe("failed");
    expect(stateName(TaskState.TASK_STATE_CANCELED)).toBe("canceled");
    expect(stateName(TaskState.TASK_STATE_INPUT_REQUIRED)).toBe("input-required");
    expect(stateName(TaskState.TASK_STATE_REJECTED)).toBe("rejected");
    expect(stateName(TaskState.TASK_STATE_AUTH_REQUIRED)).toBe("auth-required");
  });

  it("never leaks a bare number for an unrecognized state", () => {
    expect(stateName(99)).toBe("unknown(99)");
  });
});

describe("renderTaskText", () => {
  it("never prints the raw numeric state", () => {
    const rendered = renderTaskText(baseTask({ status: { state: TaskState.TASK_STATE_INPUT_REQUIRED, message: undefined, timestamp: "t" } }));
    expect(rendered).toContain("state: input-required");
    expect(rendered).not.toMatch(/state: \d/);
  });

  it("shows the pending question for input-required", () => {
    const task = baseTask({
      status: {
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        timestamp: "t",
        message: {
          messageId: "m1",
          contextId: "ctx-1",
          taskId: "task-1",
          role: Role.ROLE_AGENT,
          parts: [{ content: { $case: "text", value: "Which branch?" }, metadata: undefined, filename: "", mediaType: "text/plain" }],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        },
      },
    });
    expect(renderTaskText(task)).toContain("question: Which branch?");
  });

  it("shows the error code and message when metadata carries one", () => {
    const task = baseTask({
      status: { state: TaskState.TASK_STATE_FAILED, message: undefined, timestamp: "t" },
      metadata: { target: "codex", error: { code: "TASK_FAILED", message: "boom" } },
    });
    expect(renderTaskText(task)).toContain("error: TASK_FAILED: boom");
  });

  it("shows the result text from the first artifact when completed", () => {
    const task = baseTask({
      status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: "t" },
      artifacts: [
        {
          artifactId: "a1",
          name: "result",
          description: "",
          parts: [{ content: { $case: "text", value: "All good." }, metadata: undefined, filename: "", mediaType: "text/plain" }],
          metadata: undefined,
          extensions: [],
        },
      ],
    });
    expect(renderTaskText(task)).toContain("result: All good.");
  });
});

describe("exitCodeForTask", () => {
  it("completed exits 0", () => {
    expect(exitCodeForTask(baseTask({ status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: "t" } }))).toBe(0);
  });

  it("failed exits 1", () => {
    expect(exitCodeForTask(baseTask({ status: { state: TaskState.TASK_STATE_FAILED, message: undefined, timestamp: "t" } }))).toBe(1);
  });

  it("rejected exits 1", () => {
    expect(exitCodeForTask(baseTask({ status: { state: TaskState.TASK_STATE_REJECTED, message: undefined, timestamp: "t" } }))).toBe(1);
  });

  it("input-required exits 0 (it is actionable, not a failure)", () => {
    expect(exitCodeForTask(baseTask({ status: { state: TaskState.TASK_STATE_INPUT_REQUIRED, message: undefined, timestamp: "t" } }))).toBe(0);
  });
});
