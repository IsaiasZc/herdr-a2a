# Herdr Contract — validated snapshot

Milestone 0 deliverable. Everything here was read from the **installed** Herdr, not from
documentation. Re-run `scripts/capture-contract.mjs` to refresh.

| Fact | Value |
| --- | --- |
| Binary | `/usr/bin/herdr` |
| Version | `0.8.0` |
| Socket protocol | `20` |
| Schema version | `1` |
| Socket path | `$HERDR_SOCKET_PATH` (`~/.config/herdr/herdr.sock`) |
| Capabilities | `live_handoff`, `detached_server_daemon` |

## 1. Transport

Newline-delimited JSON over a local socket. No length framing, no HTTP: Unix
domain sockets on Linux/macOS and Windows named pipes on Windows. The raw Node
client maps Herdr's Windows marker path from `HERDR_SOCKET_PATH` into Node's
`\\.\pipe\...` namespace before connecting.

Request:

```json
{"id":"<caller-chosen>","method":"<method>","params":{}}
```

Success:

```json
{"id":"<same>","result":{"type":"<result_type>", ...}}
```

Error:

```json
{"id":"<same>","error":{"code":"<stable_code>","message":"..."}}
```

### The socket is request-per-connection

**This is the single most important transport fact, and it is easy to get wrong.** Herdr
answers the *first* frame on a connection and then closes it. Verified against 0.8.0:

- three requests written in one flush → one response, then `ECONNRESET`;
- a second request 300 ms after the first → `EPIPE` / peer close, no second response;
- a request sent on a connection that has already subscribed → `ECONNRESET`.

So there is no multiplexing. Every request opens its own connection, writes one frame, reads
one reply, and the socket dies. A long-lived "client connection" that reuses a socket for
requests fails *intermittently* — it works whenever Node has not yet processed the peer's FIN
and fails when it has, which is the worst possible failure mode.

`src/herdr/socket-client.ts` therefore dials per request and bounds concurrency to avoid fd
exhaustion when many deliveries are in flight.

### Subscriptions own their connection

A subscription connection is the exception: it stays open, but it may carry **only** events.
`events.subscribe` first replies `{"type":"subscription_started"}`, then **backfills current
state** for every matching resource, then streams live changes as unsolicited frames with no
`id`:

```json
{"event":"pane.updated","data":{...}}
```

Backfill is not a change — consumers must treat the first frame per resource as a baseline,
not a transition. Otherwise every subscribe looks like every agent just changed state.

## 2. Caller context

Herdr injects these into every managed pane. Presence of `HERDR_ENV=1` is the gate for
touching the control surface at all.

```
HERDR_ENV=1
HERDR_SOCKET_PATH=/home/example/.config/herdr/herdr.sock
HERDR_BIN_PATH=/usr/bin/herdr
HERDR_WORKSPACE_ID=w5
HERDR_TAB_ID=w5:t1
HERDR_PANE_ID=w5:p1
HERDR_STARTUP_CWD=/home/example
```

## 3. Methods (91 total)

Full list captured in `tests/fixtures/herdr/schema-methods.json`. The ones this project uses:

| Method | Params | Result type |
| --- | --- | --- |
| `ping` | `{}` | `pong` (`version`, `protocol`, `capabilities`) |
| `session.snapshot` | `{}` | `session_snapshot` → `.snapshot` |
| `server.agent_manifests` | `{}` | `agent_manifest_status` → `.manifests[]` |
| `agent.list` | `{}` | `agent_list` → `.agents[]` |
| `agent.get` | `{target}` | `agent_info` → `.agent` |
| `agent.start` | `{name, kind, pane_id, args?, timeout_ms?}` | `agent_started` → `.agent`, `.argv` |
| `agent.prompt` | `{target, text, wait?}` | `agent_prompted` → `.agent` |
| `agent.wait` | `{target, until?, timeout_ms?}` | `agent_info` → `.agent` |
| `agent.read` | `{target, source, lines?, format?, strip_ansi?}` | `pane_read` → `.read` |
| `agent.send_keys` | `{target, keys}` | `ok` |
| `pane.split` | `{direction, target_pane_id?, workspace_id?, cwd?, env?, focus?, ratio?}` | `pane_created` → `.pane` |
| `pane.layout` | `{pane_id?}` | `pane_layout` → `.layout` |
| `pane.get` / `pane.list` | | `pane_info` / `pane_list` |
| `pane.close` | `{pane_id}` | `pane_closed` |
| `tab.create` | `{workspace_id?, cwd?, env?, label?, focus?}` | `tab_created` → `.tab` |
| `events.subscribe` | `{subscriptions[]}` | `subscription_started` |

`timeout_ms` on `agent.start` must be `> 3000` and `<= 300000`. Default startup timeout is 30s.

## 4. Agent status

```
idle | working | blocked | done | unknown
```

Semantics that matter for the delegation layer:

- `idle` — ready for input **and** the tab has been seen in a focused Herdr UI.
- `done` — the same underlying ready state after *unseen* background work finished. Focusing
  the tab or targeting it with a focus command marks it seen; CLI reads do not.
- `blocked` — Herdr recognized an approval/question UI.
- `unknown` — an agent is present but unclassified. **Not** proof of completion.

So `idle`/`done` differ only by seen-ness, and neither proves the delegated task produced its
final semantic result. §13.1 of the spec holds: never map `idle == completed`.

## 5. `AgentInfo` — the fields that do the real work

`agent.get` / `agent.start` / `agent.prompt` all return this shape. Beyond the obvious ids:

| Field | Why it matters here |
| --- | --- |
| `interactive_ready: boolean` | Authoritative readiness. Replaces guessing from status. |
| `launch_pending: boolean` | True while a start is still settling — never deliver into this. |
| `state_change_seq: uint64` | **Monotonic lifecycle counter.** Increments on every observed state change. |
| `revision: uint64` | Monotonic per-pane revision, bumped by any pane update including output. |
| `screen_detection_skipped: boolean` | Signals a direct integration owns state (stronger authority). |
| `state_labels: Record<string,string>` | Integration-supplied detail behind a status. |
| `tokens: Record<string,string>` | Integration-supplied counters. |
| `agent_session: {source, agent, kind: "id"\|"path", value}` | **Stable identity across restarts.** |

### `state_change_seq` is the turn-start primitive

The spec (§11) asks for a DELIVERED → TURN_STARTED distinction and worries about racing on
status polling. `state_change_seq` removes the race: capture it immediately before
`agent.prompt`, and a turn has demonstrably started once the counter has advanced *and* the
status is `working`. A status that reads `working` at an unchanged seq is the *previous* turn.

### `agent_session.value` is the identity anchor

`§40` forbids delivering a queued message to a replacement pane occupant. `agent_session`
gives a durable per-agent identity (a Codex/Claude conversation id) independent of
`pane_id`, `terminal_id`, and Herdr's own name binding. Pin it at spawn and re-verify before
every delivery.

## 6. Agent kinds — dynamic sources

There is **no** socket method that returns "the list of supported kinds": `AgentStartParams.kind`
is a bare `string` in the schema. Three live sources exist, and they disagree, so the catalog
must layer them rather than pick one.

| Source | Content | Count observed |
| --- | --- | --- |
| `herdr agent` (CLI usage text, `kinds:` line) | Kinds the installed binary accepts | 21 |
| `server.agent_manifests` → `.manifests[].agent` | Kinds with a detection manifest loaded | 19 |
| `herdr integration install \| uninstall` (CLI usage text) | Kinds with a built-in integration | 16 |

**Capture caveat, verified against the installed binary:** invoking a command
group with no subcommand (`herdr agent`, `herdr integration`) prints its usage
to **stderr** and exits **2** — a CLI syntax error, per §13. The exit code
therefore carries no signal for discovery, and a reader that only inspects
stdout gets an empty string. `src/catalog/herdr-discovery.ts` searches both
streams and treats an empty kind list — not a non-zero exit — as the failure.

Observed values at capture time:

- CLI kinds (21): `pi claude codex gemini cursor devin agy cline omp mastracode opencode copilot kimi kiro droid amp grok hermes kilo qodercli maki`
- Manifests (19): CLI kinds minus `omp`, `mastracode`
- Integrations (16): `pi omp claude codex copilot devin droid kimi opencode kilo hermes qodercli cursor mastracode antigravity-cli grok`

Note `antigravity-cli` appears **only** as an integration and is not a startable kind — proof
that these three sets must stay separate rather than be unioned into one boolean.

`server.agent_manifests` entries carry provenance worth surfacing:

```json
{
  "agent": "pi",
  "source": "remote:/home/example/.local/state/herdr/agent-detection/remote/pi.toml",
  "source_kind": "remote",
  "active_version": "2026.06.10.1",
  "cached_remote_version": "2026.06.10.1",
  "local_override_shadowing_remote": false,
  "remote_update_result": "current",
  "remote_last_checked_unix": 1787253065
}
```

**Rule for this codebase:** parse the installed binary's usage text for supported kinds, join
with manifests for detection provenance, join with `agent.list` for running instances, and
resolve launchability by deterministic `PATH` preflight. Never commit a kind list.

## 6b. Detecting an available shell

`agent.start` requires an **available shell pane**, and `pane.split` returns as soon as the
pane exists — well before its shell reaches an interactive prompt. In a live run the first
`agent.start` after a split failed every time with:

```
agent target pane w5:p3 is not an available shell
```

burning a launch attempt on an entirely predictable race.

`pane.process_info` makes the precondition testable:

```json
{
  "pane_id": "w5:p4",
  "shell_pid": 1047146,
  "foreground_process_group_id": 1047146,
  "foreground_processes": [
    { "pid": 1047146, "name": "bash", "argv": ["/usr/bin/bash"], "cwd": "…" }
  ]
}
```

The test is exactly `foreground_process_group_id === shell_pid` — the shell itself is in the
foreground, so no command, editor or agent is running. A pane hosting an agent shows a
different pgid (observed: `shell_pid` 187172 vs pgid 706242 for a pane running `claude`).

## 7. `agent.start` semantics

- Requires an **existing available shell pane**: at its interactive prompt, shell in the
  foreground, no foreground command/editor/agent. It never creates, splits, or moves layout.
- Returns only after Herdr detects the expected agent in that same pane and considers it
  ready for interactive input.
- `args` are passed to the agent executable (the CLI spells this `-- <args...>`).
- Agent names must match `[a-z][a-z0-9_-]{0,31}` and be unique among live agents. A name
  follows the pane occupant and is cleared when that agent exits, is released, or is replaced.
- Targets accept a unique live agent name or a pane id currently hosting an agent. **Not**
  terminal ids and **not** bare kind labels.

## 8. `agent.prompt` semantics — and the gap this project fills

`agent.prompt` atomically submits text plus encoded Enter, honoring the pane's live
bracketed-paste mode. `wait` may be embedded in the same request, which removes the
prompt→wait race. Default wait targets the first settled `idle` / `done` / `blocked`.

Two limits remain, and they are exactly the spec's §9 gap:

1. **It injects immediately.** There is no server-side "hold until deliverable" queue, so a
   prompt aimed at a `working` or `blocked` agent still lands. Our layer must own the queue.
2. **The wait tracks lifecycle state, not a turn.** If the agent is already working, the
   completion of the *active* turn satisfies the wait. A prompt sent from a non-working state
   must produce an observed lifecycle change within 5s or Herdr returns
   `agent_prompt_stalled` rather than waiting forever.

`agent_prompt_stalled` is therefore a first-class signal, not a generic failure — it maps
directly onto `TURN_DID_NOT_START`.

## 9. Layout geometry

`pane.layout` returns real terminal cells, which is what §22's guardrails need:

```json
{
  "workspace_id": "w4", "tab_id": "w4:t1", "zoomed": false,
  "area":  { "x": 23, "y": 1, "width": 209, "height": 53 },
  "focused_pane_id": "w4:p2",
  "panes": [ { "pane_id": "w4:p2", "focused": true,
               "rect": { "x": 23, "y": 1, "width": 209, "height": 53 } } ],
  "splits": []
}
```

### `pane.layout` ignores unknown params

`PaneLayoutParams` accepts **only** `pane_id`, and Herdr ignores keys it does not know rather
than rejecting them. Passing a `tab_id` does not fail — it silently returns the *focused*
pane's tab layout, which is a different tab. A tab must be resolved by finding one of its
panes first (`pane.list` filtered on `tab_id`), never by hoping the server honours a `tab_id`.

`SplitDirection` is exactly `right | down` — the spec's RIGHT→DOWN cursor is expressible
with no translation. `pane.split` defaults `focus` to `false`, so no-focus spawning is the
default rather than something we opt into.

Split feasibility is therefore computable before mutating anything: halve the anchor rect on
the intended axis and compare against `min_columns` / `min_rows`.

## 10. Ids

Opaque, stable, workspace-qualified, never reused after close:

```
workspace  w1
tab        w1:t1
pane       w1:p1
```

`pane.move` across workspaces mints a **new** pane id. The response carries
`.move_result.pane.pane_id` and `.move_result.previous_pane_id`; only the moved process's
inherited env keeps resolving the old value, so it is not a valid general target.

## 11. Read sources

Socket enum is snake_case (`recent_unwrapped`); the CLI spells it `recent-unwrapped`.

```
visible | recent | recent_unwrapped | detection
```

`detection` is the plain-text bottom-buffer snapshot Herdr itself classifies against — the
right source for blocker classification. `recent_unwrapped` is the right source for
transcript/result extraction.

**Alternate-screen caveat:** rows that leave the alternate screen never enter host scrollback,
so raising `lines` cannot recover them. When a result cannot be read back, the documented
fallback is to ask the agent to write its full response to a file and reply with the path.
This is the reason §14 ranks terminal reading *third*.

## 12. Subscriptions

Event kinds relevant here:

```
pane.created  pane.closed  pane.updated  pane.exited  pane.moved
pane.agent_detected
pane.agent_status_changed   (pane_id REQUIRED)
pane.scroll_changed         (pane_id required)
pane.output_matched         (pane_id + source + match)
tab.created  tab.closed  layout.updated
workspace.*  worktree.*
```

### There is no global agent-status feed

`pane.agent_status_changed` **requires** `pane_id`. A filterless subscription is rejected with
`invalid request: missing field pane_id`. The JSON schema marks `pane_id` as merely present on
the variant, so this is only discoverable by asking the server — which is exactly why the
contract is captured rather than read off the schema alone.

Consequences:

- `pane.updated` is the only session-wide status signal. It is a firehose: it also fires on
  output, so a status re-read must be gated on `agent_status` or `agent` actually changing.
- The `pane.agent_status_changed` payload carries `pane_id`, `workspace_id`, `agent_status`,
  `agent`, `display_agent`, `title`, `state_labels` — and **not** `state_change_seq`,
  `interactive_ready` or `launch_pending`. Those three are precisely what deliverability and
  turn-start proof need, so any observed change is followed by an authoritative `agent.get`.
- `pane.updated` carries a full `PaneInfo`, which also lacks those three fields. A consumer
  must never let an event-derived record regress them to `undefined`.

## 13. Errors

Stable string codes on stderr for the CLI (exit 1), and in `error.code` on the socket.
CLI syntax errors exit 2. Codes observed / documented so far:

```
agent_prompt_stalled   a prompt from a non-working state produced no lifecycle change in 5s
agent_not_found        the agent target does not exist (unknown name OR stale pane id)
```

`agent_not_found` is load-bearing: it is what distinguishes "the worker is gone" (→
`TARGET_LOST`, never retry) from a transient Herdr error (→ retryable). Verified for both
`agent.get --target no-such-agent` and a pane id that no longer hosts an agent.

Observed shapes worth noting: a validation failure reads
`invalid request: missing field \`pane_id\` at line 1 column 261`, and a command group invoked
with no subcommand exits **2** with its usage on **stderr**.

The rest are discovered empirically; `src/herdr/errors.ts` normalizes unknown codes rather
than enumerating them.

## 14. Consequences for the design

1. **No hardcoded kinds** is satisfiable: three live sources, layered. §5.
2. **Deliverability** = `agent` present ∧ `interactive_ready` ∧ `!launch_pending` ∧ status ∉
   {`working`,`blocked`} ∧ `state_change_seq` unchanged for the stable window. Better than
   the spec's status-only sketch because `interactive_ready` and `launch_pending` are explicit.
3. **TURN_STARTED** = `state_change_seq` advanced past the pre-prompt value ∧ status
   `working`. `agent_prompt_stalled` short-circuits to `TURN_DID_NOT_START`.
4. **SETTLED** = a later `state_change_seq` advance into `idle`/`done`/`blocked`.
5. **Identity discipline** uses `agent_session.value` first, then `terminal_id`, then
   `pane_id` — in that order, so a replacement occupant can never inherit a queued message.
6. **Layout guardrails** are precomputable from `pane.layout` cell geometry; overflow to a
   `focus:false` tab needs no LLM decision.
7. **Reliable relay is still ours to build.** `agent.prompt` gives atomicity of
   text-plus-Enter, not admission control.
8. **Wait for an available shell before starting an agent**, using
   `foreground_process_group_id === shell_pid`. Otherwise every visible spawn wastes a launch
   attempt, and with `maxLaunchAttempts: 2` a slow shell exhausts the budget outright. §6b.
9. **`agent_session` is not universal.** Observed: `codex` and `claude` supply one; `opencode`
   reports `agent_session: null`. So `terminal_id` is a load-bearing fallback for identity, not
   a theoretical one, and any code that assumes a session ref exists will break on a real
   runtime.
10. **Isolated testing is possible.** `herdr --session <name> server` starts a detached
   headless server with its own socket under `~/.config/herdr/sessions/<name>/`, listed by
   `herdr session list --json` and removed with `session stop` then `session delete`. A fresh
   one has exactly one workspace, tab and pane, and a small default geometry (54×23 observed)
   because no client is attached — small enough that a `right` split fails the 50-column
   guardrail, which makes it a good overflow-path test and a poor RIGHT/DOWN test.

---

## 15. Live end-to-end timings

Captured from a real delegation to `opencode` in the operator's own session, after the fixes
in §6b and the relay's bounded fallback probes. Useful as a baseline for regressions.

```
21:31:41.761  spawn.preflight.started
21:31:42.594  spawn.pane_allocated        (+0.8s)  split right, focus unchanged
21:31:42.596  spawn.runtime_starting
21:31:42.802  spawn.runtime_ready         (+0.2s)  no failed attempt
21:31:42.804  relay.queued
21:31:51.175  relay.delivering            (+8.4s)  target became deliverable
21:31:52.083  relay.delivered
21:31:52.084  relay.turn_started                   seq advanced past pre-prompt value
21:31:52.086  task.working
21:31:56.299  relay.settled
21:31:57.234  task.completed              total ≈ 15s
```

The 8.4s between `queued` and `delivering` is the target genuinely not being deliverable yet:
`agent.start` returns when Herdr considers the agent ready for input, but a TUI agent takes
several more seconds to report `interactive_ready` with a stable lifecycle counter. Before the
bounded fallback probes existed, this same gap was **44 seconds** — the queue was purely
event-driven and no further status event arrived after the target went quiet.

A second delegation to the same target reported `spawn.reused` and created no pane.

---

## 16. Plugins — how Herdr can own the gateway

Herdr reads a `herdr-plugin.toml` from a directory registered with
`herdr plugin link <dir>`. Registration is **global**, not per-session: a linked plugin is
visible from every Herdr session, including newly created ones.

Required top-level keys, discovered by letting the parser reject each attempt in turn:

```toml
id = "herdr-a2a"                 # required — the plugin_id
name = "herdr-a2a"               # required
version = "0.0.2"                # required
min_herdr_version = "0.8.0"      # required
platforms = ["linux", "macos", "windows"] # optional; must not be an empty array if present
```

Omitting `platforms` is legal but produces the warning "manifest does not declare platforms;
platform support unknown".

`startup`, `actions`, `events`, `panes`, `link_handlers` and `build` are all **arrays of
tables**, even where the API response reports `startup` as a single object — Herdr filters the
array by platform and resolves one entry:

```toml
[[startup]]
command = ["node", "dist/main.js", "serve"]

[[actions]]
id = "doctor"
title = "herdr-a2a: doctor"
command = ["node", "dist/main.js", "doctor"]
contexts = ["global"]            # global | workspace | tab | pane | selection
```

### Startup execution environment

Verified by having a probe plugin dump its own environment:

- `cwd` is the **plugin root**, so relative commands work and a manifest need not embed
  absolute paths.
- The process receives the full session context — `HERDR_SOCKET_PATH`, `HERDR_ENV`,
  `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_BIN_PATH` — plus
  `HERDR_SESSION`, `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_STATE_DIR`,
  `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_EVENT` and `HERDR_PLUGIN_CONTEXT_JSON`.
- `plugin.log.list` shows the run with `event: "startup"` and a live `status`, so a crash is
  visible rather than silent.

### Two consequences that shaped the gateway

1. **The hook fires at server boot only.** Linking a plugin into an already-running Herdr does
   not start it, so an installer has to start the process itself for the current session.
2. **Herdr does not wait for a clean exit.** On session shutdown the plugin process is killed
   without its `SIGTERM` handler running, so any file it publishes must be treated as
   potentially stale by readers and pruned by the next start — not merely deleted on exit.

### Not available

There is no startup/autostart hook in `config.toml`, and no way to re-trigger plugin startup
on a running server. `server.reload_config` reloads configuration, not plugins.
