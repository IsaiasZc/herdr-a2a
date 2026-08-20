import { describe, expect, it } from "vitest";

import { chooseDirection, nextDirection, splitFits } from "../../../src/layout/policy.js";
import type { LayoutConfig } from "../../../src/core/ports.js";
import type { PaneLayoutRect } from "../../../src/herdr/types.js";

const cfg: LayoutConfig = { minColumns: 50, minRows: 12, overflow: "new_tab" };

describe("layout policy", () => {
  describe("nextDirection", () => {
    it("alternates right -> down -> right", () => {
      expect(nextDirection("right")).toBe("down");
      expect(nextDirection("down")).toBe("right");
    });
  });

  describe("splitFits", () => {
    it("fits a right split when both halves clear the minimums", () => {
      const rect: PaneLayoutRect = { x: 0, y: 0, width: 209, height: 53 };
      expect(splitFits(rect, "right", cfg)).toBe(true);
    });

    it("fits a down split when both halves clear the minimums", () => {
      const rect: PaneLayoutRect = { x: 0, y: 0, width: 209, height: 53 };
      expect(splitFits(rect, "down", cfg)).toBe(true);
    });

    it("accounts for the one-cell divider when checking the boundary exactly", () => {
      // width 101 -> usable 100 -> half 50, exactly minColumns: should fit.
      const exact: PaneLayoutRect = { x: 0, y: 0, width: 101, height: 53 };
      expect(splitFits(exact, "right", cfg)).toBe(true);
      // width 100 -> usable 99 -> half 49, one below minColumns: should not fit.
      const oneShort: PaneLayoutRect = { x: 0, y: 0, width: 100, height: 53 };
      expect(splitFits(oneShort, "right", cfg)).toBe(false);
    });

    it("rejects a right split when the unsplit height is already below minRows", () => {
      const rect: PaneLayoutRect = { x: 0, y: 0, width: 209, height: 10 };
      expect(splitFits(rect, "right", cfg)).toBe(false);
    });

    it("rejects a down split when the unsplit width is already below minColumns", () => {
      const rect: PaneLayoutRect = { x: 0, y: 0, width: 40, height: 53 };
      expect(splitFits(rect, "down", cfg)).toBe(false);
    });

    it("rejects when the split axis leaves no room at all", () => {
      const rect: PaneLayoutRect = { x: 0, y: 0, width: 1, height: 53 };
      expect(splitFits(rect, "right", cfg)).toBe(false);
    });
  });

  describe("chooseDirection", () => {
    it("returns the preferred direction when it fits", () => {
      const rect: PaneLayoutRect = { x: 0, y: 0, width: 209, height: 53 };
      expect(chooseDirection(rect, "right", cfg)).toBe("right");
      expect(chooseDirection(rect, "down", cfg)).toBe("down");
    });

    it("falls back to the other axis when the preferred one does not fit", () => {
      // Wide but short: a down split would leave < minRows per half, but a
      // right split still clears minColumns comfortably.
      const rect: PaneLayoutRect = { x: 0, y: 0, width: 209, height: 20 };
      expect(chooseDirection(rect, "down", cfg)).toBe("right");
    });

    it("returns undefined (overflow) when neither axis fits", () => {
      const rect: PaneLayoutRect = { x: 0, y: 0, width: 60, height: 15 };
      expect(chooseDirection(rect, "right", cfg)).toBeUndefined();
      expect(chooseDirection(rect, "down", cfg)).toBeUndefined();
    });
  });
});
