# herdr-a2a

An **A2A v1.0 delegation layer** for coding agents running under
[Herdr](https://herdr.dev). It makes delegating work to an external coding agent
feel about as simple as calling a native subagent, while keeping Herdr the
authority over terminals, panes, agent detection and lifecycle state.

```
Caller:  "Have Codex review this change."

System:  resolves Codex from Herdr dynamically
         reuses or launches it
         places it deterministically if visible
         keeps focus on the caller
         waits for actual readiness
         delivers the task reliably
         attributes the sender
         tracks the turn
         surfaces questions
         returns the result
```

The caller never learns which Herdr commands were involved.

## Why this exists

Herdr already solves the runtime problem. What was missing was clean
agent-to-agent delegation. Without it, a calling agent has to reason about which
agents exist, which pane is free, where it should open, what `--kind` to pass,
whether the target is ready, whether the prompt landed, whether to retry, and
whether `idle` really means done.

This layer collapses all of that into `delegate(who, what)`.

## Architecture

```
Caller coding agent  (Claude Code / Codex / OpenCode / …)
        │  A2A v1.0
        ▼
herdr-a2a gateway
   dynamic catalog · task store · reliable relay
   spawn manager · layout manager · reconciliation
        │  Herdr socket API (NDJSON over a unix socket)
        ▼
Herdr  →  the actual coding-agent CLI process
```

Two ideas carry most of the weight.

**Delivery is staged, not boolean.** `agent.prompt` accepting text proves the
terminal took bytes and nothing more. So a message moves through
`QUEUED → DELIVERING → DELIVERED → TURN_STARTED → SETTLED`, and `TURN_STARTED`
is only granted when Herdr's monotonic `state_change_seq` has advanced past the
value captured immediately before the prompt. A `working` status at an unchanged
sequence is the *previous* turn.

**Identity is not a pane id.** Panes get recycled and their occupants replaced.
Every worker's `agent_session.value` is pinned at spawn and re-verified before
each delivery, so a queued message can never land in a stranger's terminal.

## Nothing is hardcoded

There is no committed list of agent kinds anywhere in `src/`, and a unit test
fails the build if one appears. Base runtimes are derived from the installed
Herdr at runtime, from three sources that genuinely disagree:

| Source | Answers |
| --- | --- |
| the binary's own usage text | which kinds Herdr will start |
| `server.agent_manifests` | which kinds have a detection manifest |
| the integration usage text | which kinds have a built-in integration |
| `agent.list` | which kinds are running right now |
| deterministic `PATH` preflight | which are actually launchable |

Those facts stay separate rather than collapsing into one boolean, because
`antigravity-cli` has an integration but is not startable, and `omp` is
startable but has no detection manifest. Custom profiles are the only agents in
our own registry, and they never shadow a discovered runtime.

See [`docs/herdr-contract.md`](docs/herdr-contract.md) for everything that was
verified against the installed Herdr, including the corrections to assumptions
the design started with.

## Usage

Start the gateway inside a Herdr-managed pane:

```bash
npm install
npm run build
node dist/main.js serve          # or: node dist/main.js doctor
```

Then, from any caller:

```bash
herdr-a2a discover
herdr-a2a delegate codex "Review the current diff and report actionable findings"
herdr-a2a get task_1a2b3c
herdr-a2a continue task_1a2b3c "Yes, update the tests too"
herdr-a2a cancel task_1a2b3c
```

Agents with native A2A support skip the CLI entirely: each discovered agent has
its own Agent Card and endpoint at `/a2a/agents/<name>`, so a caller selects a
card and sends a standard A2A message. There is no non-standard `target` field.

`GET /agents` is the local catalog helper — A2A defines no standard way to ask
"what agents are on this machine", so discovery is served here rather than
pretended to be part of the protocol.

Model and placement travel in one small extension,
`urn:herdr:execution-options:v1`, carrying only `model` and `visibility`. Pane
ids, split directions and CLI flags are deliberately not expressible.

## Defaults worth knowing

- **Visible by default**, and spawning never steals focus. Watching the worker
  is part of Herdr's value.
- **Deterministic layout**: `RIGHT → DOWN → RIGHT → DOWN`, per tab, under a lock.
  A split that would leave a pane under 50×12 overflows to a new unfocused tab.
- **Headless** means "does not mutate the visible layout"; Herdr still owns the
  process.
- **Bounded recovery**: 2 launch attempts, 2 delivery attempts, and every retry
  records cause / attempt / action / outcome. No LLM is in the recovery path.
- **Permission, auth and trust prompts are never answered.** They are classified
  and surfaced as `input-required` / `auth-required`, and a peer's text can never
  masquerade as human authority.

## Repository layout

```
src/
├── a2a/          A2A gateway: virtual Agent Cards, executor, task mapping
├── catalog/      dynamic discovery, launchability, custom profiles
├── core/         domain model, ports, delegation + task services, doctor
├── herdr/        socket client, session cache, schema loader
├── layout/       deterministic placement and guardrails
├── relay/        the reliable relay — queue, deliverability, turn proof
├── runtimes/     thin adapters; the default one handles nearly everything
├── spawn/        preflight, reuse policy, spawn manager, naming
├── persistence/  SQLite schema, migrations, repositories
└── bridge/       thin CLI facade and the caller skill

docs/herdr-contract.md        what the installed Herdr actually does
docs/IMPLEMENTATION-BRIEF.md  ground rules the implementation follows
scripts/capture-contract.mjs  refreshes the fixtures after a Herdr upgrade
```

## Tests

```bash
npm test                       # unit tests, no live Herdr required
npx vitest run tests/integration   # needs a running Herdr
```

Unit tests fake the `HerdrClient` interface and read fixtures captured from the
real Herdr in `tests/fixtures/herdr/`. Integration tests select a testable
runtime *from the catalog* rather than assuming `codex` or `claude` is installed.
