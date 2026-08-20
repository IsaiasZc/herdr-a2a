# Implementation brief — read this before writing code

## What this repo is

An A2A v1.0 delegation layer that makes an external coding agent running under
**Herdr** feel about as simple to delegate to as a native subagent. Herdr owns
terminals, panes, agent detection and lifecycle state. We own delegation
semantics, reliable delivery, task lifecycle and the A2A surface.

Read in this order:

1. `herdr-a2a-delegation-layer-final.md` — the product spec. Section numbers in
   code comments refer to it.
2. `docs/herdr-contract.md` — what the **installed** Herdr 0.8.0 actually does.
   This supersedes anything the spec guesses about Herdr.
3. `src/core/model.ts`, `src/core/ports.ts`, `src/core/errors.ts`,
   `src/herdr/types.ts` — **frozen contracts**. Implement against them.

## Hard rules

- **Never hardcode a list of agent kinds.** Three live sources, layered — see
  `docs/herdr-contract.md` §6. A committed `["claude","codex",...]` array is a
  failed acceptance criterion (spec §55.1).
- **Do not change `src/core/*.ts` or `src/herdr/types.ts`.** They are shared with
  modules being written in parallel. If you genuinely need a change, note it in
  your final report instead of editing.
- **Only touch the files your package owns.** Other packages are being written
  concurrently in the same working tree.
- **Never widen the caller's surface.** Callers get `discover / delegate /
  continue / get / cancel`. Pane ids, split directions, CLI flags and retry
  recipes stay internal.
- **Bounded everything.** No unbounded retries, no polling loops without a
  deadline, no LLM-in-the-loop recovery.
- `idle != completed`. See `docs/herdr-contract.md` §4.

## Conventions

- TypeScript, ESM, Node 20+. `"type": "module"`, `moduleResolution: NodeNext`
  → **relative imports must end in `.js`** even though the source is `.ts`.
- `tsconfig.json` is strict, plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. That second one matters: write
  `...(x === undefined ? {} : { x })` rather than `{ x: undefined }`.
- Errors: throw `fail(ERROR_CODES.X, msg, details)` from `src/core/errors.ts`.
  Never throw bare strings or invent new codes outside that file.
- Time and ids come from `Clock` / `IdGenerator` (`src/core/runtime-support.ts`),
  never `Date.now()` or `crypto` directly — tests inject fakes.
- Logging goes through the injected `Logger`; domain events through `EventSink`
  with names from `EVENTS` in `src/observability/events.ts`.
- Constructor-inject every dependency as an interface. No module-level
  singletons, no service locators.
- Comment the *why*, not the *what*, and only where a reader would otherwise
  ask. Cite spec sections for non-obvious policy.

## Testing

- `vitest`. Unit tests go in `tests/unit/<your-module>/*.test.ts`.
- Unit tests must not need a live Herdr. Fake the `HerdrClient` interface.
- Fixtures captured from the real Herdr live in `tests/fixtures/herdr/`:
  `schema.json`, `schema-methods.json`, `session-snapshot.json`,
  `agent-manifests.json`. Prefer these over invented data.
- Verify with `npx tsc -p tsconfig.json --noEmit` and
  `npx vitest run tests/unit/<your-module>`.
- Typecheck will report errors from *other* packages still being written.
  Only fix errors in files your package owns.

## The two ideas most easily got wrong

**1. Delivery is not a boolean.** `agent.prompt` accepting text proves the
terminal took bytes, nothing more. The staged lifecycle is
`QUEUED → DELIVERING → DELIVERED → TURN_STARTED → SETTLED`, and `TURN_STARTED`
is proved by `AgentInfo.state_change_seq` advancing past the value captured
immediately before the prompt, *with* status `working`. A `working` status at an
unchanged seq is the previous turn.

**2. Identity is not a pane id.** Panes get recycled and their occupants get
replaced. Pin `agent_session.value` at spawn and re-verify it before every
delivery, so a queued message can never land in a stranger's terminal
(spec §40).
