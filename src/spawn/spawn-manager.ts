/**
 * Implements `SpawnManager` (src/core/ports.ts). Turns a `SpawnRequest` into
 * a `LiveAgent`, either by reuse (spec §25) or by preflight → allocate pane →
 * `agent.start` → bounded recovery (spec §15, §16, §28).
 */

import { ERROR_CODES, DelegationFailure, fail, type ErrorCode } from "../core/errors.js";
import type {
  Clock,
  EventSink,
  HerdrClient,
  IdGenerator,
  LayoutManager,
  Logger,
  Preflight,
  RecoveryConfig,
  ReusePolicy,
  RuntimeAdapterRegistry,
  SpawnManager as SpawnManagerPort,
  LiveAgentStore,
} from "../core/ports.js";
import type { LiveAgent, SpawnRequest } from "../core/model.js";
import type { AgentInfo, PaneInfo } from "../herdr/types.js";
import { EVENTS } from "../observability/events.js";
import { liveAgentName } from "./naming.js";

/** Default startup timeout passed to `agent.start`. Herdr clamps to (3000, 300000]. */
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
/**
 * How long to wait for a freshly split pane to reach its shell prompt.
 *
 * Bounded by a probe COUNT, not only by a deadline: the deadline is measured
 * with the injected clock, and a fake clock that never advances would turn a
 * deadline-only loop into a hang.
 */
const AVAILABLE_SHELL_MAX_PROBES = 50;
const AVAILABLE_SHELL_POLL_MS = 100;
/** Two consecutive probe failures mean the pane or the method is unavailable. */
const AVAILABLE_SHELL_MAX_FAILURES = 2;

export interface SpawnManagerDeps {
  herdr: HerdrClient;
  layout: LayoutManager;
  preflight: Preflight;
  reuse: ReusePolicy;
  liveAgents: LiveAgentStore;
  adapters: RuntimeAdapterRegistry;
  ids: IdGenerator;
  clock: Clock;
  config: { recovery: RecoveryConfig };
  events: EventSink;
  logger: Logger;
}

/**
 * Maps a failing preflight check name to the `ErrorCode` `SpawnManager`
 * throws for it. `descriptor_available` is handled separately because its
 * code depends on `descriptor.descriptorKind`; `model_supported` never
 * appears here because `Preflight.run` lets that failure propagate as the
 * adapter's own, already-correctly-coded `DelegationFailure`.
 */
const PREFLIGHT_ERROR_CODE: Record<string, ErrorCode> = {
  herdr_reachable: ERROR_CODES.HERDR_UNAVAILABLE,
  herdr_protocol_compatible: ERROR_CODES.HERDR_PROTOCOL_UNSUPPORTED,
  cwd_exists: ERROR_CODES.INVALID_CWD,
};

type RecoveryAction = "replace_pane" | "retry" | "terminal";

interface FailureClassification {
  action: RecoveryAction;
  outcome: string;
  error: DelegationFailure;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class DefaultSpawnManager implements SpawnManagerPort {
  constructor(private readonly deps: SpawnManagerDeps) {}

  async resolveOrSpawn(req: SpawnRequest): Promise<LiveAgent> {
    await this.runPreflight(req);

    const candidates = await this.deps.liveAgents.byLogicalTarget(req.descriptor.name);
    const reused = await this.deps.reuse.pick(req, candidates);
    if (reused) {
      this.deps.events.emit(EVENTS.spawnReused, {
        instance_id: reused.instanceId,
        logical_target: reused.logicalTarget,
        pane_id: reused.paneId,
      });
      return reused;
    }

    return this.spawnNew(req);
  }

  async release(instanceId: string): Promise<void> {
    const live = await this.deps.liveAgents.get(instanceId);
    if (!live) return;
    await this.deps.liveAgents.delete(instanceId);
    await this.deps.layout.releasePane(live.paneId);
  }

  private async runPreflight(req: SpawnRequest): Promise<void> {
    const report = await this.deps.preflight.run(req);
    if (report.ok) return;

    const failing = report.checks.find((c) => !c.ok);
    if (!failing) {
      throw fail(ERROR_CODES.TASK_FAILED, "preflight reported failure with no failing check", {
        agent: req.descriptor.name,
      });
    }

    if (failing.name === "descriptor_available") {
      const code =
        req.descriptor.descriptorKind === "custom"
          ? ERROR_CODES.CUSTOM_AGENT_RUNTIME_UNAVAILABLE
          : ERROR_CODES.AGENT_NOT_LAUNCHABLE;
      throw fail(code, failing.detail ?? "agent is not launchable", { check: failing.name });
    }

    const code = PREFLIGHT_ERROR_CODE[failing.name] ?? ERROR_CODES.INVALID_EXECUTION_OPTION;
    throw fail(code, failing.detail ?? `preflight check failed: ${failing.name}`, { check: failing.name });
  }

  private async spawnNew(req: SpawnRequest): Promise<LiveAgent> {
    let pane = await this.allocatePane(req);
    const name = liveAgentName(req.descriptor.runtimeKind, this.deps.ids.shortId());

    try {
      const agent = await this.startWithRecovery(req, name, pane, (replacement) => {
        pane = replacement;
      });
      const live = this.toLiveAgent(req, name, agent);
      await this.deps.liveAgents.put(live);
      this.deps.events.emit(EVENTS.spawnRuntimeReady, {
        instance_id: live.instanceId,
        pane_id: live.paneId,
        session_ref: live.sessionRef,
      });
      return live;
    } catch (err) {
      // Terminal failure: never litter the layout with a pane nobody owns.
      try {
        await this.deps.layout.releasePane(pane.pane_id);
      } catch (releaseErr) {
        this.deps.logger.log("warn", "failed to release pane after terminal spawn failure", {
          pane_id: pane.pane_id,
          error: message(releaseErr),
        });
      }
      this.deps.events.emit(EVENTS.spawnFailed, {
        agent: req.descriptor.name,
        pane_id: pane.pane_id,
        error: message(err),
      });
      throw err;
    }
  }

  private async allocatePane(req: SpawnRequest): Promise<PaneInfo> {
    if (req.visibility === "headless") {
      return this.deps.layout.allocateHeadlessPane({
        cwd: req.cwd,
        ...(req.callerWorkspaceId === undefined ? {} : { workspaceId: req.callerWorkspaceId }),
      });
    }

    if (!req.callerTabId || !req.callerWorkspaceId || !req.callerPaneId) {
      throw fail(ERROR_CODES.PANE_ALLOCATION_FAILED, "visible spawn requires caller pane/tab/workspace context", {
        visibility: req.visibility,
      });
    }

    return this.deps.layout.allocateVisiblePane({
      tabId: req.callerTabId,
      workspaceId: req.callerWorkspaceId,
      anchorPaneId: req.callerPaneId,
      cwd: req.cwd,
    });
  }

  /**
   * Bounded launch recovery (spec §28): at most `recovery.maxLaunchAttempts`
   * calls to `agent.start`, each decision driven by *observed* Herdr state
   * (`paneGet`/`agentGet`) rather than by guessing from the error string.
   */
  private async startWithRecovery(
    req: SpawnRequest,
    name: string,
    initialPane: PaneInfo,
    onPaneReplaced: (pane: PaneInfo) => void,
  ): Promise<AgentInfo> {
    const { herdr, adapters, config, logger, events } = this.deps;
    const adapter = adapters.for(req.descriptor.runtimeKind);
    const builtArgs = adapter.buildAgentArgs
      ? await adapter.buildAgentArgs({
          runtimeKind: req.descriptor.runtimeKind,
          cwd: req.cwd,
          ...(req.model === undefined ? {} : { model: req.model }),
        })
      : [];
    const args = [...builtArgs, ...(req.args ?? [])];

    events.emit(EVENTS.spawnRuntimeStarting, { agent: req.descriptor.name, kind: req.descriptor.runtimeKind, name });

    let pane = initialPane;
    // `pane.split` returns as soon as the pane exists, but `agent.start`
    // requires an *available shell* — shell in the foreground, at its prompt.
    // Without this wait the first attempt reliably loses that race and fails
    // with "is not an available shell", burning a launch attempt on something
    // entirely predictable. Observed on every visible spawn.
    await this.waitForAvailableShell(pane.pane_id);
    const maxAttempts = Math.max(1, config.recovery.maxLaunchAttempts);
    let lastError: DelegationFailure | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const { agent } = await herdr.agentStart({
          name,
          kind: req.descriptor.runtimeKind,
          paneId: pane.pane_id,
          ...(args.length > 0 ? { args } : {}),
          timeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
        });
        return agent;
      } catch (err) {
        const classification = await this.classifyStartFailure(req, pane, err);
        lastError = classification.error;
        logger.log("warn", "agent.start failed", {
          cause: message(err),
          attempt,
          action: classification.action,
          outcome: classification.outcome,
        });

        const hasMoreAttempts = attempt < maxAttempts;
        if (classification.action === "replace_pane" && hasMoreAttempts) {
          const replacement = await this.allocatePane(req);
          pane = replacement;
          onPaneReplaced(replacement);
          continue;
        }
        if (classification.action === "retry" && hasMoreAttempts) {
          continue;
        }
        // Either a terminal classification, or we've exhausted the retry
        // budget — surface the classified error rather than looping further.
        throw classification.error;
      }
    }

    // Unreachable in practice (the loop always returns or throws), but keeps
    // the function's return type honest without a non-null assertion.
    throw lastError ?? fail(ERROR_CODES.RUNTIME_START_FAILED, "agent.start failed with no recorded cause");
  }

  /**
   * Waits until a pane is an available shell: `pane.process_info` reports the
   * shell itself as the foreground process group, meaning no command, editor or
   * agent is running in it.
   *
   * Bounded and non-fatal — if the window elapses we still attempt the start,
   * because the launch-recovery path already classifies that failure correctly.
   * This only removes a wasted attempt; it is not load-bearing for correctness.
   */
  private async waitForAvailableShell(paneId: string): Promise<void> {
    const { herdr, clock, logger } = this.deps;
    let failures = 0;

    for (let probe = 0; probe < AVAILABLE_SHELL_MAX_PROBES; probe += 1) {
      try {
        const info = await herdr.paneProcessInfo(paneId);
        failures = 0;
        if (info.foreground_process_group_id === info.shell_pid) return;
      } catch (err) {
        failures += 1;
        if (failures >= AVAILABLE_SHELL_MAX_FAILURES) {
          // The pane is gone, or this Herdr does not answer the probe. Either
          // way the launch path classifies the real failure better than we can.
          logger.log("debug", "available-shell probe unavailable", { paneId, error: message(err) });
          return;
        }
      }
      await clock.sleep(AVAILABLE_SHELL_POLL_MS);
    }

    logger.log("debug", "pane did not reach an interactive prompt in time", { paneId });
  }

  /**
   * Inspects deterministic state after a failed `agent.start` and decides
   * the recovery action (spec §28). Never types through a blocker — a
   * `blocked` status is surfaced as `RUNTIME_START_FAILED`, never answered.
   */
  private async classifyStartFailure(
    req: SpawnRequest,
    pane: PaneInfo,
    err: unknown,
  ): Promise<FailureClassification> {
    const paneStillExists = await this.deps.herdr
      .paneGet(pane.pane_id)
      .then(() => true)
      .catch(() => false);

    if (!paneStillExists) {
      return {
        action: "replace_pane",
        outcome: "pane_gone",
        error: fail(ERROR_CODES.PANE_ALLOCATION_FAILED, `pane ${pane.pane_id} no longer exists`, {
          pane_id: pane.pane_id,
        }),
      };
    }

    const agentInfo = await this.deps.herdr.agentGet(pane.pane_id).catch(() => undefined);

    if (!agentInfo || agentInfo.agent == null) {
      return {
        action: "retry",
        outcome: "no_agent_detected",
        error: fail(ERROR_CODES.RUNTIME_START_TIMEOUT, `no agent detected in pane ${pane.pane_id} after agent.start`, {
          pane_id: pane.pane_id,
        }),
      };
    }

    if (agentInfo.agent !== req.descriptor.runtimeKind) {
      return {
        action: "terminal",
        outcome: "wrong_kind",
        error: fail(
          ERROR_CODES.RUNTIME_NOT_DETECTED,
          `pane ${pane.pane_id} hosts '${agentInfo.agent}', expected '${req.descriptor.runtimeKind}'`,
          { pane_id: pane.pane_id, expected: req.descriptor.runtimeKind, actual: agentInfo.agent },
        ),
      };
    }

    if (agentInfo.agent_status === "blocked") {
      return {
        action: "terminal",
        outcome: "blocked",
        error: fail(
          ERROR_CODES.RUNTIME_START_FAILED,
          `agent in pane ${pane.pane_id} is blocked on a trust/auth prompt`,
          { pane_id: pane.pane_id, state_labels: agentInfo.state_labels ?? {} },
        ),
      };
    }

    return {
      action: "terminal",
      outcome: "unknown",
      error: fail(ERROR_CODES.RUNTIME_START_FAILED, message(err), { pane_id: pane.pane_id }),
    };
  }

  private toLiveAgent(req: SpawnRequest, herdrAgentName: string, agent: AgentInfo): LiveAgent {
    return {
      instanceId: this.deps.ids.instanceId(),
      logicalTarget: req.descriptor.name,
      runtimeKind: req.descriptor.runtimeKind,
      herdrAgentName,
      paneId: agent.pane_id,
      terminalId: agent.terminal_id,
      ...(agent.agent_session?.value !== undefined ? { sessionRef: agent.agent_session.value } : {}),
      workspaceId: agent.workspace_id,
      tabId: agent.tab_id,
      cwd: req.cwd,
      visibility: req.visibility,
      ...(req.model === undefined ? {} : { model: req.model }),
      createdAt: this.deps.clock.nowIso(),
    };
  }
}
