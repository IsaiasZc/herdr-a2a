/**
 * Default runtime adapter (spec §17). Herdr already normalizes the
 * executable, detection, readiness and session identity for essentially
 * every kind it supports — this adapter is what "essentially every kind"
 * falls through to, and it stays deliberately thin:
 *
 *  - no invented CLI flags (spec §18: never inspect `--help` and guess);
 *  - no model flag unless a caller-provided recipe exists elsewhere;
 *  - blocker classification is the one place real pattern work is
 *    justified, because auth/trust/permission prompts must never be
 *    auto-answered (spec §29).
 */

import { ERROR_CODES, fail } from "../core/errors.js";
import { formatIdentity } from "../core/model.js";
import type { AgentSnapshot, Blocker, BlockerKind, RelayMessage, TaskResult } from "../core/model.js";
import type { RuntimeAdapter, RuntimeContext, TaskContext } from "../core/ports.js";
import { RECENT_READ_LINES } from "./adapter.js";

// ---------------------------------------------------------------------------
// Blocker classification (spec §29)
// ---------------------------------------------------------------------------

interface BlockerTextPattern {
  kind: Exclude<BlockerKind, "unknown" | "question">;
  pattern: RegExp;
}

/**
 * Ordered, documented, testable. Order matters: `auth` and `trust` are
 * checked before the generic `permission` patterns, because an auth/login
 * prompt frequently also contains an approval verb ("allow access to your
 * account", "grant access") that would otherwise misclassify it as a plain
 * permission prompt. Auth and trust prompts must never be conflated with
 * ordinary permission prompts — all three are equally "never auto-answer"
 * under spec §29, but the caller-facing task state differs (`auth-required`
 * vs `input-required`), so the distinction is load-bearing downstream.
 */
export const BLOCKER_TEXT_PATTERNS: readonly BlockerTextPattern[] = [
  {
    kind: "auth",
    pattern:
      /\b(log[\s-]?in|sign[\s-]?in|authenticate|authentication required|api[\s-]?key|oauth|not logged in|please log in|credentials?\s+(have\s+)?expired|session\s+expired|token\s+expired)\b/i,
  },
  {
    kind: "trust",
    pattern:
      /\b(do you trust|trust this (folder|workspace|directory|repo(sitory)?)|workspace trust|folder trust|first[\s-]run.*(trust|workspace))\b/i,
  },
  {
    kind: "permission",
    pattern:
      /\b(approve|allow(?!ed)|grant|permission[s]?\s+(is\s+|are\s+)?(needed|required)|run this command\??|execute this command\??|apply this (change|edit|diff)\??|\(y\/n\)|\[y\/n\]|press\s+y\s+to|do you want to (proceed|continue|allow))\b/i,
  },
];

/**
 * Herdr's `state_labels` are free-form integration-supplied `Record<string,
 * string>` detail (docs/herdr-contract.md §5) with no documented vocabulary.
 * Rather than ignore them, we treat a label whose *key or value* names one of
 * our own `BlockerKind`s (or an obvious synonym) as authoritative and check
 * it before screen text — a direct integration is stronger authority than
 * scraping the terminal (docs/herdr-contract.md §5, `screen_detection_skipped`).
 */
const STATE_LABEL_BLOCKER_HINTS: Readonly<Record<string, BlockerKind>> = {
  auth: "auth",
  authentication: "auth",
  authentication_required: "auth",
  login: "auth",
  login_required: "auth",
  oauth: "auth",
  trust: "trust",
  workspace_trust: "trust",
  trust_prompt: "trust",
  permission: "permission",
  permission_required: "permission",
  approval: "permission",
  approval_required: "permission",
  question: "question",
  blocked_reason: "unknown",
};

function classifyFromStateLabels(stateLabels: Record<string, string> | undefined): BlockerKind | undefined {
  if (!stateLabels) return undefined;
  for (const [key, value] of Object.entries(stateLabels)) {
    const byValue = STATE_LABEL_BLOCKER_HINTS[value.trim().toLowerCase()];
    if (byValue) return byValue;
    const byKey = STATE_LABEL_BLOCKER_HINTS[key.trim().toLowerCase()];
    if (byKey) return byKey;
  }
  return undefined;
}

function classifyFromText(detectionText: string): Blocker {
  const trimmed = detectionText.trim();
  if (!trimmed) return { kind: "unknown" };
  for (const { kind, pattern } of BLOCKER_TEXT_PATTERNS) {
    if (pattern.test(trimmed)) return { kind, text: trimmed };
  }
  // A generic trailing "?" reads as a semantic question with no known
  // auth/trust/permission shape — still a blocker, just not one of those three.
  if (/\?\s*$/.test(trimmed)) return { kind: "question", text: trimmed };
  return { kind: "unknown", text: trimmed };
}

export function classifyBlocker(snapshot: AgentSnapshot, detectionText: string): Blocker {
  const labelKind = classifyFromStateLabels(snapshot.stateLabels);
  if (labelKind) {
    const trimmed = detectionText.trim();
    return trimmed ? { kind: labelKind, text: trimmed } : { kind: labelKind };
  }
  return classifyFromText(detectionText);
}

// ---------------------------------------------------------------------------
// Peer message envelope (spec §10)
// ---------------------------------------------------------------------------

/**
 * Sender attribution is mandatory: peer text must never be able to
 * masquerade as human input (spec §10, §29).
 */
export function formatPeerMessage(message: RelayMessage): string {
  return `[peer-agent message]\nfrom: ${formatIdentity(message.from)}\ntask: ${message.taskId}\n\n${message.body}`;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const defaultRuntimeAdapter: RuntimeAdapter = {
  kind: "default",

  async validateOptions(ctx: RuntimeContext): Promise<void> {
    if (ctx.model === undefined) return; // spec §19: fall through to the runtime's native default
    // No adapter-specific knowledge here: guessing a model flag is exactly
    // what spec §18 forbids ("launch failed -> inspect --help -> try random
    // flags"). A specific adapter or launch recipe can override this hook.
    throw fail(
      ERROR_CODES.MODEL_UNSUPPORTED,
      `runtime "${ctx.runtimeKind}" has no known model-selection recipe; cannot honor requested model "${ctx.model}"`,
      { runtimeKind: ctx.runtimeKind, model: ctx.model },
    );
  },

  async buildAgentArgs(ctx: RuntimeContext): Promise<string[]> {
    return ctx.profileArgs ?? [];
  },

  classifyBlocker,

  /**
   * Result extraction step 3 of spec §14 (structured result and
   * task-associated output are steps 1-2, owned elsewhere — this adapter
   * only ever reaches step 3, a bounded recent terminal read).
   *
   * `recent_unwrapped` is the source docs/herdr-contract.md §11 recommends
   * for transcript/result extraction (vs. `detection`, which is for blocker
   * classification). The read is capped at `RECENT_READ_LINES` — never the
   * whole scrollback — and always reported `truncated: true` because a
   * terminal read can never prove it captured the complete, final response
   * (the alternate-screen caveat in docs/herdr-contract.md §11 means rows
   * that left the alt screen are unrecoverable no matter how many lines we
   * ask for). An empty read returns `undefined` rather than a lie, so the
   * caller can fall back (e.g. ask the agent to write its answer to a file).
   */
  async extractResult(ctx: TaskContext): Promise<TaskResult | undefined> {
    const target = ctx.live.herdrAgentName || ctx.live.paneId;
    const text = await ctx.herdr.agentRead({
      target,
      source: "recent_unwrapped",
      lines: RECENT_READ_LINES,
      stripAnsi: true,
    });
    const trimmed = isolateResponse(text, ctx.task.id).trim();
    if (!trimmed) return undefined;
    return {
      text: trimmed,
      source: "terminal-read",
      truncated: true,
    };
  },

  formatPeerMessage,
};

/**
 * Narrows a bounded terminal read down to the target's actual response.
 *
 * A raw read contains three things the caller did not ask for: the agent's TUI
 * chrome, an echoed copy of our own envelope, and the prompt text we just sent.
 * Returning all of it hands the caller their own question back and calls it a
 * result.
 *
 * The structural signal is the **quote gutter**. Coding agents render submitted
 * input behind a gutter character (`┃`, `│`, `>`), and their own response
 * without one. So: find the last echo of our `task: <id>` marker, skip the rest
 * of the gutter-quoted block, skip the blank run, and keep what follows.
 *
 * Two things this deliberately does NOT do:
 *
 * - It does not require the marker line to *equal* the marker. A TUI may render
 *   a right-hand column (token counts, context usage) on the same row, so the
 *   marker is matched as a substring. An earlier exact-equality version worked
 *   in a narrow pane and silently failed in a wide one.
 * - It does not trim when the marker is absent. The response may have scrolled
 *   past the captured rows, and discarding an unrecognized layout would risk
 *   throwing away the real answer.
 */
export function isolateResponse(text: string, taskId: string): string {
  const lines = text.split(/\r?\n/);
  const marker = `task: ${taskId}`;

  const markerIndex = lastIndexWhere(lines, (line) => line.includes(marker));
  if (markerIndex < 0) return text;

  let cursor = markerIndex + 1;
  while (cursor < lines.length && hasQuoteGutter(lines[cursor] ?? "")) cursor += 1;
  while (cursor < lines.length && (lines[cursor] ?? "").trim() === "") cursor += 1;

  // An empty tail means the answer is not in the captured rows. Returning
  // nothing lets `extractResult` report RESULT_UNAVAILABLE instead of passing
  // chrome off as a result.
  return lines.slice(cursor).join("\n").trim();
}

/** True when a line is part of a gutter-quoted block, i.e. echoed input. */
function hasQuoteGutter(line: string): boolean {
  return /^\s*[\u2502-\u254b\u2570-\u257f>|]/u.test(line);
}

function lastIndexWhere<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && predicate(item)) return i;
  }
  return -1;
}
