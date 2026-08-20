# Herdr A2A Delegation Layer — Final Build Specification

**Status:** ready for implementation  
**Audience:** implementation agent / engineer  
**Validated against:** Herdr current docs, A2A v1.0, Herdr discussions on inter-agent delegation/reliable delivery, ACP ecosystem references  
**Primary goal:** make delegating work to an external coding agent through Herdr feel almost as simple and reliable as using a native subagent inside Claude Code/Codex/OpenCode, while keeping Herdr agent-agnostic.

---

## 1. Product definition

Herdr already solves the runtime problem:

- real terminal panes;
- multiple coding agents;
- persistent sessions;
- detection and state;
- focus/layout;
- agent start/prompt/wait/read;
- socket API and events;
- integrations and restore.

The missing layer is **clean agent-to-agent delegation and communication**.

Today, a caller agent may need to reason about:

```text
which agents exist?
which pane can be used?
where should the pane open?
what --kind is needed?
what flags does the target CLI need?
is the target ready?
did the prompt actually land?
should I retry?
is idle really done?
which pane/session is the same agent later?
```

A native subagent experience instead looks like:

```text
delegate(task)
  ↓
subagent works
  ↓
result / question
```

This project closes that UX gap for **external agents running through Herdr**.

### Product principle

> The caller expresses **who** and **what**. The delegation layer resolves **how**. Herdr executes.

The caller should not need to understand Herdr primitives during the normal happy path.

---

# 2. Core architecture

```text
┌─────────────────────────────────────────────────────────────┐
│ Caller coding agent                                         │
│ Claude Code / Codex / OpenCode / Gemini / Pi / etc.        │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           │ A2A semantics
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Herdr A2A Gateway / Delegation Layer                        │
│                                                             │
│  Dynamic Agent Catalog  ← Herdr                             │
│  Custom Agent Registry  ← user config                       │
│  Task Store                                                 │
│  Reliable Relay                                             │
│  Spawn Manager                                              │
│  Layout Manager                                             │
│  Recovery / Error Normalization                             │
│  Thin runtime adapters only where needed                    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           │ Herdr socket API
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Herdr                                                       │
│ panes / tabs / agents / state / events / integrations       │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
              actual coding-agent CLI process
```

Do **not** build another terminal multiplexer.

Do **not** build another full agent framework.

Do **not** make the LLM learn another large CLI.

The layer should be deliberately small.

---

# 3. What A2A is used for

Use **A2A v1.0** as the external semantic contract for agent-to-agent interaction.

Use A2A for:

- Agent Cards;
- messages;
- tasks;
- task lifecycle;
- multi-turn continuation;
- artifacts/results;
- streaming/subscription when useful;
- `input-required`;
- `auth-required`;
- cancellation.

Do **not** use A2A for:

- pane IDs;
- split direction;
- terminal key sequences;
- Herdr flags;
- CLI executable paths;
- launch retries;
- layout topology.

Those are internal runtime details.

### Important standards detail

A2A discovery is based on Agent Cards, well-known URLs, direct configuration, or registries/catalogs. The A2A standard does **not** define a universal API that means “list every coding agent installed on this machine.”

Therefore this project needs a **local catalog** backed by Herdr.

References:

- A2A v1.0 specification: https://a2a-protocol.org/latest/specification/
- A2A discovery: https://a2a-protocol.org/latest/topics/agent-discovery/
- Official JS/TS SDK: https://github.com/a2aproject/a2a-js

---

# 4. A2A endpoint model — important correction

Do not invent a non-standard A2A field such as:

```json
{
  "target": "codex"
}
```

inside a standard SendMessage request.

In A2A, the client communicates with a selected **agent endpoint** described by an Agent Card.

Therefore expose Herdr-discovered agents as **virtual A2A agents** through the same gateway.

Example:

```text
Local catalog
  ↓
Agent Card: codex
  supportedInterfaces.url = http://127.0.0.1:4319/a2a/agents/codex

Agent Card: opencode
  supportedInterfaces.url = http://127.0.0.1:4319/a2a/agents/opencode
```

Then:

```text
caller selects codex card
        ↓
A2A SendMessage to /a2a/agents/codex
        ↓
gateway resolves codex through Herdr
```

Custom profiles follow the same model:

```text
/a2a/agents/reviewer
```

The gateway can serve many virtual Agent Cards while still being one local process.

---

# 5. Dynamic discovery — never hardcode base agents

This is a hard requirement.

Do not commit:

```ts
const BASE_AGENTS = ["claude", "codex", "opencode"];
```

Herdr is the source of truth.

Current Herdr exposes:

- `herdr api schema --json`;
- `session.snapshot`;
- `agent.list`;
- agent start metadata/schema;
- server manifests/integrations;
- live agent records.

Herdr's docs currently enumerate supported `--kind` values, but this project must **derive that information from the installed Herdr control surface/schema**, not copy the documentation list into source code.

Reference:

- Herdr Socket API: https://herdr.dev/docs/socket-api/
- Herdr agent automation: https://herdr.dev/docs/agent-automation/
- Herdr agents: https://herdr.dev/docs/agents/

## 5.1 Discovery categories

Keep these concepts separate:

```text
supported_by_herdr
installed_or_launchable
currently_running
custom_profile
```

Do not collapse them into one boolean.

Example internal record:

```ts
interface RuntimeDescriptor {
  kind: string;
  supportedByHerdr: boolean;
  launchable: "yes" | "no" | "unknown";
  runningInstances: number;
  source: "herdr-schema" | "herdr-session";
}
```

### If Herdr does not expose installed-vs-supported directly

Do not guess with an LLM.

Use deterministic preflight and cache the result.

Possible strategy:

1. derive supported kinds from current Herdr schema;
2. use live session state to know running instances;
3. perform deterministic local executable/preflight resolution where required;
4. cache launchability;
5. invalidate when Herdr reconnects/version changes or a launch contradicts cache.

The key rule remains:

> No manually maintained default-agent list.

---

# 6. Custom agents

Custom agents are optional user-defined profiles.

They are the **only** agents that belong in our own registry.

Example:

```yaml
agents:
  reviewer:
    runtime: codex
    model: optional-model-id
    visibility: visible
    instructions: |
      Review architecture, correctness and maintainability.

  security-auditor:
    runtime: claude
    visibility: headless
    instructions: |
      Focus only on security findings.
```

Resolution:

```text
reviewer
   ↓
custom config says runtime=codex
   ↓
check current Herdr catalog
   ↓
if codex available → proceed
if not → CUSTOM_AGENT_RUNTIME_UNAVAILABLE
```

Custom agents never replace or hide the dynamically discovered base runtimes unless an explicit user naming policy says so.

---

# 7. Minimal caller-facing operations

Normal interaction should require the smallest semantically useful surface.

Target surface:

```text
discover()
delegate()
continue()
get()
cancel()
```

`discover()` is a local catalog helper, not a core A2A method.

The others map onto A2A semantics.

## 7.1 Do not expose spawn as the normal workflow

`spawn()` is internal infrastructure.

The caller should say:

```text
delegate codex: "Review this implementation"
```

not:

```text
create pane
spawn codex
wait for ready
send message
```

Internal flow:

```text
delegate
  ↓
reuse suitable target instance if policy allows
OR
spawn target if none exists
  ↓
deliver task
```

This is closer to native subagent UX.

---

# 8. Caller integration

Some coding agents will not have native A2A client support.

For those, provide a **small skill** and optionally a thin local client.

The skill should teach only:

```text
- discover available external agents
- delegate a task
- continue a task when input is requested
- inspect/cancel an existing task
```

The skill must **not** teach:

- pane management;
- Herdr CLI layout commands;
- flags for target CLIs;
- retry recipes;
- terminal parsing.

## 8.1 Thin CLI client

A tiny client is acceptable if it is merely an A2A client facade:

```bash
herdr-a2a discover
herdr-a2a delegate codex "Review this diff"
herdr-a2a get TASK_ID
herdr-a2a continue TASK_ID "Yes, update the tests too"
herdr-a2a cancel TASK_ID
```

It must contain **no orchestration logic**.

Its implementation should be approximately:

```text
parse args
→ call local catalog or A2A SDK
→ print structured result
```

No pane logic.
No runtime flags.
No retry logic.
No state inference.

## 8.2 Optional MCP facade

Later, an MCP server may expose tools such as:

```text
herdr_agents_discover
herdr_agent_delegate
herdr_task_continue
herdr_task_get
herdr_task_cancel
```

MCP would only be a tool-facing facade. A2A remains the delegation/task semantics underneath.

This is optional and not required for MVP.

---

# 9. Reliable Relay — central feature

This is the most important part of the project.

Current Herdr provides `agent.prompt` and event-driven `agent.wait`. `agent.prompt` can combine prompt submission with a wait, which removes a race between “prompt” and a subsequent “wait”.

However, current `agent.prompt` still injects immediately. It does **not** provide an atomic server-side “wait until idle, then deliver” queue.

Herdr Discussion #2401 identifies this exact gap and proposes a server-side queued `agent.send` with:

- FIFO;
- idle/stable delivery;
- bounded queue;
- TTL;
- queued/delivered/dropped events;
- delivery acknowledgement;
- sender attribution.

Reference:

- https://github.com/herdrdev/herdr/discussions/2401

Related larger delegation discussion:

- https://github.com/herdrdev/herdr/discussions/741

## 9.1 MVP transport rule

Until Herdr has a native reliable queued send primitive, implement a queue in this layer.

The queue is a **transport shim**, not an alternative to Herdr.

When Herdr gains native reliable delivery, replace the shim with the native method without changing the A2A/task layer.

Use an interface:

```ts
interface AgentTransport {
  enqueue(message: RelayMessage): Promise<RelayReceipt>;
  cancel(messageId: string): Promise<void>;
}
```

Implementations:

```text
QueuedPromptTransport    ← MVP
NativeHerdrSendTransport ← future if/when Herdr exposes it
```

---

# 10. Relay message model

```ts
interface RelayMessage {
  id: string;
  taskId: string;

  from: AgentIdentity;
  to: AgentIdentity;

  body: string;

  createdAt: string;
  expiresAt?: string;

  attempt: number;
}
```

Sender attribution is mandatory.

Reason:

A receiving agent should know whether text came from:

- human operator;
- Claude peer agent;
- Codex peer agent;
- system/delegation layer.

Do not let peer-agent text masquerade as human input.

Example delivered envelope:

```text
[peer-agent message]
from: claude:a81f
task: task_123

Review the authentication change and report correctness issues.
```

Adapter-specific envelopes may be used if a target harness understands a more native peer-message format.

---

# 11. Delivery lifecycle

Do not model delivery as:

```text
send() → success
```

Use explicit stages:

```text
QUEUED
  ↓
DELIVERING
  ↓
DELIVERED
  ↓
TURN_STARTED
  ↓
SETTLED
```

Definitions:

### QUEUED

Message is durably stored and waiting for safe delivery.

### DELIVERING

Relay acquired the target lock and is attempting delivery.

### DELIVERED

Text was submitted to the target terminal/session.

This does **not** yet prove the target began processing it.

### TURN_STARTED

Target state transitioned to evidence of active processing after delivery.

Typically:

```text
idle/stable
  ↓ prompt
working
```

### SETTLED

The turn that started after this message reached a terminal state such as `done`, `blocked`, failure, or another adapter-confirmed settlement.

This distinction is necessary because terminal input acceptance is not equivalent to agent turn acceptance.

---

# 12. Queue algorithm for current Herdr

Current Herdr does not guarantee atomic `wait idle → prompt` across all senders/operators.

The shim must reduce races and verify outcomes.

Per target instance:

```text
FIFO queue
+ target mutex
+ stable-state check
+ immediate prompt
+ turn-start verification
+ bounded retry
```

Pseudocode:

```ts
async function deliverNext(target: LiveAgent) {
  await targetLock.runExclusive(target.instanceId, async () => {
    const msg = await queue.peek(target.instanceId);
    if (!msg) return;

    await waitUntilDeliverable(target);

    // Re-read target immediately before prompt.
    const before = await herdr.agentGet(target.herdrTarget);
    if (!isDeliverable(before)) return;

    await queue.markDelivering(msg.id);

    await herdr.agentPrompt(target.herdrTarget, envelope(msg));
    await queue.markDelivered(msg.id);

    const started = await waitForTurnStart(target, TURN_START_TIMEOUT_MS);

    if (started) {
      await queue.markTurnStarted(msg.id);
      await queue.pop(msg.id);
      return;
    }

    await retryOrFail(msg, "TURN_DID_NOT_START");
  });
}
```

## 12.1 Deliverable state

Do not hardcode `idle` blindly.

Default policy may start with:

```text
agent detected
AND interactive-ready
AND not working
AND not blocked
AND stable for N ms
```

If an integration/adapter provides stronger semantics, use them.

The stable window should be configurable and measured in tests.

Example starting default:

```text
250–500 ms
```

but do not treat that value as protocol truth.

## 12.2 Retry

Retry only if delivery outcome is ambiguous/recoverable.

Example:

```text
DELIVERED
but no TURN_STARTED
  ↓
re-read state/output
  ↓
if safely retryable → requeue once
otherwise → fail visibly
```

Never retry indefinitely.

---

# 13. A2A task state mapping

A2A v1.0 includes task lifecycle states such as submitted, working, completed, failed, canceled, input-required, rejected, and auth-required.

Map Herdr + relay state conservatively.

Suggested mapping:

```text
relay QUEUED               → submitted
relay TURN_STARTED         → working
Herdr blocked/question     → input-required
Herdr auth blocker         → auth-required
adapter-confirmed complete → completed
process/runtime failure    → failed
caller cancellation        → canceled
policy refusal             → rejected
```

## 13.1 Herdr states

Current Herdr distinguishes states including:

```text
idle
working
blocked
done
unknown
```

Do not assume:

```text
idle == completed
```

Use `done` and/or adapter/task-boundary evidence when available.

`idle` may only mean the agent is ready, not that the delegated task has produced its final semantic result.

---

# 14. Result extraction

The result should not require the caller to scrape a pane.

Preferred order:

1. direct structured/native result if target integration provides one;
2. task-associated final agent output;
3. bounded recent terminal read associated with the turn;
4. adapter-specific extraction.

Persist the final result as an A2A Artifact or message payload as appropriate.

Do not return the entire terminal scrollback unless explicitly requested.

---

# 15. Spawn Manager

Spawn is internal.

It exists only when delegation targets an agent that does not currently have a suitable running instance.

Flow:

```text
delegate(target)
   ↓
resolve target
   ↓
existing reusable instance?
   ├─ yes → relay task
   └─ no  → spawn manager
              ↓
           preflight
              ↓
           allocate pane/background slot
              ↓
           agent.start
              ↓
           ready
              ↓
           relay task
```

---

# 16. Preflight

Preflight must happen before mutating layout where possible.

Check:

```text
Herdr reachable
Herdr protocol/schema compatible
caller context known
target exists in dynamic catalog
custom target runtime exists
cwd valid
requested model/options translatable
required adapter/recipe known if needed
```

If preflight fails:

```text
return structured error
```

Do not create an empty pane first and discover the runtime is invalid later.

---

# 17. Runtime adapters

Avoid adapter sprawl.

Herdr already normalizes a lot:

- canonical executable through `agent.start --kind`;
- detection;
- readiness;
- state;
- session identity for many integrations.

Only add an adapter where a real runtime-specific difference remains.

Interface:

```ts
interface RuntimeAdapter {
  kind: string;

  validateOptions?(ctx: RuntimeContext): Promise<void>;
  buildAgentArgs?(ctx: RuntimeContext): Promise<string[]>;
  classifyBlocker?(snapshot: AgentSnapshot): BlockerKind | undefined;
  extractResult?(ctx: TaskContext): Promise<TaskResult | undefined>;
  formatPeerMessage?(message: RelayMessage): string;
}
```

Default adapter should work for most Herdr-supported agents.

Specific adapters are exceptions, not the architecture.

---

# 18. Launch recipes

Only use recipes where Herdr does not already hide runtime-specific launch details.

Recipe key:

```text
runtime kind + relevant version range
```

Example:

```yaml
kind: some-agent
version: ">=2 <3"
args:
  model_flag: "--model"
```

Rules:

- versioned;
- deterministic;
- tested;
- no LLM trial-and-error;
- unsupported version returns a clear error.

Never do:

```text
launch failed
→ ask LLM to inspect --help
→ try random flags
```

---

# 19. Model selection

Model selection is optional.

Default behavior:

```text
no model requested
→ use target runtime's native default
```

Override behavior:

```text
A2A execution option
→ adapter translates model to target runtime
```

Custom profile may define a default model.

Priority:

```text
explicit request
  > custom profile default
  > runtime native default
```

A2A does not define a universal internal-model selector, so use a minimal extension.

Suggested extension URI:

```text
urn:herdr:execution-options:v1
```

Suggested fields:

```json
{
  "model": "optional-model-id",
  "visibility": "visible"
}
```

Keep it minimal.

Do not put pane IDs, retry counts, CLI paths or split directions in the extension.

---

# 20. Visible mode — default

Default:

```text
visibility = visible
focus_new_agent = false
```

The operator should see the external agent working, but spawning it must not steal focus from the caller.

This is a core UX requirement.

---

# 21. Deterministic layout

The caller must never decide pane placement.

Initial policy:

```text
RIGHT → DOWN → RIGHT → DOWN → ...
```

When only the caller pane exists:

```text
┌───────────────┐
│ caller        │
└───────────────┘
```

First worker:

```text
┌───────────────┬───────────────┐
│ caller        │ worker 1      │
└───────────────┴───────────────┘
```

Second worker:

```text
┌───────────────┬───────────────┐
│ caller        │ worker 1      │
│               ├───────────────┤
│               │ worker 2      │
└───────────────┴───────────────┘
```

Continue alternating predictably.

## 21.1 Layout state

Persist per tab:

```ts
interface LayoutCursor {
  tabId: string;
  anchorPaneId: string;
  nextDirection: "right" | "down";
}
```

Algorithm:

```ts
async function allocateVisiblePane(ctx: SpawnContext) {
  return layoutLock.with(ctx.tabId, async () => {
    const cursor = await layoutStore.get(ctx.tabId);

    const pane = await herdr.paneSplit({
      paneId: cursor.anchorPaneId,
      direction: cursor.nextDirection,
      focus: false,
      cwd: ctx.cwd,
    });

    await layoutStore.set(ctx.tabId, {
      tabId: ctx.tabId,
      anchorPaneId: pane.id,
      nextDirection: cursor.nextDirection === "right" ? "down" : "right",
    });

    return pane;
  });
}
```

Exact Herdr socket parameters must be generated/validated from the **installed schema**, not assumed from this pseudocode.

---

# 22. Layout guardrails

Prevent unusably small panes.

Suggested config:

```yaml
layout:
  min_columns: 50
  min_rows: 12
  overflow: new_tab
```

If a split would violate minimums:

```text
create background/unfocused new tab
→ put worker there
→ reset layout cursor for that tab
```

No LLM decision.

Use a lock per tab to prevent simultaneous spawns from corrupting placement.

---

# 23. Headless mode

Optional:

```text
visibility = headless
```

Meaning:

- does not mutate the currently visible layout;
- does not steal focus;
- remains managed by Herdr;
- remains inspectable;
- has task/session identity;
- supports continue/cancel/result.

Preferred implementation:

```text
background Herdr tab/workspace/runtime area
```

Do not launch outside Herdr unless a documented technical constraint requires it.

Herdr should remain the owner of the terminal/process lifecycle.

---

# 24. Live instance identity

Separate agent **type/profile** from live instance identity.

Example:

```text
target profile/type: codex
live instance: a2a-codex-7f31
```

Generate unique Herdr agent names:

```text
a2a-<kind>-<shortid>
```

Respect Herdr naming constraints from the installed schema/docs.

Persist:

```ts
interface LiveAgent {
  instanceId: string;
  logicalTarget: string;
  runtimeKind: string;
  herdrAgentName: string;
  paneId: string;
  sessionRef?: string;
  cwd: string;
  createdAt: string;
}
```

---

# 25. Reuse policy

Do not assume every delegation requires a new process.

Make reuse explicit and configurable.

Default MVP policy may be:

```text
reuse an idle live instance only when:
- same logical target
- same cwd/project scope
- no active task
- no conflicting model/session option
```

Otherwise spawn a new instance.

Do not reuse a working/blocked agent for a new task unless queueing semantics explicitly support it.

---

# 26. Task model

Use durable task state outside the LLM context.

Suggested TypeScript model:

```ts
type PublicTaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "auth-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";

interface DelegatedTask {
  id: string;
  contextId?: string;

  caller: AgentIdentity;
  target: AgentIdentity;
  liveInstanceId?: string;

  state: PublicTaskState;

  createdAt: string;
  updatedAt: string;

  lastRelayMessageId?: string;
  result?: TaskResult;
  error?: DelegationError;
}
```

Persist with SQLite.

Do not use YAML for mutable task state.

---

# 27. Error taxonomy

Errors must be structured and stable.

## Discovery

```text
AGENT_NOT_FOUND
AGENT_NOT_LAUNCHABLE
CUSTOM_AGENT_NOT_FOUND
CUSTOM_AGENT_RUNTIME_UNAVAILABLE
```

## Herdr

```text
HERDR_UNAVAILABLE
HERDR_PROTOCOL_UNSUPPORTED
HERDR_API_ERROR
HERDR_SESSION_STALE
```

## Spawn/layout

```text
PANE_ALLOCATION_FAILED
LAYOUT_TOO_SMALL
RUNTIME_START_FAILED
RUNTIME_START_TIMEOUT
RUNTIME_NOT_DETECTED
RUNTIME_CRASHED
```

## Relay

```text
DELIVERY_EXPIRED
DELIVERY_TARGET_BUSY
DELIVERY_TARGET_BLOCKED
DELIVERY_FAILED
TURN_DID_NOT_START
QUEUE_FULL
```

## Options

```text
MODEL_UNSUPPORTED
INVALID_EXECUTION_OPTION
INVALID_CWD
RUNTIME_VERSION_UNSUPPORTED
```

## Task

```text
TASK_TIMEOUT
TASK_FAILED
TASK_CANCELED
RESULT_UNAVAILABLE
AUTH_REQUIRED
INPUT_REQUIRED
```

Model:

```ts
interface DelegationError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

---

# 28. Recovery policy

Recovery belongs to software, not the LLM.

Example:

```text
RUNTIME_START_TIMEOUT
  ↓
inspect deterministic state
  ├─ process absent → retry launch once
  ├─ known trust/auth blocker → surface correct state
  ├─ pane invalid → allocate replacement once
  └─ unknown → fail
```

Retry budget:

```yaml
recovery:
  max_launch_attempts: 2
  max_delivery_attempts: 2
```

Every retry records:

```text
cause
attempt
recovery action
outcome
```

No unbounded loops.

---

# 29. Security and operator authority

Do not auto-approve sensitive prompts merely to make delegation smoother.

Never silently autoaccept:

- filesystem/destructive permission;
- auth/login;
- privilege escalation;
- trust decisions with security implications.

Map them to:

```text
auth-required
input-required
```

as appropriate.

Sender attribution must be preserved so a worker can distinguish peer input from human authority.

---

# 30. Happy path — target already running

Scenario:

- caller: Claude Code;
- target: Codex;
- Codex instance is idle and reusable.

Flow:

```text
Claude
  ↓ discover/catalog (optional if it already knows codex card)
select Codex Agent Card
  ↓
A2A SendMessage
  ↓
Gateway creates task_123
  ↓
resolve existing codex instance
  ↓
Relay QUEUED
  ↓
stable deliverable target
  ↓
agent.prompt
  ↓
working detected
  ↓
A2A state = working
  ↓
done/result detected
  ↓
Artifact/result persisted
  ↓
A2A state = completed
```

No new pane.
No CLI reasoning.
No manual polling.

---

# 31. Happy path — target not running

Scenario:

- caller: Claude Code;
- target: OpenCode;
- no reusable OpenCode instance exists.

Flow:

```text
A2A task to OpenCode endpoint
  ↓
Catalog confirms Herdr supports target
  ↓
Preflight
  ↓
Layout manager chooses RIGHT
  ↓
pane.split focus=false
  ↓
agent.start(unique-name, kind=opencode, pane=...)
  ↓
Herdr returns when expected agent is interactive-ready
  ↓
Relay queues task
  ↓
prompt delivered
  ↓
working
  ↓
completed
```

Caller sees the external agent appear automatically.

The caller never chooses RIGHT.

---

# 32. Happy path — target asks a question

```text
Caller delegates task
  ↓
worker starts
  ↓
worker becomes blocked with semantic question
  ↓
gateway classifies input-required
  ↓
A2A task = input-required
  ↓
caller receives question
  ↓
caller sends continuation with same task/context
  ↓
Relay delivers continuation
  ↓
working
  ↓
completed
```

Caller-facing interaction:

```text
delegate(...)
continue(task_123, "Yes, update the tests")
```

No new worker/session unless the target was lost.

---

# 33. Happy path — custom profile

Config:

```yaml
reviewer:
  runtime: codex
  instructions: |
    Focus on architectural risks.
```

Flow:

```text
caller selects reviewer Agent Card
  ↓
Gateway resolves custom profile
  ↓
runtime = dynamically discovered codex
  ↓
merge profile instructions + task
  ↓
normal delegate flow
```

Caller does not need to know which runtime implements the profile.

---

# 34. Happy path — headless

```text
delegate(... visibility=headless)
  ↓
no visible layout mutation
  ↓
background Herdr-owned terminal/session
  ↓
normal task lifecycle
```

Task remains observable through A2A and gateway state.

---

# 35. Sad path — requested target does not exist

```text
caller requests foo-agent
  ↓
local catalog refresh
  ↓
not in Herdr-derived base catalog
not in custom registry
  ↓
AGENT_NOT_FOUND
```

No pane created.
No trial launch.
No LLM searching `--help`.

---

# 36. Sad path — Herdr knows kind but runtime cannot launch

```text
catalog says kind supported
  ↓
preflight / launchability says unavailable
  ↓
AGENT_NOT_LAUNCHABLE
```

Persist launchability result for a short TTL.

Do not repeatedly retry every delegation.

---

# 37. Sad path — wrong model

```text
request model=X
  ↓
adapter validates
  ↓
unsupported
  ↓
MODEL_UNSUPPORTED
```

No pane created.

No fallback to a random model unless policy explicitly allows it.

---

# 38. Sad path — delivery lands but turn does not begin

```text
DELIVERED
  ↓
no transition to working within timeout
  ↓
re-read agent state
  ↓
if safe + attempt budget remains
    requeue/retry once
else
    TURN_DID_NOT_START
```

Do not silently mark task working.

Do not loop.

---

# 39. Sad path — target becomes blocked before delivery

```text
message queued
  ↓
target blocked
  ↓
relay pauses
  ↓
classify blocker
```

If blocker requires operator/caller input:

```text
A2A task = input-required/auth-required
```

Do not type through an unresolved permission/auth prompt.

---

# 40. Sad path — Herdr restarts

On reconnect:

1. reload `session.snapshot`;
2. rebuild live cache;
3. reconcile persisted task/live-instance mappings;
4. use session identity/Herdr restore when available;
5. mark orphaned tasks explicitly if target cannot be recovered;
6. resume queues only after identity is verified.

Never deliver a queued message to a replacement occupant merely because it reused the same pane.

Herdr's event-driven `agent.wait` explicitly pins the resolved occupant; follow the same identity discipline in our own state.

---

# 41. Session cache and Herdr socket usage

Prefer Herdr raw socket API internally because this is a custom protocol client/event subscriber.

Herdr itself recommends raw socket usage for that class of tool.

Bootstrap:

```text
herdr api schema --json
session.snapshot
subscribe to resource/agent events
```

Maintain a local cache instead of repeatedly invoking CLI commands.

After reconnect:

```text
session.snapshot again
```

Do not poll every pane from scratch for every task.

Reference:

https://herdr.dev/docs/socket-api/

---

# 42. Recommended implementation language

**TypeScript / Node.js 20+** is recommended for the first implementation.

Reasons:

- official `@a2a-js/sdk` v1.0 is stable;
- server and client support are available;
- good fit for JSON/event-driven local daemon work;
- easy SQLite support;
- existing surrounding agent tooling uses TypeScript heavily;
- simpler plugin/thin-client packaging.

Package baseline:

```text
@a2a-js/sdk
express (if using Express binding)
zod
better-sqlite3 or equivalent
vitest
```

Use the current stable SDK version at implementation time rather than copying a pinned version from this document.

Reference:

https://github.com/a2aproject/a2a-js

---

# 43. Suggested project structure

```text
src/
├── main.ts
├── config/
│   ├── load.ts
│   └── schema.ts
│
├── a2a/
│   ├── server.ts
│   ├── cards.ts
│   ├── executor.ts
│   ├── task-mapper.ts
│   └── execution-options.ts
│
├── catalog/
│   ├── catalog.ts
│   ├── herdr-discovery.ts
│   ├── custom-registry.ts
│   └── cache.ts
│
├── core/
│   ├── delegation-service.ts
│   ├── task-service.ts
│   ├── identities.ts
│   ├── errors.ts
│   └── reconciliation.ts
│
├── relay/
│   ├── transport.ts
│   ├── queued-prompt-transport.ts
│   ├── queue-store.ts
│   ├── delivery-worker.ts
│   ├── envelope.ts
│   └── state-machine.ts
│
├── spawn/
│   ├── spawn-manager.ts
│   ├── preflight.ts
│   ├── reuse-policy.ts
│   └── naming.ts
│
├── layout/
│   ├── layout-manager.ts
│   ├── cursor-store.ts
│   └── policy.ts
│
├── herdr/
│   ├── socket-client.ts
│   ├── schema-loader.ts
│   ├── session-cache.ts
│   ├── events.ts
│   └── types.ts
│
├── runtimes/
│   ├── adapter.ts
│   ├── default-adapter.ts
│   └── adapters/
│
├── persistence/
│   ├── db.ts
│   ├── migrations/
│   └── repositories/
│
├── bridge/
│   ├── cli.ts
│   └── skill/
│
└── observability/
    ├── logger.ts
    └── events.ts

tests/
├── unit/
├── integration/
├── e2e/
├── fixtures/
└── fault-injection/
```

---

# 44. Core service interfaces

## Catalog

```ts
interface AgentCatalog {
  refresh(): Promise<void>;
  list(): Promise<AgentDescriptor[]>;
  get(name: string): Promise<AgentDescriptor | undefined>;
}
```

## Delegation

```ts
interface DelegationService {
  delegate(req: DelegateRequest): Promise<DelegatedTask>;
  continue(taskId: string, message: string): Promise<DelegatedTask>;
  get(taskId: string): Promise<DelegatedTask>;
  cancel(taskId: string): Promise<DelegatedTask>;
}
```

## Spawn

```ts
interface SpawnManager {
  resolveOrSpawn(req: SpawnRequest): Promise<LiveAgent>;
}
```

## Relay

```ts
interface Relay {
  enqueue(message: RelayMessage): Promise<RelayReceipt>;
}
```

---

# 45. Delegate request

Internal request:

```ts
interface DelegateRequest {
  agentName: string;
  message: string;

  caller?: AgentIdentity;
  cwd?: string;

  model?: string;
  visibility?: "visible" | "headless";

  metadata?: Record<string, unknown>;
}
```

A2A adapter/executor translates protocol requests into this internal typed request.

Do not make internal core code depend on HTTP/JSON-RPC details.

---

# 46. Local Agent Cards

Generate Agent Cards dynamically.

For base runtimes:

```ts
function cardForRuntime(runtime: RuntimeDescriptor): AgentCard {
  return {
    name: runtime.kind,
    description: `Local ${runtime.kind} coding agent exposed through Herdr`,
    version: runtime.version ?? "unknown",
    supportedInterfaces: [
      {
        url: `${baseUrl}/a2a/agents/${encodeURIComponent(runtime.kind)}`,
        protocolBinding: "HTTP+JSON"
      }
    ],
    skills: [
      {
        id: "general-coding",
        name: "General coding tasks",
        description: "Delegate coding work to this local agent runtime"
      }
    ]
  };
}
```

Use the exact field names/types expected by the installed A2A SDK/spec; the fragment above is conceptual.

Do not claim capabilities that Herdr/runtime did not verify.

---

# 47. Persistence schema — suggested

SQLite tables:

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  context_id TEXT,
  caller_json TEXT NOT NULL,
  target_json TEXT NOT NULL,
  live_instance_id TEXT,
  state TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE live_agents (
  instance_id TEXT PRIMARY KEY,
  logical_target TEXT NOT NULL,
  runtime_kind TEXT NOT NULL,
  herdr_agent_name TEXT NOT NULL,
  pane_id TEXT NOT NULL,
  session_ref TEXT,
  cwd TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE relay_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  target_instance_id TEXT NOT NULL,
  sender_json TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE layout_cursor (
  tab_id TEXT PRIMARY KEY,
  anchor_pane_id TEXT NOT NULL,
  next_direction TEXT NOT NULL
);
```

Add indexes and migrations as implementation requires.

---

# 48. Observability

Structured events:

```text
catalog.refresh.started
catalog.refresh.completed
catalog.runtime.changed

task.created
task.working
task.input_required
task.completed
task.failed

relay.queued
relay.delivering
relay.delivered
relay.turn_started
relay.retry
relay.expired
relay.failed

spawn.preflight.started
spawn.preflight.failed
spawn.pane_allocated
spawn.runtime_starting
spawn.runtime_ready

reconcile.started
reconcile.completed
```

Include IDs, not secrets.

Example:

```json
{
  "event": "relay.turn_started",
  "task_id": "task_123",
  "message_id": "msg_456",
  "target_instance": "a2a-codex-7f31"
}
```

---

# 49. Doctor command/tool

Useful for humans and tests:

```text
doctor()
```

Check:

```text
Herdr reachable
schema readable
protocol compatible
session snapshot readable
event subscription works
catalog generation works
custom config valid
SQLite writable
layout primitives present
```

Do **not** expect specific runtimes to exist.

Doctor should report whatever Herdr says exists.

---

# 50. Testing strategy

## 50.1 Unit tests

### Catalog

- no base agent list exists in source;
- schema changes are reflected;
- live instances merge correctly;
- custom profiles merge correctly;
- custom unavailable runtime is marked unavailable.

### Relay

- FIFO per target;
- sender attribution preserved;
- TTL expiration;
- blocked target pauses delivery;
- turn-start verification;
- retry budget respected;
- duplicate task/message IDs are idempotent.

### Layout

- first visible spawn → right;
- second → down;
- third → right;
- focus unchanged;
- min-size overflow creates another tab;
- simultaneous spawns serialize correctly.

### State mapping

- working → A2A working;
- blocker/question → input-required;
- auth blocker → auth-required;
- done + result → completed;
- idle alone does not force completed.

---

# 51. Integration tests with real Herdr

Use an actual Herdr server.

Test:

1. read installed schema;
2. snapshot session;
3. subscribe to events;
4. dynamically select a testable runtime from the catalog;
5. delegate a simple task;
6. verify pane creation when needed;
7. verify no-focus;
8. verify target starts;
9. verify message delivery;
10. verify working transition;
11. verify completion/result;
12. cancel a task;
13. restart gateway and reconcile;
14. restart Herdr where practical and reconcile.

Do not write E2E tests that assume `codex` or `claude` is always installed.

Runtime-specific CI jobs may opt into known agents.

---

# 52. Fault injection tests

Simulate:

```text
Herdr disconnect
schema version mismatch
pane disappears
agent exits during queue wait
agent exits after prompt
new occupant replaces pane
blocked permission prompt
runtime start timeout
no turn-start transition
queue overflow
message TTL expiry
two callers delegate to same target simultaneously
human starts a turn while relay is waiting
custom runtime removed between discovery and spawn
```

Every case must terminate with a deterministic state or bounded recovery.

No infinite retry/poll loop.

---

# 53. Performance/token-efficiency goals

The product exists partly to reduce LLM operational overhead.

Measure:

- number of tool calls caller needs per delegation;
- amount of Herdr-specific text entering caller context;
- number of retries visible to caller;
- time from delegate → turn started;
- failed-delivery rate;
- average polling calls per task.

Target normal happy path:

```text
1 delegation action
0 Herdr-management decisions by caller
0 manual pane/layout calls
0 manual flag-discovery calls
0 manual polling loops
```

If a worker asks a question:

```text
+1 continuation action
```

That is the intended native-subagent-like experience.

---

# 54. Milestone plan

## Milestone 0 — validate Herdr contract

Before implementing product logic:

- run `herdr api schema --json`;
- inspect `session.snapshot`;
- inspect agent/pane/event schemas;
- verify `agent.start` semantics;
- verify `agent.prompt` + wait semantics;
- verify state/event transitions using at least two available runtimes;
- save fixtures for tests.

Deliverable:

```text
docs/herdr-contract.md
```

---

## Milestone 1 — dynamic catalog

Implement:

- Herdr socket client;
- schema loader;
- session cache;
- dynamic runtime catalog;
- custom profile merge;
- Agent Card generation.

Acceptance:

```text
catalog changes when Herdr capabilities/environment change
without editing source agent lists
```

---

## Milestone 2 — deterministic spawn

Implement:

- preflight;
- reuse policy;
- live identity;
- visible spawn;
- no-focus;
- RIGHT/DOWN layout;
- headless skeleton;
- bounded startup recovery.

Acceptance:

```text
resolveOrSpawn(target)
```

works without caller knowing pane/flags.

---

## Milestone 3 — Reliable Relay

Implement:

- durable FIFO;
- target locks;
- stable deliverability;
- sender attribution;
- delivery/turn-start distinction;
- retry budget;
- TTL;
- reconciliation.

This is the most important milestone.

Acceptance:

```text
send to idle/recently-busy target reliably
without caller wait/prompt loops
```

---

## Milestone 4 — Task abstraction

Implement:

- task store;
- delegate;
- continue;
- get;
- cancel;
- state mapping;
- result extraction.

Acceptance:

```text
delegate → working → completed
```

and:

```text
delegate → input-required → continue → completed
```

---

## Milestone 5 — A2A v1.0 gateway

Use official SDK.

Implement only required surface:

- dynamic Agent Cards;
- message send;
- task retrieval;
- task cancel;
- continuation/context;
- artifacts/results;
- streaming/subscription if it improves caller UX;
- execution-options extension.

Do not implement unused protocol features merely for completeness.

---

## Milestone 6 — thin client + skill

Implement minimal caller compatibility layer.

The skill should fit on roughly one screen of concepts.

If the skill needs to explain pane topology or runtime flags, the abstraction has failed.

---

## Milestone 7 — hardening

- multiple concurrent callers;
- recovery after restart;
- additional adapters only when proven necessary;
- headless completion;
- compatibility matrix;
- metrics;
- fault injection.

---

# 55. Acceptance criteria — final

The project is successful when all are true:

1. No base-agent list is hardcoded.
2. Base agents are derived from the active Herdr environment/control surface.
3. Custom agents are optional user profiles layered on top.
4. Caller can delegate without knowing Herdr CLI primitives.
5. Caller does not choose pane IDs.
6. Caller does not choose split direction.
7. Caller does not discover runtime flags interactively.
8. Caller does not implement wait/retry loops.
9. Visible mode is default.
10. New visible workers use deterministic layout.
11. Spawning does not steal focus.
12. Headless mode exists without abandoning Herdr ownership.
13. Message delivery is queued/durable within our layer.
14. Sender attribution is preserved.
15. Delivery and turn-start are distinct states.
16. Retries are bounded and deterministic.
17. A2A task lifecycle is correctly exposed.
18. Input-required can continue the same task/context.
19. Result is returned without caller pane scraping.
20. Gateway survives/reconciles reconnects without delivering to the wrong occupant.
21. A caller's normal happy path is approximately one delegation action.
22. Herdr-native reliable send can replace our queue transport later without changing the public A2A/task API.

---

# 56. Non-goals

Do not build:

- a replacement for Herdr;
- a new terminal multiplexer;
- a generic distributed workflow engine;
- a mandatory custom-agent framework;
- a model router in the first version;
- a worktree manager unless separately requested;
- a giant CLI agents must memorize;
- an autonomous retry loop controlled by an LLM.

---

# 57. Similar projects / patterns to study

## Herdr inter-agent delegation discussion

https://github.com/herdrdev/herdr/discussions/741

Why read it:

- directly describes the missing inter-agent delegation layer;
- explicitly discusses A2A vs a smaller protocol;
- confirms demand around addressing agents and delegation.

## Herdr reliable send proposal

https://github.com/herdrdev/herdr/discussions/2401

Why read it:

- closest description of the transport problem;
- queueing;
- sender attribution;
- FIFO;
- TTL;
- delivery acknowledgement;
- explains why `wait idle` + `prompt` races.

Treat this as a major design reference.

## Herdr Socket API

https://herdr.dev/docs/socket-api/

Why read it:

- this project should use the socket API internally;
- inspect `session.snapshot`, agent methods, pane methods and events;
- generate against the installed schema instead of assuming method details.

## Herdr Agent Automation

https://herdr.dev/docs/agent-automation/

Why read it:

- agent identity;
- `agent.start`;
- available-pane requirement;
- readiness;
- kind/args semantics;
- wait/prompt behavior.

## Herdr Agents / Integrations

https://herdr.dev/docs/agents/
https://herdr.dev/docs/integrations/

Why read them:

- state authority differs by runtime;
- integrations may add lifecycle/session identity;
- do not duplicate signals Herdr already owns.

## herdr-orchestrate

https://github.com/darjss/herdr-orchestrate

What to borrow conceptually:

- durable state;
- worker identity;
- visible workers;
- no-focus UX;
- reconciliation.

What not to copy:

- Pi-specific orchestration model;
- worktree assumptions;
- target-specific workflow as universal architecture.

## herdr-board

https://github.com/bredebjorhovd/herdr-board

Why read it:

- contains practical observations about unreliable prompt delivery into a running parent agent;
- useful evidence for why terminal injection needs stronger delivery semantics.

## A2A v1.0

https://a2a-protocol.org/latest/specification/
https://a2a-protocol.org/latest/topics/agent-discovery/
https://github.com/a2aproject/a2a-js

Why read them:

- task lifecycle;
- Agent Cards;
- discovery constraints;
- correct endpoint/client semantics;
- official implementation SDK.

## Agent Client Protocol (ACP)

https://github.com/agentclientprotocol/agent-client-protocol
https://github.com/agentclientprotocol/codex-acp
https://github.com/forge-agents/forge

Why read it:

- ACP solves a neighboring problem: client/editor ↔ coding agent;
- validates the adapter pattern;
- shows how model/harness details can be normalized;
- may become useful for some headless/runtime adapters later.

Do not replace Herdr with ACP in MVP.

---

# 58. Important implementation notes from current Herdr behavior

At time of writing, current Herdr documentation states:

- `agent.start` uses an existing available shell pane; topology is created separately;
- `agent.start` returns only after the expected agent owns that terminal and is ready for interactive input;
- arguments after `--` pass to the selected agent executable;
- `agent.wait` is server-owned and event-driven;
- `agent.prompt` can include a wait in the same request;
- the socket API exposes session snapshots, agent methods, pane split/layout methods, and subscriptions;
- state authority varies between direct integrations and screen-manifest detection.

Do not freeze any of those details in assumptions without checking the installed schema/version during implementation.

---

# 59. Decision log

## Decision: A2A remains the external semantic layer

Reason:

The problem is agent-to-agent delegation, not generic tool use.

## Decision: Herdr remains runtime authority

Reason:

It already owns terminals, sessions, panes, detection and state.

## Decision: no hardcoded default agents

Reason:

Herdr is intentionally agent-agnostic and evolves its supported agent surface.

## Decision: reliable relay is first-class

Reason:

Communication reliability is the actual missing UX primitive.

## Decision: `delegate`, not `spawn`, is the product abstraction

Reason:

Native subagent UX is task-oriented, not process-oriented.

## Decision: visible by default

Reason:

Herdr's value includes observability and human intervention.

## Decision: deterministic layout

Reason:

Pane placement should consume zero LLM reasoning.

## Decision: headless is optional

Reason:

Some tasks do not need visible terminal space, but should remain Herdr-owned.

## Decision: thin adapters only

Reason:

Do not duplicate Herdr's runtime normalization.

---

# 60. Final instruction to the implementation agent

Build the smallest layer that makes this experience true:

```text
Caller:
"Have Codex review this change."

System:
- resolves Codex from Herdr dynamically
- reuses or launches it
- places it correctly if visible
- keeps focus on caller
- waits for actual readiness
- delivers the task reliably
- attributes the sender
- tracks the turn
- surfaces questions
- returns the result
```

The caller should not have to know which Herdr commands were required.

Start with:

```text
1. Herdr contract + dynamic catalog
2. deterministic spawn/reuse
3. reliable relay
4. durable task lifecycle
5. A2A gateway
6. thin caller skill/client
```

Do not start by writing a large CLI.

Do not start by building custom agents.

Do not start by implementing every A2A feature.

Do not make the LLM the recovery engine.

The project is complete when external Herdr agents feel close to native subagents in day-to-day delegation flow.
