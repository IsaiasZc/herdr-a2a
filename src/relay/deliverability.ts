import type { AgentSnapshot, LiveAgent } from "../core/model.js";
import { ERROR_CODES, fail } from "../core/errors.js";
import type { Clock } from "../core/ports.js";
import type { AgentInfo } from "../herdr/types.js";

export interface StabilitySample {
  stateChangeSeq: number;
  revision: number;
  observedAtMs: number;
}

export function snapshotFromAgentInfo(info: AgentInfo, clock: Clock): AgentSnapshot {
  return {
    paneId: info.pane_id,
    terminalId: info.terminal_id,
    agent: info.agent,
    status: info.agent_status,
    interactiveReady: info.interactive_ready === true,
    launchPending: info.launch_pending === true,
    stateChangeSeq: info.state_change_seq ?? 0,
    revision: info.revision,
    sessionRef: info.agent_session?.value,
    screenDetectionSkipped: info.screen_detection_skipped === true,
    stateLabels: info.state_labels ?? {},
    observedAt: clock.nowIso(),
  };
}

export function isDeliverable(snapshot: AgentSnapshot): boolean {
  return (
    Boolean(snapshot.agent) &&
    snapshot.interactiveReady &&
    !snapshot.launchPending &&
    (snapshot.status === "idle" || snapshot.status === "done")
  );
}

export function isStableSince(sample: StabilitySample | undefined, snapshot: AgentSnapshot, nowMs: number, windowMs: number): boolean {
  return Boolean(
    sample &&
      sample.stateChangeSeq === snapshot.stateChangeSeq &&
      sample.revision === snapshot.revision &&
      nowMs - sample.observedAtMs >= windowMs,
  );
}

/** Identity is stronger than a pane id: session first, terminal as fallback. */
export function assertTargetIdentity(live: LiveAgent, snapshot: AgentSnapshot): void {
  if (live.sessionRef) {
    if (snapshot.sessionRef === live.sessionRef) return;
    throw fail(ERROR_CODES.TARGET_IDENTITY_CHANGED, "target agent session changed", {
      instanceId: live.instanceId,
      expectedSessionRef: live.sessionRef,
      actualSessionRef: snapshot.sessionRef,
    });
  }
  if (live.terminalId) {
    if (snapshot.terminalId === live.terminalId) return;
    throw fail(ERROR_CODES.TARGET_IDENTITY_CHANGED, "target terminal changed", {
      instanceId: live.instanceId,
      expectedTerminalId: live.terminalId,
      actualTerminalId: snapshot.terminalId,
    });
  }
  // Spawned workers always persist terminalId. Reaching this means our record
  // is corrupt or a pane was recycled; delivery would be a guess (spec §40).
  throw fail(ERROR_CODES.TARGET_IDENTITY_CHANGED, "target has no pinned identity anchor", {
    instanceId: live.instanceId,
  });
}
