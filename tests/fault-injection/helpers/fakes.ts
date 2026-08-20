import type { AgentInfo, AgentStatus, PaneInfo, PaneProcessInfo, SessionSnapshot, Subscription } from "../../../src/herdr/types.js";
import type { Clock, EventSink, HerdrClient, HerdrEventHandler, HerdrSubscription, IdGenerator, LayoutManager, Logger, Preflight, PreflightReport, ReusePolicy, RuntimeAdapterRegistry } from "../../../src/core/ports.js";
import type { AgentDescriptor, LiveAgent, SpawnRequest } from "../../../src/core/model.js";
import { DelegationFailure, ERROR_CODES } from "../../../src/core/errors.js";

export class TestClock implements Clock {
  private ms = 1_000;
  readonly sleeps: number[] = [];
  now(): Date { return new Date(this.ms); }
  nowIso(): string { return this.now().toISOString(); }
  async sleep(ms: number): Promise<void> { this.sleeps.push(ms); }
  advance(ms: number): void { this.ms += ms; }
}

export const logger: Logger = { log: () => {}, child: () => logger };

export function agent(target = "one", overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    terminal_id: `${target}-term`, agent_status: "idle", workspace_id: "w", tab_id: "w:t", pane_id: `${target}-pane`,
    focused: false, revision: 1, agent: "codex", interactive_ready: true, launch_pending: false, state_change_seq: 1,
    agent_session: { source: "fake", agent: "codex", kind: "id", value: `session-${target}` }, ...overrides,
  };
}

export function pane(id = "p1", overrides: Partial<PaneInfo> = {}): PaneInfo {
  return { pane_id: id, terminal_id: `term_${id}`, workspace_id: "w", tab_id: "w:t", focused: false, agent_status: "idle", revision: 1, ...overrides };
}

export function snapshot(agents: AgentInfo[] = []): SessionSnapshot {
  return {
    version: "0.8.0", protocol: 20, focused_workspace_id: "w", focused_tab_id: "w:t", focused_pane_id: "p1",
    workspaces: [], tabs: [], panes: agents.map((info) => pane(info.pane_id, { terminal_id: info.terminal_id, agent_status: info.agent_status, agent: info.agent, revision: info.revision })),
    layouts: [], agents,
  };
}

type Script = AgentInfo | Error;

/**
 * A faithful stand-in for Herdr's "the target does not exist" reply.
 *
 * The real socket client wraps `error.code` into `details.herdrCode`, and the
 * relay branches on `agent_not_found` to reach TARGET_LOST. A bare `Error`
 * would force the relay to guess from a message string — the kind of
 * string-matching the spec forbids — so tests must model the real shape.
 */
export function targetGoneError(target = "the-target"): DelegationFailure {
  return new DelegationFailure(
    ERROR_CODES.HERDR_API_ERROR,
    `agent.get: agent target ${target} not found`,
    { herdrCode: "agent_not_found", method: "agent.get" },
  );
}

/** Herdr's stall signal, likewise carried in `details.herdrCode`. */
export function promptStalledError(): DelegationFailure {
  return new DelegationFailure(ERROR_CODES.HERDR_API_ERROR, "agent.prompt: agent_prompt_stalled", {
    herdrCode: "agent_prompt_stalled",
    method: "agent.prompt",
  });
}

/** Complete programmable boundary double; defaults always describe an available shell. */
export class FakeHerdr implements HerdrClient {
  readonly calls = { ping: 0, snapshot: 0, agentList: 0, agentGet: 0, agentStart: 0, agentPrompt: 0, agentWait: 0, agentRead: 0, agentSendKeys: 0, paneGet: 0, paneProcessInfo: 0, subscribe: 0, paneClose: 0 };
  readonly promptTexts: string[] = [];
  readonly promptTargets: string[] = [];
  readonly handlers: HerdrEventHandler[] = [];
  readonly subscriptions: Subscription[][] = [];
  getScript: Script[] = [];
  promptScript: Script[] = [];
  waitScript: Script[] = [];
  processScript: (PaneProcessInfo | Error)[] = [];
  readText: Partial<Record<"detection" | "recent_unwrapped", string>> = {};
  list: AgentInfo[] = [];
  current = agent();
  session = snapshot([this.current]);
  startImpl: ((params: { name: string; kind: string; paneId: string; args?: string[]; timeoutMs?: number }) => Promise<{ agent: AgentInfo; argv: string[] }>) | undefined;
  paneGetImpl: ((paneId: string) => Promise<PaneInfo>) | undefined;

  private take(script: Script[], fallback: AgentInfo): AgentInfo {
    const next = script.shift() ?? fallback;
    if (next instanceof Error) throw next;
    this.current = next;
    return next;
  }
  async ping() { this.calls.ping += 1; return { version: "0.8.0", protocol: 20, capabilities: {} }; }
  async sessionSnapshot() { this.calls.snapshot += 1; return this.session; }
  async agentManifests() { return { manifests: [] }; }
  async agentList() { this.calls.agentList += 1; return this.list; }
  async agentGet(target: string) { this.calls.agentGet += 1; return this.take(this.getScript, this.current.pane_id === `${target}-pane` || target === this.current.pane_id ? this.current : agent(target)); }
  async agentStart(params: { name: string; kind: string; paneId: string; args?: string[]; timeoutMs?: number }) {
    this.calls.agentStart += 1;
    if (this.startImpl) return this.startImpl(params);
    return { agent: agent("one", { pane_id: params.paneId, terminal_id: `term_${params.paneId}`, name: params.name }), argv: [params.kind] };
  }
  async agentPrompt(params: { target: string; text: string }) {
    this.calls.agentPrompt += 1; this.promptTexts.push(params.text); this.promptTargets.push(params.target);
    return this.take(this.promptScript, agent(params.target, { agent_status: "working", state_change_seq: this.current.state_change_seq! + 1, revision: this.current.revision + 1 }));
  }
  async agentWait(params: { target: string }) { this.calls.agentWait += 1; return this.take(this.waitScript, agent(params.target, { agent_status: "idle", state_change_seq: this.current.state_change_seq! + 1, revision: this.current.revision + 1 })); }
  async agentRead(params: { source: "visible" | "recent" | "recent_unwrapped" | "detection" }) { this.calls.agentRead += 1; return this.readText[params.source as "detection" | "recent_unwrapped"] ?? ""; }
  async agentSendKeys() { this.calls.agentSendKeys += 1; }
  async paneSplit() { return pane("split"); }
  async paneGet(paneId: string) { this.calls.paneGet += 1; return this.paneGetImpl ? this.paneGetImpl(paneId) : pane(paneId); }
  async paneList() { return []; }
  async paneClose() { this.calls.paneClose += 1; }
  async paneLayout() { throw new Error("unused"); }
  async paneProcessInfo(paneId: string) {
    this.calls.paneProcessInfo += 1;
    const next = this.processScript.shift();
    if (next instanceof Error) throw next;
    return next ?? { pane_id: paneId, shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: "bash", argv: ["bash"], cmdline: "bash" }] };
  }
  async tabCreate() { throw new Error("unused"); }
  async subscribe(subscriptions: Subscription[], handler: HerdrEventHandler): Promise<HerdrSubscription> { this.calls.subscribe += 1; this.subscriptions.push(subscriptions); this.handlers.push(handler); return { close: () => {} }; }
  async close() {}
  emit(event: string, data: Record<string, unknown>): void { for (const handler of this.handlers) handler(event, data); }
}

export class RecordingEvents implements EventSink {
  readonly entries: { event: string; fields: Record<string, unknown> }[] = [];
  emit(event: string, fields: Record<string, unknown> = {}): void { this.entries.push({ event, fields }); }
}

export class FakeLayout implements LayoutManager {
  readonly allocated: string[] = [];
  readonly released: string[] = [];
  constructor(private panes = [pane("p1")]) {}
  async allocateVisiblePane(): Promise<PaneInfo> { const next = this.panes.shift(); if (!next) throw new Error("no pane"); this.allocated.push(next.pane_id); return next; }
  async allocateHeadlessPane(): Promise<PaneInfo> { return this.allocateVisiblePane(); }
  async releasePane(paneId: string): Promise<void> { this.released.push(paneId); }
}

export class FixedPreflight implements Preflight {
  constructor(private readonly report: PreflightReport) {}
  async run(_req: SpawnRequest): Promise<PreflightReport> { return this.report; }
}
export class NeverReuse implements ReusePolicy { async pick(): Promise<LiveAgent | undefined> { return undefined; } }
export const adapters: RuntimeAdapterRegistry = { for: () => ({ kind: "codex" }) };
export const ids: IdGenerator = { taskId: () => "task", messageId: () => "message", instanceId: () => "instance", shortId: () => "aaaa" };

export function descriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return { name: "codex", descriptorKind: "runtime", runtimeKind: "codex", available: true, description: "codex", runtime: { kind: "codex", supportedByHerdr: true, hasDetectionManifest: true, hasIntegration: true, launchable: "yes", runningInstances: 0, sources: [] }, ...overrides };
}

/** Bounded microtask drain: never waits on an injected clock. */
export async function flush(limit = 80): Promise<void> { for (let i = 0; i < limit; i += 1) await Promise.resolve(); }
