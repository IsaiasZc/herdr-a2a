/**
 * Shared contract and small helpers for runtime adapters (spec §17).
 *
 * `RuntimeAdapter` itself is defined in src/core/ports.ts (frozen — do not
 * redefine it here). This file re-exports it for ergonomic imports within
 * `src/runtimes/**` and holds constants/helpers shared by more than one
 * adapter, so a specific adapter built later has somewhere neutral to pull
 * from instead of copy-pasting into `default-adapter.ts`.
 */

export type { RuntimeAdapter, RuntimeAdapterRegistry, RuntimeContext, TaskContext } from "../core/ports.js";

/**
 * Bound for the recent-terminal-read fallback used by result extraction
 * (spec §14 step 3). Never grows to "the whole scrollback" — see
 * docs/herdr-contract.md §11 on the alternate-screen caveat.
 */
export const RECENT_READ_LINES = 200;
