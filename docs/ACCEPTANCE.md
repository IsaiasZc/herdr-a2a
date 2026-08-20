# Acceptance criteria — §55 of the build spec

Evidence levels, used honestly below:

- **live** — observed against the operator's real Herdr 0.8.0 session
- **integration** — asserted by `npm run test:integration` against a real, isolated Herdr
- **unit** — asserted by `npm test` with a faked `HerdrClient`
- **implemented** — code exists and typechecks, but no test yet proves it

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | No base-agent list is hardcoded | ✅ | unit — a guard test greps `src/catalog/` for a multi-kind literal and fails if one appears; a repo-wide grep for kind names in `src/` returns nothing |
| 2 | Base agents derived from the active Herdr environment | ✅ | live — 21 kinds discovered from the installed binary's usage text, 19 detection manifests, 16 integrations, 9 launchable |
| 3 | Custom agents are optional profiles layered on top | ✅ | unit — profiles resolve against discovered runtimes; a missing runtime yields `CUSTOM_AGENT_RUNTIME_UNAVAILABLE`; a name colliding with a base kind is an error, never a shadow |
| 4 | Caller can delegate without knowing Herdr CLI primitives | ✅ | live — `herdr-a2a delegate opencode "…"`, one command |
| 5 | Caller does not choose pane ids | ✅ | unit — a guard test asserts `src/bridge/` contains no occurrence of "pane" |
| 6 | Caller does not choose split direction | ✅ | same guard test ("split") |
| 7 | Caller does not discover runtime flags interactively | ✅ | unit — the default adapter throws `MODEL_UNSUPPORTED` rather than guessing a flag; guard test bans `--kind` |
| 8 | Caller implements no wait/retry loops | ✅ | unit — guard test bans "retry" in `src/bridge/`; `--wait` uses the SDK's stream |
| 9 | Visible mode is the default | ✅ | unit (config default) + live |
| 10 | New visible workers use deterministic layout | ✅ | live — first worker split `right` at ratio 0.5; unit — right → down → right, and overflow to a new tab below 50×12 |
| 11 | Spawning does not steal focus | ✅ | live — focus stayed on the caller pane across two spawns; integration — a split leaves `focused_pane_id` unchanged |
| 12 | Headless exists without abandoning Herdr ownership | ✅ | live — created unfocused tab `w5:t3`, left the visible layout untouched, kept focus on the caller, ran the full lifecycle to `completed`; Herdr owns the process throughout |
| 13 | Message delivery is queued and durable in our layer | ✅ | unit — SQLite queue with a monotonic `seq`; FIFO holds for two messages sharing a timestamp |
| 14 | Sender attribution is preserved | ✅ | live — the worker's terminal shows `[peer-agent message] / from: claude:2ae7 / task: <id>` |
| 15 | Delivery and turn-start are distinct states | ✅ | unit — `working` at an unchanged `state_change_seq` does **not** count as a started turn; live — `relay.delivered` then `relay.turn_started` as separate events |
| 16 | Retries are bounded and deterministic | ✅ | unit — exact call counts on the launch and delivery budgets; the relay's fallback probes are a fixed four-step backoff, not a poll |
| 17 | A2A task lifecycle is correctly exposed | ✅ | live — `submitted → working → completed` over the A2A endpoint; 21 virtual Agent Cards served |
| 18 | `input-required` can continue the same task/context | ⚠️ | implemented — `continueTask` reuses the same worker and refuses to spawn a replacement; the blocked→continue path has unit coverage but has not been driven live |
| 19 | Result returned without caller pane scraping | ✅ | live — `state: completed, result: 42` from a single `get`; extraction strips our echoed envelope and quote chrome |
| 20 | Survives/reconciles reconnects without delivering to the wrong occupant | ✅ | unit — identity matches on `agent_session.value` then `terminal_id`, never `pane_id`; a changed session ref fails `TARGET_IDENTITY_CHANGED` and is not retried |
| 21 | The happy path is ~one delegation action | ✅ | live — one command, zero Herdr decisions, zero pane calls, zero polling by the caller |
| 22 | A native Herdr reliable-send can replace our queue transport | ✅ | implemented — `AgentTransport` is the seam; `QueuedPromptTransport` is the only thing that would be swapped |

## Open items

1. **§18 is the one criterion without live evidence.** Driving it needs a worker that asks a
   real question mid-task, which is awkward to force on demand. The classification path
   (auth / trust / permission / question) has unit coverage, and `onBlocked` is wired to move
   the task to `input-required` / `auth-required`.
2. **Terminal-read results still carry a line of runtime chrome.** `opencode` leaves its status
   bar (`▣ Build · … · 2.9s`) in the read. Stripping it generically would be the adapter sprawl
   §17 warns against; it is the honest cost of the third extraction tier, which is why results
   from it are marked `truncated`. A specific adapter is now *justified* if this becomes
   annoying — the bar for adding one is written down in `src/runtimes/adapters/README.md`.
3. **Caller identity is resolved from the gateway process's environment**, not the CLI's. Both
   run in the same pane today, so attribution is correct, but a CLI invoked from a *different*
   pane would be attributed to the gateway's pane. Fixing it properly means passing caller
   context through the A2A request — a small extension, deliberately not invented yet.
4. **Delivery latency to a freshly started TUI agent is several seconds** (8.4s observed). That
   is the target genuinely not being ready, not our overhead: `agent.start` returns before a
   TUI agent reports `interactive_ready` with a stable lifecycle counter.

## Bugs the live run found

All four were found by actually delegating, not by the test suite — worth recording because
each was invisible to unit tests built on fakes.

1. **`agent.start` lost a race with `pane.split` on every visible spawn**, failing with "is not
   an available shell" and burning a launch attempt. Fixed by waiting for
   `foreground_process_group_id === shell_pid` first (`docs/herdr-contract.md` §6b).
2. **A queued message could stall indefinitely.** Delivery was purely event-driven, and Herdr
   sends no further status event once a target goes quiet — so a target that became ready
   before we observed it was never revisited. Observed as a 44-second stall. Fixed with a
   bounded four-step fallback probe.
3. **Tasks never completed.** The relay proved settlement correctly, but nothing carried it to
   the task layer — completion depended on a `pane.updated` event that never arrived. Fixed by
   driving completion from the relay's `SETTLED` transition, which is the component that
   actually holds the pre-prompt sequence baseline.
4. **Retry suppression was dead code.** It compared the entire multi-line envelope against a
   terminal read, which reflow makes impossible to match, so a duplicate prompt could slip
   through. Now matches a single distinctive marker line.
5. **Result isolation worked in a narrow pane and silently failed in a wide one.** The first
   version required the `task: <id>` line to *equal* the marker. In a wide headless tab the TUI
   renders a right-hand column (`Context`, `44,560 tokens`) on the same rows, so equality never
   held and the caller got the whole envelope back as their "result". Now matched as a
   substring, with the quote gutter — not blank lines — used to find where the echoed input
   ends. Both captured shapes are pinned as fixtures in
   `tests/unit/runtimes/isolate-response.test.ts`.

Two of these five (2 and 3) meant delegation never actually completed, and neither was visible
to a unit suite built on fakes. That is the argument for §51's insistence on integration tests
against a real Herdr.

## Bugs the fault-injection suite found

Two more, both in the error taxonomy rather than the happy path:

6. **A vanished target was reported as `DELIVERY_FAILED`, not `TARGET_LOST`.** Herdr's stable
   code for this is `agent_not_found` (verified for both an unknown agent name and a stale pane
   id), which the socket client already surfaces as `details.herdrCode`. The relay now branches
   on it and never retries — the agent is gone, not busy.
7. **A target that vanished *mid-turn* left its task at `working` forever.** The settlement
   observer swallowed every error, so a worker that exited after accepting the prompt was
   indistinguishable from one still thinking. Fixed, and the underlying hole was wider than the
   symptom: a permanently failed delivery had no path to failing its task at all. The `Relay`
   port gained `onFailed(message, error)`, wired in `src/main.ts` so a dead delegation surfaces
   as a failed task instead of an eternal `working`.

A note on how #6 was diagnosed, because it cuts both ways: the fault-injection test modelled
"the agent is gone" as a bare `Error`, which no correct implementation could classify without
string-matching the message — exactly what spec §18 forbids. The fix was to make the *fake*
faithful to the real wire error, not to make the relay guess. `tests/fault-injection/helpers/fakes.ts`
now exports `targetGoneError()` and `promptStalledError()` for that reason.
