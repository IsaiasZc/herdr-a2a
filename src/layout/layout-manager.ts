/**
 * Implements `LayoutManager` (src/core/ports.ts). Owns pane placement for
 * visible and headless spawns (spec §21–§23). Herdr remains the process
 * owner throughout — this module only decides *where*, never launches
 * anything itself.
 */

import { ERROR_CODES, fail } from "../core/errors.js";
import type { Clock, CursorStore, EventSink, HerdrClient, LayoutConfig, LayoutManager, Logger, Mutex } from "../core/ports.js";
import type { LayoutCursor } from "../core/model.js";
import type { PaneInfo, PaneLayoutRect, PaneLayoutSnapshot, TabInfo } from "../herdr/types.js";
import { EVENTS } from "../observability/events.js";
import { chooseDirection, nextDirection } from "./policy.js";

export interface LayoutManagerDeps {
  herdr: HerdrClient;
  cursors: CursorStore;
  config: LayoutConfig;
  lock: Mutex;
  clock: Clock;
  events: EventSink;
  logger: Logger;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether `rect`, used *without* splitting, is big enough to host a pane. */
function fitsAsSinglePane(rect: PaneLayoutRect, cfg: LayoutConfig): boolean {
  return rect.width >= cfg.minColumns && rect.height >= cfg.minRows;
}

export class DefaultLayoutManager implements LayoutManager {
  constructor(private readonly deps: LayoutManagerDeps) {}

  async allocateVisiblePane(req: {
    tabId: string;
    workspaceId: string;
    anchorPaneId: string;
    cwd: string;
  }): Promise<PaneInfo> {
    const { cursors, lock, events } = this.deps;

    return lock.runExclusive(req.tabId, async () => {
      const existing = await cursors.get(req.tabId);
      const cursor: LayoutCursor = existing ?? {
        tabId: req.tabId,
        anchorPaneId: req.anchorPaneId,
        nextDirection: "right",
      };

      const { anchorPaneId, anchorRect } = await this.resolveAnchor(cursor, req.tabId);
      const direction = chooseDirection(anchorRect, cursor.nextDirection, this.deps.config);

      if (direction === undefined) {
        events.emit(EVENTS.layoutOverflowTab, { tab_id: req.tabId, workspace_id: req.workspaceId });
        return this.overflowToNewTab(req);
      }

      const pane = await this.split(anchorPaneId, direction, req.cwd);

      await cursors.set({
        tabId: req.tabId,
        anchorPaneId: pane.pane_id,
        nextDirection: nextDirection(direction),
      });

      events.emit(EVENTS.spawnPaneAllocated, { pane_id: pane.pane_id, tab_id: req.tabId, direction });
      return pane;
    });
  }

  async allocateHeadlessPane(req: { cwd: string; workspaceId?: string }): Promise<PaneInfo> {
    const { herdr } = this.deps;
    let tab: TabInfo;
    try {
      tab = await herdr.tabCreate({
        ...(req.workspaceId === undefined ? {} : { workspace_id: req.workspaceId }),
        cwd: req.cwd,
        focus: false,
      });
    } catch (err) {
      throw fail(ERROR_CODES.PANE_ALLOCATION_FAILED, `headless tab creation failed: ${message(err)}`, {
        cwd: req.cwd,
      });
    }
    return this.resolveTabRootPane(tab.tab_id);
  }

  async releasePane(paneId: string): Promise<void> {
    try {
      await this.deps.herdr.paneClose(paneId);
    } catch (err) {
      // Best-effort cleanup: Herdr's not-found error code for a pane closed
      // out from under us isn't part of the documented, stable set (see
      // docs/herdr-contract.md §13), so we tolerate any close failure here
      // rather than trying to special-case one string.
      this.deps.logger.log("debug", "pane close failed, ignoring", { pane_id: paneId, error: message(err) });
    }
  }

  /**
   * Reads real geometry for the cursor's anchor pane. If that pane is gone
   * (closed since the cursor was last written), falls back to the tab's
   * currently focused pane and logs it, rather than throwing.
   */
  private async resolveAnchor(
    cursor: LayoutCursor,
    tabId: string,
  ): Promise<{ anchorPaneId: string; anchorRect: PaneLayoutRect }> {
    const { herdr, logger } = this.deps;

    try {
      const layout = await herdr.paneLayout({ paneId: cursor.anchorPaneId });
      const found = layout.panes.find((p) => p.pane_id === cursor.anchorPaneId);
      if (found) return { anchorPaneId: cursor.anchorPaneId, anchorRect: found.rect };
    } catch {
      // Herdr rejects pane.layout for an unknown pane id — fall through.
    }

    logger.log("warn", "layout anchor pane vanished, falling back to focused pane", {
      tab_id: tabId,
      anchor_pane_id: cursor.anchorPaneId,
    });

    const fallbackLayout: PaneLayoutSnapshot = await herdr.paneLayout({ tabId });
    const focused = fallbackLayout.panes.find((p) => p.pane_id === fallbackLayout.focused_pane_id);
    if (!focused) {
      throw fail(ERROR_CODES.PANE_ALLOCATION_FAILED, "no focused pane available as fallback anchor", {
        tab_id: tabId,
      });
    }
    return { anchorPaneId: focused.pane_id, anchorRect: focused.rect };
  }

  private async split(targetPaneId: string, direction: "right" | "down", cwd: string): Promise<PaneInfo> {
    try {
      // focus:false is non-negotiable (spec §20) — spawning must never steal
      // focus from the caller.
      return await this.deps.herdr.paneSplit({ target_pane_id: targetPaneId, direction, cwd, focus: false });
    } catch (err) {
      throw fail(ERROR_CODES.PANE_ALLOCATION_FAILED, `pane split failed: ${message(err)}`, {
        target_pane_id: targetPaneId,
        direction,
      });
    }
  }

  /**
   * Overflow path (spec §22): a fresh, unfocused tab whose sole pane becomes
   * the new anchor. `tab.create`'s `TabInfo` carries no root-pane id, so we
   * resolve it via `pane.layout({ tabId })` — cheaper than listing every pane
   * in the workspace and filtering, since a brand-new tab is guaranteed to
   * hold exactly one pane before anything else touches it.
   */
  private async overflowToNewTab(req: { tabId: string; workspaceId: string; cwd: string }): Promise<PaneInfo> {
    const { herdr, cursors, config, events } = this.deps;

    let tab: TabInfo;
    try {
      tab = await herdr.tabCreate({ workspace_id: req.workspaceId, cwd: req.cwd, focus: false });
    } catch (err) {
      throw fail(ERROR_CODES.PANE_ALLOCATION_FAILED, `overflow tab creation failed: ${message(err)}`, {
        tab_id: req.tabId,
      });
    }

    const layout = await herdr.paneLayout({ tabId: tab.tab_id });
    const rootPane = layout.panes[0];
    if (!rootPane) {
      throw fail(ERROR_CODES.LAYOUT_TOO_SMALL, "overflow tab produced no root pane", { tab_id: tab.tab_id });
    }
    if (!fitsAsSinglePane(rootPane.rect, config)) {
      throw fail(ERROR_CODES.LAYOUT_TOO_SMALL, "overflow tab's root pane is below configured minimums", {
        tab_id: tab.tab_id,
        rect: rootPane.rect,
      });
    }

    // Fresh tab: reset its cursor exactly as spec §21 defines a fresh tab —
    // anchored on the root pane, next split RIGHT.
    await cursors.set({ tabId: tab.tab_id, anchorPaneId: rootPane.pane_id, nextDirection: "right" });

    const pane = await herdr.paneGet(rootPane.pane_id);
    events.emit(EVENTS.spawnPaneAllocated, { pane_id: pane.pane_id, tab_id: tab.tab_id, direction: "overflow" });
    return pane;
  }

  private async resolveTabRootPane(tabId: string): Promise<PaneInfo> {
    const layout = await this.deps.herdr.paneLayout({ tabId });
    const rootPane = layout.panes[0];
    if (!rootPane) {
      throw fail(ERROR_CODES.PANE_ALLOCATION_FAILED, "tab has no panes to allocate", { tab_id: tabId });
    }
    return this.deps.herdr.paneGet(rootPane.pane_id);
  }
}
