import type { RelayState } from "../core/model.js";

/** The only legal edges in the relay lifecycle (spec §11). */
const EDGES: Readonly<Record<RelayState, readonly RelayState[]>> = {
  QUEUED: ["DELIVERING", "EXPIRED", "FAILED"],
  DELIVERING: ["DELIVERED", "QUEUED", "EXPIRED", "FAILED"],
  DELIVERED: ["TURN_STARTED", "QUEUED", "EXPIRED", "FAILED"],
  TURN_STARTED: ["SETTLED", "FAILED"],
  SETTLED: [],
  EXPIRED: [],
  FAILED: [],
};

export function canTransition(from: RelayState, to: RelayState): boolean {
  return EDGES[from].includes(to);
}

/**
 * Keeps persistence implementations honest: a storage update must not invent
 * a lifecycle edge merely because SQLite can store the requested string.
 */
export function transition(from: RelayState, to: RelayState): RelayState {
  if (!canTransition(from, to)) {
    throw new Error(`invalid relay state transition: ${from} -> ${to}`);
  }
  return to;
}
