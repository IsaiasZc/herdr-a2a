/**
 * Transport-level caller-pane context (multi-orchestrator tab targeting).
 *
 * Distinct from `execution-options.ts`: pane/tab/workspace ids must never
 * appear in agent-authored message metadata (spec §4, §19 — the caller "has
 * no business expressing" runtime placement). These instead travel as HTTP
 * headers the CLI attaches on its own behalf, since the CLI process already
 * runs inside the orchestrator's own pane and can read that from its own
 * environment. The A2A SDK's `serviceParameters` is the documented channel
 * for exactly this kind of horizontal, transport-only context.
 */

export const CALLER_PANE_HEADER = "x-herdr-caller-pane-id";
export const CALLER_TAB_HEADER = "x-herdr-caller-tab-id";
export const CALLER_WORKSPACE_HEADER = "x-herdr-caller-workspace-id";

export interface CallerContext {
  callerPaneId?: string;
  callerTabId?: string;
  callerWorkspaceId?: string;
}

/** Built by the CLI from its own process env, sent as `serviceParameters`. */
export function callerContextServiceParameters(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  const paneId = env["HERDR_PANE_ID"];
  const tabId = env["HERDR_TAB_ID"];
  const workspaceId = env["HERDR_WORKSPACE_ID"];
  if (paneId) params[CALLER_PANE_HEADER] = paneId;
  if (tabId) params[CALLER_TAB_HEADER] = tabId;
  if (workspaceId) params[CALLER_WORKSPACE_HEADER] = workspaceId;
  return Object.keys(params).length > 0 ? params : undefined;
}

/** Read back by the executor from `ServerCallContext.state.get(STATE_HEADERS_KEY)`. */
export function readCallerContextHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
): CallerContext {
  const paneId = firstHeader(headers, CALLER_PANE_HEADER);
  const tabId = firstHeader(headers, CALLER_TAB_HEADER);
  const workspaceId = firstHeader(headers, CALLER_WORKSPACE_HEADER);
  return {
    ...(paneId ? { callerPaneId: paneId } : {}),
    ...(tabId ? { callerTabId: tabId } : {}),
    ...(workspaceId ? { callerWorkspaceId: workspaceId } : {}),
  };
}

function firstHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}
