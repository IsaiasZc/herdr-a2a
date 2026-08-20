import type { AgentIdentity, AgentSnapshot } from "./model.js";
import type { Clock } from "./ports.js";
import type { AgentInfo } from "../herdr/types.js";

/** The system's own identity, used for gateway-generated text. */
export const SYSTEM_IDENTITY: AgentIdentity = { role: "system", name: "herdr-a2a" };

/**
 * Best-effort identity for the process that called us.
 *
 * Attribution must never be guessed into something stronger than the evidence:
 * an unidentified caller is a `peer-agent` named `unknown`, never `human`.
 * Spec §29 depends on a worker being able to tell peer input from human
 * authority, so silently promoting an anonymous caller to `human` would defeat
 * the whole attribution scheme.
 */
export function callerFromEnv(
  env: NodeJS.ProcessEnv,
  lookupAgentByPane: (paneId: string) => AgentInfo | undefined,
): AgentIdentity {
  const paneId = env["HERDR_PANE_ID"];
  if (!paneId) return { role: "peer-agent", name: "unknown" };

  const agent = lookupAgentByPane(paneId);
  const kind = agent?.agent ?? undefined;
  const ref = agent?.agent_session?.value?.slice(0, 4) ?? paneId.replace(":", "");

  return {
    role: "peer-agent",
    name: kind ?? "unknown",
    ref,
    ...(kind ? { runtimeKind: kind } : {}),
  };
}

export function targetIdentity(logicalName: string, runtimeKind: string, ref?: string): AgentIdentity {
  return { role: "peer-agent", name: logicalName, runtimeKind, ...(ref ? { ref } : {}) };
}

/**
 * Projects a Herdr `AgentInfo` onto the evidence the relay and task layers
 * reason about. Defaults are deliberately pessimistic: a missing
 * `interactive_ready` reads as not ready, and a missing `state_change_seq`
 * reads as 0, so absent evidence never looks like a green light.
 */
export function toSnapshot(info: AgentInfo, clock: Clock): AgentSnapshot {
  return {
    paneId: info.pane_id,
    terminalId: info.terminal_id,
    agent: info.agent ?? null,
    status: info.agent_status,
    interactiveReady: info.interactive_ready === true,
    launchPending: info.launch_pending === true,
    stateChangeSeq: info.state_change_seq ?? 0,
    revision: info.revision,
    ...(info.agent_session?.value ? { sessionRef: info.agent_session.value } : {}),
    screenDetectionSkipped: info.screen_detection_skipped === true,
    stateLabels: info.state_labels ?? {},
    observedAt: clock.nowIso(),
  };
}
