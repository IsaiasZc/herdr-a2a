# Herdr contract used by herdr-a2a

This document records the behavior of Herdr that `herdr-a2a` relies on. It is a
behavioral contract, not a replacement for Herdr's own documentation. Re-run
`scripts/capture-contract.mjs` to refresh captured fixtures when Herdr changes.

## 1. Transport

Newline-delimited JSON over a local socket. No length framing, no HTTP: Unix
domain sockets on Linux/macOS and Windows named pipes on Windows. The raw Node
client maps Herdr's Windows marker path from `HERDR_SOCKET_PATH` into Node's
`\\.\pipe\...` namespace before connecting.

Request:

```json
{"id":"req-1","method":"ping","params":{}}
```

Response:

```json
{"id":"req-1","result":{"type":"pong","protocol":20}}
```

The project requires protocol 20. Each normal request uses a fresh connection.
Event subscriptions use their own long-lived connection.

## 2. Session and pane identity

Pane IDs are not durable worker identities: panes can close and IDs can later be
reused. The gateway therefore tracks the agent session reported by Herdr and
revalidates it before sending follow-up work.

## 3. Discovery

`server.agent_manifests` is the source of truth for installed/known agent
runtimes. Runtime availability is dynamic and must not be hardcoded to agent
names such as Codex or Claude.

## 4. Process state

`pane.process_info` exposes the current process state needed for preflight and
runtime checks. A pane that exists is not automatically a usable agent pane.

## 5. Agent startup and prompting

`agent.start` launches a runtime into a target pane and has its own bounded wait.
`agent.prompt` delivers text to a recognized agent. `agent.wait` waits for state
transitions and can legitimately hold a request connection for several minutes.

## 6. Layout ownership

Herdr owns panes, tabs, workspaces, process startup, and terminal layout. The
gateway asks Herdr to create/place workers rather than starting terminal
emulators or managing PTYs directly.

## 7. Events

`events.subscribe` establishes a dedicated event stream. Requests must not be
sent on the subscription connection.

## 8. Test isolation

Integration tests create a named headless Herdr session and address only that
session. They do not stop or mutate an operator's live/default session.

## 9. Error handling

Herdr API errors are preserved as first-class error information where callers
need to branch on them. Connection failures are reported separately from API
rejections.

## 10. Plugin lifecycle

The gateway is registered as a Herdr plugin so Herdr owns its process lifecycle.
The manifest requires Herdr 0.8.2 or later, the first version this project
supports consistently across Linux, macOS, and native Windows. Herdr's Windows
transport is a named pipe, while Unix platforms use Unix-domain sockets.

A linked plugin registration is global to the current user. Installers therefore
compare `plugin_root` with the current checkout before unlinking or replacing a
registration with the same plugin ID.

The manifest shape relied on by this project is:

```toml
id = "herdr-a2a"
name = "herdr-a2a"
version = "0.0.2"
min_herdr_version = "0.8.2"
platforms = ["linux", "macos", "windows"]
```

`startup`, `actions`, `events`, `panes`, `link_handlers` and `build` are arrays
of tables. The startup command executes with the plugin root as its working
directory and receives the Herdr session environment, including
`HERDR_SOCKET_PATH`, `HERDR_SESSION`, `HERDR_PLUGIN_ROOT`, and
`HERDR_PLUGIN_STATE_DIR`.

The startup hook fires at server boot. Linking a plugin into an already-running
session does not retroactively run the hook, so the installers start the gateway
for the current session after linking. A later Herdr startup owns subsequent
gateway lifecycle.
