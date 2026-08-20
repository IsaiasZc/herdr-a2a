import { formatIdentity } from "../core/model.js";
import type { RelayMessage } from "../core/model.js";
import type { RuntimeAdapter } from "../core/ports.js";

/** Sender identity is deliberately inside the submitted text (spec §10). */
export function formatRelayEnvelope(message: RelayMessage, adapter: RuntimeAdapter): string {
  return (
    adapter.formatPeerMessage?.(message) ??
    `[peer-agent message]\nfrom: ${formatIdentity(message.from)}\ntask: ${message.taskId}\n\n${message.body}`
  );
}

/**
 * A short, single-line marker used to decide whether a prompt already landed
 * before retrying.
 *
 * Matching the whole envelope against a terminal read does not work: the
 * terminal soft-wraps and reflows, and an agent's own UI may re-render the
 * submitted text, so an exact multi-line `includes` almost always misses. That
 * would make the retry-suppression check silently useless and let a duplicate
 * prompt through — worse than a visible failure. A single distinctive line
 * survives reflow, and the task id is unique per delegation.
 */
export function deliveryMarker(message: RelayMessage): string {
  return `task: ${message.taskId}`;
}

/**
 * True when the delivered text is visibly present in the target's recent
 * output. Deliberately conservative: only a positive match suppresses a retry.
 */
export function looksLikeEnvelope(text: string, message: RelayMessage): boolean {
  return text.includes(deliveryMarker(message));
}
