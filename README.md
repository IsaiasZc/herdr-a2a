# herdr-a2a

Delegate work from one coding agent to another without having to manage panes,
processes, or delivery timing yourself.

`herdr-a2a` is a plugin for [Herdr](https://herdr.dev) that exposes the coding
agents available in your current Herdr session—such as Codex, Claude, or
OpenCode—and lets you send them tasks through a small CLI or standard A2A.
Herdr remains responsible for running and arranging the agent terminals.

## Install

### Requirements

- Node.js 20 or later
- Herdr 0.8.0 or later on Linux/macOS, or Herdr 0.8.2 or later on Windows
- A Herdr pane: run the installer from inside a Herdr session

Install from source:

```bash
git clone https://github.com/IsaiasZc/herdr-a2a.git
cd herdr-a2a
node scripts/install.mjs
```

On Windows, from PowerShell:

```powershell
git clone https://github.com/IsaiasZc/herdr-a2a.git
cd herdr-a2a
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

The Windows installer uses only your user profile: it creates a `herdr-a2a.cmd`
launcher under `%LOCALAPPDATA%\herdr-a2a\bin`, adds that directory to your user
`PATH`, and uses directory junctions for agent skills. Open a new terminal after
installation. Herdr uses a Windows named pipe for `HERDR_SOCKET_PATH`; the
gateway maps it to Node's named-pipe namespace automatically.

The installer is safe to run again. It links the Herdr plugin, installs the
`herdr-a2a` command on your `PATH`, and makes the delegation skill available to
installed coding agents. It also starts the gateway for the current session.

Check that everything is ready:

```bash
node scripts/install.mjs status
herdr-a2a doctor
herdr-a2a discover
```

On Windows, use the same installer with `status`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 status
herdr-a2a doctor
herdr-a2a discover
```

`discover` should list the agents that can be delegated to in this session.

## Delegate your first task

```bash
herdr-a2a delegate codex "Review the current diff and report actionable findings"
```

The command starts or reuses a Codex worker, sends it the task, and prints a
task ID. Use that ID to follow up:

```bash
herdr-a2a get task_1a2b3c
herdr-a2a continue task_1a2b3c "Yes, update the tests too"
herdr-a2a cancel task_1a2b3c
herdr-a2a close task_1a2b3c
```

Add `--wait` to stream updates until the task settles. `--model <name>` requests
a model, and `--headless` runs without changing the visible layout.

## Everyday usage

| Command | Description |
| --- | --- |
| `herdr-a2a discover` | List agents available to delegate to now. |
| `herdr-a2a delegate <agent> "<task>"` | Start or reuse an agent and send it a task. |
| `herdr-a2a get <task-id>` | Show status, result, pending input, or an error. |
| `herdr-a2a continue <task-id> "<message>"` | Reply to a task while keeping its context. |
| `herdr-a2a cancel <task-id>` | Stop a task that is still working. |
| `herdr-a2a close <task-id>` | Close the worker terminal after the task has finished. |
| `herdr-a2a doctor` | Diagnose gateway and agent-discovery issues. |

Useful flags: `--wait`, `--model <name>`, `--headless`, `--json`, and
`--base-url <url>`. Run `herdr-a2a` without arguments for complete help.

If the task text begins with a dash, separate it from options with `--`:

```bash
herdr-a2a delegate codex -- "-x is text, not a flag"
```

### From another coding agent

The installer also links a compact skill into supported coding agents. That lets
you ask naturally, for example:

```
Have Codex review this change.
Ask Claude to draft the migration script.
```

Clients with native A2A support can use the per-agent Agent Cards at
`/a2a/agents/<name>`. The local `GET /agents` endpoint lists the agents that
are currently available.

## Update or remove

Update an existing checkout:

```bash
git pull
node scripts/install.mjs
```

On Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

Remove the links created by the installer without deleting the repository:

```bash
node scripts/install.mjs uninstall
```

On Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 uninstall
```

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `herdr-a2a: command not found` | Add `~/.local/bin` or `~/bin` to your `PATH`, or run `./bin/herdr-a2a` from the repository. |
| No gateway for this Herdr session | Confirm you are in a Herdr pane, run `herdr plugin list`, then run the installer again. |
| Cannot reach the gateway | Restart Herdr, or run `node dist/main.js serve`. You can also supply `--base-url` or set `HERDR_A2A_URL`. |
| `discover` shows no agents | Run `herdr-a2a doctor`; the agent may be installed but unavailable on `PATH`. |

## For operators and contributors

### What the plugin handles

The gateway dynamically discovers the runtimes installed in Herdr, starts or
reuses workers, places visible workers without stealing focus, and relays task
state back to the caller. It retries bounded launch and delivery failures, but
never answers permission, authentication, or trust prompts on a user's behalf.

Each Herdr session has its own gateway. The gateway records delivery progress
so it can distinguish a prompt accepted by the terminal from a new agent turn
actually starting. Worker identity is checked by its agent session rather than
by a recyclable pane ID.

### Architecture

```text
Coding agent (Claude Code / Codex / OpenCode / …)
                     │ A2A v1.0
                     ▼
              herdr-a2a gateway
     discovery · tasks · relay · spawn · layout
                     │ Herdr socket API
                     ▼
         Herdr → coding-agent CLI process
```

For the Herdr behavior verified by this project, see
[`docs/herdr-contract.md`](docs/herdr-contract.md).

### Tests

```bash
npm test
npx vitest run tests/integration
```

Unit tests do not require a live Herdr instance. Integration tests do.
