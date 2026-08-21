---
name: herdr-a2a
description: Use this skill to delegate a coding task to another agent running under Herdr (for example codex or claude) when you don't have native A2A support. Covers discovering available agents, delegating a task, answering a follow-up question, checking, canceling, or closing a task.
---

# herdr-a2a

A small command-line client for delegating work to other coding agents through
the herdr-a2a gateway. It speaks A2A underneath; you only need these commands.

## Discover available agents

    herdr-a2a discover

Lists the agents you can delegate to right now, each with an availability
flag. Add `--json` for a machine-readable payload.

## Delegate a task

    herdr-a2a delegate <agent> "<message>"

Example:

    herdr-a2a delegate codex "Review src/payments/charge.ts for a double-charge bug"

Prints a task id and its current state. Add `--model <name>` to request a
specific model, or `--headless` to run without a visible terminal — leave both
off unless asked for. Add `--wait` to block until the task finishes or needs
your input, instead of getting the task id back right away.

## Check on a task

    herdr-a2a get <task-id>

Shows the task's state (`submitted`, `working`, `input-required`,
`completed`, `failed`, ...) and, depending on state, its result, its pending
question, or its error.

## Answer a question

When a task's state is `input-required` (or `auth-required`), reply with:

    herdr-a2a continue <task-id> "<your answer>"

This continues the same task and context — never start a new `delegate` call
for a follow-up.

## Cancel a task

    herdr-a2a cancel <task-id>

## Close a task's worker

    herdr-a2a close <task-id>

Shuts down the terminal process behind a finished task. Agents stay
running after they finish (so you can inspect them or hand them another
task) — call `close` explicitly once you're really done with one. Only
works on a task that isn't still running; `cancel` it first if it's
`working`.

## Notes

- If your message starts with `-`, put `--` before it:
  `herdr-a2a delegate codex -- "-x is text, not a flag"`.
- `herdr-a2a doctor` is an operator diagnostic for the gateway itself — not
  part of delegating work, and not something you need for normal use.
- Exit codes: `0` success, `1` the task/operation failed, `2` usage error or
  the gateway is unreachable.
