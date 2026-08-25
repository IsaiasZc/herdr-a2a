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

---

## What this saves you

Same instruction, same target — `"Review the current diff and report actionable findings"`,
delegated to Codex.

**With Herdr alone**, the calling agent has to do the orchestration itself, turn by
turn, inside its own context:

1. Discover what agent kinds even exist — `herdr agent` usage text, `server.agent_manifests`
   and the integration list genuinely disagree (21 vs 19 vs 16 kinds), and nothing returns
   "the list of supported kinds".
2. Inspect the layout to find a free pane and decide where to split (`pane.list`,
   `pane.layout` — which ignores unknown params and silently returns the wrong tab).
3. Create the pane (`pane.split`), then babysit the shell race: split returns before the
   pane is an "available shell", and the first `agent.start` after a fresh split failed
   every time in live runs.
4. Start the agent with the right kind and a unique name (`agent.start`), retrying on failure.
5. Deliver the prompt — but it injects immediately with no hold-until-deliverable queue, and
   `wait` tracks lifecycle state, not turns, so `agent_prompt_stalled` is a real outcome.
6. Verify the turn actually started (`state_change_seq`) and the message landed in the right
   session (`agent_session`), not a recycled pane.

That is roughly **8–12 tool calls** before the subagent is working. Every call is a turn:
the tool's JSON result is injected into context, the caller's reasoning about Herdr's
quirks adds tokens on top, and a failed attempt re-injects error text plus a retry.

**With herdr-a2a**, that whole sequence is one command, executed by the gateway outside the
caller's context:

| | Herdr alone (manual) | herdr-a2a |
| --- | --- | --- |
| Tool calls / turns until the subagent is running | 8–12 | **1** |
| Context injected (tool defs + calls + results) | ≈ 12–30k tokens | ≈ 1–2k tokens |
| Herdr knowledge the caller must carry | 91 socket methods, layout geometry, shell race, wait semantics, name rules | **none** |
| Failure modes the caller must handle | race on fresh split, silent wrong-tab layout, prompt into a busy agent, stalled wait, retries | **none** — bounded recovery lives in the gateway |
| Approx. time until the task is running | 30–60s+ of orchestration, retries included | ≈ 10s, measured gateway-side |

Rough numbers, order of magnitude: a single tool result like `agent list` or `pane.layout`
is already hundreds of tokens, and the caller's *reasoning* about Herdr's semantics is
where the rest goes. The caller never accumulates Herdr CLI knowledge in its system prompt
either — the entire surface is five delegation verbs.

---

## Quick start

### Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js ≥ 20** | npm ships with it — the installer uses `npm install` internally |
| **Herdr ≥ 0.8.0**, running | `herdr plugin` support is required; Linux or macOS |
| **A Herdr pane** | run the installer *from inside* a Herdr session so the gateway can start for it |

There is no npm package yet — you install from source.

### 1. Install

```bash
git clone https://github.com/IsaiasZc/herdr-a2a.git
cd herdr-a2a
node scripts/install.mjs
```

Run the installer from inside a Herdr pane. It is idempotent — safe to re-run
after pulling changes. It wires four things, all as links rather than copies,
so editing the repo updates the installation in place:

| What | How |
| --- | --- |
| **Herdr plugin** | `herdr plugin link` this directory. Herdr then starts the gateway whenever Herdr starts — Herdr owns the gateway process, exactly as it owns a worker's |
| **CLI** | `herdr-a2a` symlinked into `~/.local/bin` (or `~/bin`, if that is what you have on `PATH`) |
| **Skill** | symlinked into every agent skills directory found — `~/.claude/skills/`, `~/.codex/skills/`, `~/.config/opencode/skills/` — using each agent's own `<dir>/<name>/SKILL.md` convention |
| **Gateway** | started for the session you are in right now, because Herdr's startup hook only fires at server boot |

### 2. Verify

```bash
node scripts/install.mjs status   # what is wired, what is not
herdr-a2a doctor                  # gateway readiness + agent catalog
herdr-a2a discover                # agents you can delegate to right now
```

You should see the gateway "serving" and at least the agents you have installed
(e.g. `codex`, `claude`, `opencode`).

### 3. Delegate your first task

```bash
herdr-a2a delegate codex "Review the current diff and report actionable findings"
```

This spawns (or reuses) a Codex pane, delivers the message, and prints a task
id. Then:

```bash
herdr-a2a get task_1a2b3c        # status: submitted / working / input-required / completed / failed …
herdr-a2a continue task_1a2b3c "Yes, update the tests too"   # answer a question, same task/context
herdr-a2a cancel task_1a2b3c     # stop a working task
herdr-a2a close task_1a2b3c      # shut down the worker terminal once truly done
```

Add `--wait` to any delegation to block until it settles, streaming updates.
Pass `--model <name>` to request a specific model, or `--headless` to run
without a visible terminal.

---

## Usage

### From the CLI

From any caller, in any Herdr pane:

| Command | What it does |
| --- | --- |
| `herdr-a2a discover` | list agents that can be delegated to right now |
| `herdr-a2a delegate <agent> "<message>"` | launch or reuse the agent and deliver the task |
| `herdr-a2a get <task-id>` | show a task's state, result, pending question or error |
| `herdr-a2a continue <task-id> "<message>"` | answer an `input-required` / `auth-required` task on the same context |
| `herdr-a2a cancel <task-id>` | stop a working task |
| `herdr-a2a close <task-id>` | shut down the terminal behind a finished task |
| `herdr-a2a doctor` | operator diagnostic for the gateway itself |

Common flags: `--model <name>`, `--headless`, `--wait` (block until the task
settles, streaming updates), `--json` (raw structured output), and
`--base-url <url>` to point at a gateway (default: `$HERDR_A2A_URL`, then this
session's discovery file, else `http://127.0.0.1:4319`).

If your message starts with a dash, pass `--` before it:

```bash
herdr-a2a delegate codex -- "-x is text, not a flag"
```

Exit codes: `0` success, `1` the task reported a failure, `2` usage or
connectivity error. `herdr-a2a` without arguments prints full help.

### From a coding agent

Agents that can't be taught a CLI get the **skill** instead — the installer
symlinks it into each agent's skills directory. It teaches exactly four things
(discover, delegate, continue, inspect/cancel) and fits on one screen. If a
skill ever needs to explain pane topology or runtime flags, the abstraction has
failed (spec §54).

With the skill installed, Claude Code, Codex or OpenCode can delegate directly:

```
"Have Codex review this change."
"Ask Claude to draft the migration script."
```

Agents with **native A2A support** skip the CLI entirely: each discovered agent
has its own Agent Card and endpoint at `/a2a/agents/<name>`, so a caller
selects a card and sends a standard A2A message. There is no non-standard
`target` field. `GET /agents` is the local catalog helper — A2A defines no
standard way to ask "what agents are on this machine", so discovery is served
here rather than pretended to be part of the protocol.

Model and placement travel in one small extension, `urn:herdr:execution-options:v1`,
carrying only `model` and `visibility`. Pane ids, split directions and CLI
flags are deliberately not expressible.

---

## How it works

### Architecture

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

### Nothing is hardcoded

There is no committed list of agent kinds anywhere in `src/`, and a unit test
fails the build if one appears. Base runtimes are derived from the installed
Herdr at runtime, from sources that genuinely disagree:

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

### One gateway per Herdr session

The plugin is installed once and every Herdr session starts its own gateway,
each bound to that session's socket on its own ephemeral port. Sessions must
not share one: a gateway talks to exactly one Herdr socket, so a shared gateway
would create panes in the wrong session.

A fixed port would not work either. On this platform a second bind to an
already-held port does **not** fail — Node reports success while every request
goes to the first listener, so the second gateway silently serves nothing. So
the port is ephemeral, and each gateway publishes where it landed:

```
$XDG_RUNTIME_DIR/herdr-a2a/<hash of the Herdr socket path>.json
```

Any agent in the session computes that path from its own `HERDR_SOCKET_PATH` and
finds its gateway. `serve` is idempotent: if a healthy gateway already serves the
session it exits instead of binding a second time.

---

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

---

## Updating

```bash
git pull
node scripts/install.mjs      # re-link and rebuild; safe to re-run any time
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `herdr-a2a: command not found` | the installer picked `~/.local/bin` or `~/bin` — add it to your `PATH`, or call `./bin/herdr-a2a` from the repo |
| `no gateway found for this Herdr session` | the plugin is not linked, or you are not in a Herdr pane. Run `herdr plugin list`, re-run the installer from inside a Herdr session |
| `Cannot reach the herdr-a2a gateway at …` | the gateway is not running. Start it with `node dist/main.js serve`, or pass `--base-url` / set `HERDR_A2A_URL` if it runs elsewhere |
| `discover` shows no agents | check `herdr-a2a doctor` for catalog details — an agent kind may be installed but not launchable on `PATH` |
| Nothing happens after install | the gateway only starts at Herdr boot — restart Herdr, or the installer already started it for the current session |

## Uninstall

```bash
node scripts/install.mjs uninstall   # removes every link; the repo is untouched
```

A gateway started earlier is still running; it exits with its Herdr session.
Stop it immediately with `pkill -f 'dist/main.js serve'`.

---

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

See [`docs/herdr-contract.md`](docs/herdr-contract.md) for everything that was
verified against the installed Herdr, including the corrections to assumptions
the design started with.

## Tests

```bash
npm test                       # unit tests, no live Herdr required
npx vitest run tests/integration   # needs a running Herdr
```

Unit tests fake the `HerdrClient` interface and read fixtures captured from the
real Herdr in `tests/fixtures/herdr/`. Integration tests select a testable
runtime *from the catalog* rather than assuming `codex` or `claude` is installed.
