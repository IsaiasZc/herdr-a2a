/**
 * Pure geometry decisions for deterministic layout (spec §21, §22). No I/O —
 * everything here is a function of a rect and a config, which is what makes
 * it unit-testable without a live Herdr.
 */

import type { LayoutConfig } from "../core/ports.js";
import type { PaneLayoutRect } from "../herdr/types.js";

export type SplitDirection = "right" | "down";

/** RIGHT → DOWN → RIGHT → DOWN → ... (spec §21). */
export function nextDirection(current: SplitDirection): SplitDirection {
  return current === "right" ? "down" : "right";
}

/**
 * Whether splitting `rect` in `direction` leaves both halves usable.
 *
 * A Herdr split is not a clean bisection: it inserts a one-cell divider
 * (border row/column) between the two resulting panes. We subtract that cell
 * from the axis being split before halving, then check *both* the new pane
 * and the shrunken original against `minColumns`/`minRows` on both axes —
 * a `right` split only changes width, so height must already have satisfied
 * `minRows` (and vice versa for `down`), which is why the other axis is
 * checked against the *unsplit* dimension.
 */
export function splitFits(rect: PaneLayoutRect, direction: SplitDirection, cfg: LayoutConfig): boolean {
  if (direction === "right") {
    const usable = rect.width - 1;
    if (usable <= 0) return false;
    const half = Math.floor(usable / 2);
    return half >= cfg.minColumns && rect.height >= cfg.minRows;
  }
  const usable = rect.height - 1;
  if (usable <= 0) return false;
  const half = Math.floor(usable / 2);
  return rect.width >= cfg.minColumns && half >= cfg.minRows;
}

/**
 * Resolves the direction to actually split in: `preferred` if it fits, else
 * the other axis if *that* fits, else `undefined` meaning overflow to a new
 * tab (spec §22). No LLM decision — this is a pure lookup.
 */
export function chooseDirection(
  rect: PaneLayoutRect,
  preferred: SplitDirection,
  cfg: LayoutConfig,
): SplitDirection | undefined {
  if (splitFits(rect, preferred, cfg)) return preferred;
  const other = nextDirection(preferred);
  if (splitFits(rect, other, cfg)) return other;
  return undefined;
}
