import { describe, expect, it } from "vitest";

import { DefaultLayoutManager } from "../../../src/layout/layout-manager.js";
import { KeyedMutex } from "../../../src/core/runtime-support.js";
import { EVENTS } from "../../../src/observability/events.js";
import { silentLogger } from "../../../src/observability/logger.js";
import type { Clock, CursorStore, EventSink, HerdrClient, LayoutConfig, Logger } from "../../../src/core/ports.js";
import type { LayoutCursor } from "../../../src/core/model.js";
import type {
  AgentInfo,
  AgentManifestStatus,
  AgentStatus,
  PaneInfo,
  PaneLayoutRect,
  PaneLayoutSnapshot,
  PaneSplitParams,
  PongResult,
  ReadSource,
  SessionSnapshot,
  Subscription,
  TabCreateParams,
  TabInfo,
} from "../../../src/herdr/types.js";
import { DelegationFailure, ERROR_CODES } from "../../../src/core/errors.js";

const cfg: LayoutConfig = { minColumns: 50, minRows: 12, overflow: "new_tab" };

const clock: Clock = {
  now: () => new Date("2026-08-20T00:00:00.000Z"),
  nowIso: () => "2026-08-20T00:00:00.000Z",
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

class InMemoryCursorStore implements CursorStore {
  private readonly byTab = new Map<string, LayoutCursor>();
  async get(tabId: string): Promise<LayoutCursor | undefined> {
    return this.byTab.get(tabId);
  }
  async set(cursor: LayoutCursor): Promise<void> {
    this.byTab.set(cursor.tabId, cursor);
  }
  async delete(tabId: string): Promise<void> {
    this.byTab.delete(tabId);
  }
}

function recordingEventSink(): EventSink & { events: { event: string; fields: Record<string, unknown> }[] } {
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  return {
    events,
    emit(event, fields = {}) {
      events.push({ event, fields });
    },
  };
}

function halve(rect: PaneLayoutRect, direction: "right" | "down"): { child: PaneLayoutRect; parent: PaneLayoutRect } {
  if (direction === "right") {
    const usable = rect.width - 1;
    const half = Math.floor(usable / 2);
    return {
      child: { ...rect, width: half },
      parent: { ...rect, width: usable - half },
    };
  }
  const usable = rect.height - 1;
  const half = Math.floor(usable / 2);
  return {
    child: { ...rect, height: half },
    parent: { ...rect, height: usable - half },
  };
}

interface FakePane {
  info: PaneInfo;
  rect: PaneLayoutRect;
}

/**
 * Hand-written fake `HerdrClient`. Only the methods layout-manager actually
 * calls are meaningfully implemented; anything else throws so an
 * unanticipated call fails the test loudly instead of silently no-op'ing.
 */
class FakeHerdrClient implements HerdrClient {
  panes = new Map<string, FakePane>();
  tabs = new Map<string, { tabId: string; workspaceId: string; paneIds: string[] }>();
  vanishedPaneIds = new Set<string>();
  splitCalls: PaneSplitParams[] = [];
  tabCreateCalls: TabCreateParams[] = [];
  onSplit?: (params: PaneSplitParams) => Promise<void> | void;

  private paneNum = 1;
  private tabNum = 1;

  seedPane(paneId: string, tabId: string, workspaceId: string, rect: PaneLayoutRect, focused = true): void {
    this.panes.set(paneId, {
      rect,
      info: {
        pane_id: paneId,
        terminal_id: `term_${paneId}`,
        workspace_id: workspaceId,
        tab_id: tabId,
        focused,
        agent_status: "idle",
        revision: 1,
      },
    });
    const tab = this.tabs.get(tabId) ?? { tabId, workspaceId, paneIds: [] };
    if (!tab.paneIds.includes(paneId)) tab.paneIds.push(paneId);
    this.tabs.set(tabId, tab);
  }

  async ping(): Promise<PongResult> {
    throw new Error("FakeHerdrClient: unexpected call to ping");
  }
  async sessionSnapshot(): Promise<SessionSnapshot> {
    throw new Error("FakeHerdrClient: unexpected call to sessionSnapshot");
  }
  async agentManifests(): Promise<AgentManifestStatus> {
    throw new Error("FakeHerdrClient: unexpected call to agentManifests");
  }
  async agentList(): Promise<AgentInfo[]> {
    throw new Error("FakeHerdrClient: unexpected call to agentList");
  }
  async agentGet(): Promise<AgentInfo> {
    throw new Error("FakeHerdrClient: unexpected call to agentGet");
  }
  async agentStart(): Promise<{ agent: AgentInfo; argv: string[] }> {
    throw new Error("FakeHerdrClient: unexpected call to agentStart");
  }
  async agentPrompt(): Promise<AgentInfo> {
    throw new Error("FakeHerdrClient: unexpected call to agentPrompt");
  }
  async agentWait(): Promise<AgentInfo> {
    throw new Error("FakeHerdrClient: unexpected call to agentWait");
  }
  async agentRead(): Promise<string> {
    throw new Error("FakeHerdrClient: unexpected call to agentRead");
  }
  async agentSendKeys(): Promise<void> {
    throw new Error("FakeHerdrClient: unexpected call to agentSendKeys");
  }

  async paneSplit(params: PaneSplitParams): Promise<PaneInfo> {
    this.splitCalls.push(params);
    if (this.onSplit) await this.onSplit(params);

    const targetId = params.target_pane_id;
    if (!targetId) throw new Error("FakeHerdrClient.paneSplit: no target_pane_id");
    const target = this.panes.get(targetId);
    if (!target) throw new Error(`FakeHerdrClient.paneSplit: unknown target ${targetId}`);

    const { child, parent } = halve(target.rect, params.direction);
    target.rect = parent;

    const newPaneId = `p${++this.paneNum}`;
    const info: PaneInfo = {
      pane_id: newPaneId,
      terminal_id: `term_${newPaneId}`,
      workspace_id: target.info.workspace_id,
      tab_id: target.info.tab_id,
      focused: params.focus ?? false,
      agent_status: "idle",
      revision: 1,
    };
    this.panes.set(newPaneId, { info, rect: child });
    const tab = this.tabs.get(target.info.tab_id);
    tab?.paneIds.push(newPaneId);
    return info;
  }

  async paneGet(paneId: string): Promise<PaneInfo> {
    const pane = this.panes.get(paneId);
    if (!pane) throw new Error(`FakeHerdrClient.paneGet: unknown pane ${paneId}`);
    return pane.info;
  }

  async paneList(): Promise<PaneInfo[]> {
    throw new Error("FakeHerdrClient: unexpected call to paneList");
  }

  async paneClose(paneId: string): Promise<void> {
    this.panes.delete(paneId);
  }

  async paneLayout(params?: { paneId?: string; tabId?: string }): Promise<PaneLayoutSnapshot> {
    if (params?.paneId) {
      if (this.vanishedPaneIds.has(params.paneId) || !this.panes.has(params.paneId)) {
        throw new Error(`FakeHerdrClient.paneLayout: unknown pane ${params.paneId}`);
      }
      const pane = this.panes.get(params.paneId)!;
      return {
        workspace_id: pane.info.workspace_id,
        tab_id: pane.info.tab_id,
        zoomed: false,
        area: pane.rect,
        focused_pane_id: params.paneId,
        panes: [{ pane_id: params.paneId, focused: true, rect: pane.rect }],
        splits: [],
      };
    }
    if (params?.tabId) {
      const tab = this.tabs.get(params.tabId);
      if (!tab) throw new Error(`FakeHerdrClient.paneLayout: unknown tab ${params.tabId}`);
      // For the fallback/overflow cases the fake only needs the *current*
      // (last-created) pane in that tab, mirroring what a freshly created
      // tab or a post-close focused-pane lookup would surface.
      const livePaneIds = tab.paneIds.filter((id) => this.panes.has(id));
      const focusedId = livePaneIds[livePaneIds.length - 1];
      if (!focusedId) {
        return {
          workspace_id: tab.workspaceId,
          tab_id: tab.tabId,
          zoomed: false,
          area: { x: 0, y: 0, width: 0, height: 0 },
          focused_pane_id: "",
          panes: [],
          splits: [],
        };
      }
      const pane = this.panes.get(focusedId)!;
      return {
        workspace_id: tab.workspaceId,
        tab_id: tab.tabId,
        zoomed: false,
        area: pane.rect,
        focused_pane_id: focusedId,
        panes: [{ pane_id: focusedId, focused: true, rect: pane.rect }],
        splits: [],
      };
    }
    throw new Error("FakeHerdrClient.paneLayout: no params");
  }

  async tabCreate(params: TabCreateParams): Promise<TabInfo> {
    this.tabCreateCalls.push(params);
    const tabId = `nt${++this.tabNum}`;
    const workspaceId = params.workspace_id ?? "w1";
    const rootPaneId = `p${++this.paneNum}`;
    this.tabs.set(tabId, { tabId, workspaceId, paneIds: [rootPaneId] });
    this.panes.set(rootPaneId, {
      rect: { x: 0, y: 0, width: 209, height: 53 },
      info: {
        pane_id: rootPaneId,
        terminal_id: `term_${rootPaneId}`,
        workspace_id: workspaceId,
        tab_id: tabId,
        focused: params.focus ?? false,
        agent_status: "idle",
        revision: 1,
      },
    });
    return { tab_id: tabId, workspace_id: workspaceId, number: this.tabNum, focused: params.focus ?? false, pane_count: 1 };
  }

  async subscribe(): Promise<never> {
    throw new Error("FakeHerdrClient: unexpected call to subscribe");
  }

  async close(): Promise<void> {}
}

function makeManager(herdr: FakeHerdrClient, opts: { cursors?: CursorStore; events?: EventSink } = {}) {
  const cursors = opts.cursors ?? new InMemoryCursorStore();
  const events = opts.events ?? recordingEventSink();
  const manager = new DefaultLayoutManager({
    herdr,
    cursors,
    config: cfg,
    lock: new KeyedMutex(),
    clock,
    events,
    logger: silentLogger,
  });
  return { manager, cursors, events };
}

describe("DefaultLayoutManager.allocateVisiblePane", () => {
  it("splits right, then down, then right for successive spawns on the same tab", async () => {
    const herdr = new FakeHerdrClient();
    herdr.seedPane("p1", "t1", "w1", { x: 0, y: 0, width: 209, height: 53 });
    const { manager } = makeManager(herdr);

    const req = { tabId: "t1", workspaceId: "w1", anchorPaneId: "p1", cwd: "/work" };

    const pane1 = await manager.allocateVisiblePane(req);
    const pane2 = await manager.allocateVisiblePane(req);
    const pane3 = await manager.allocateVisiblePane(req);

    expect(herdr.splitCalls.map((c) => c.direction)).toEqual(["right", "down", "right"]);
    expect(pane1.pane_id).not.toBe(pane2.pane_id);
    expect(pane2.pane_id).not.toBe(pane3.pane_id);
  });

  it("never focuses a split", async () => {
    const herdr = new FakeHerdrClient();
    herdr.seedPane("p1", "t1", "w1", { x: 0, y: 0, width: 209, height: 53 });
    const { manager } = makeManager(herdr);
    const req = { tabId: "t1", workspaceId: "w1", anchorPaneId: "p1", cwd: "/work" };

    await manager.allocateVisiblePane(req);
    await manager.allocateVisiblePane(req);

    for (const call of herdr.splitCalls) {
      expect(call.focus).toBe(false);
    }
  });

  it("advances the cursor anchor to the newly created pane", async () => {
    const herdr = new FakeHerdrClient();
    herdr.seedPane("p1", "t1", "w1", { x: 0, y: 0, width: 209, height: 53 });
    const { manager, cursors } = makeManager(herdr);
    const req = { tabId: "t1", workspaceId: "w1", anchorPaneId: "p1", cwd: "/work" };

    const pane1 = await manager.allocateVisiblePane(req);
    const cursorAfterFirst = await cursors.get("t1");
    expect(cursorAfterFirst?.anchorPaneId).toBe(pane1.pane_id);
    expect(cursorAfterFirst?.nextDirection).toBe("down");

    const pane2 = await manager.allocateVisiblePane(req);
    const cursorAfterSecond = await cursors.get("t1");
    expect(cursorAfterSecond?.anchorPaneId).toBe(pane2.pane_id);
    expect(cursorAfterSecond?.nextDirection).toBe("right");
  });

  it("overflows to a new unfocused tab and resets that tab's cursor when the rect is too small", async () => {
    const herdr = new FakeHerdrClient();
    // Small enough that neither right nor down clears the minimums.
    herdr.seedPane("p1", "t1", "w1", { x: 0, y: 0, width: 60, height: 15 });
    const { manager, cursors, events } = makeManager(herdr);
    const req = { tabId: "t1", workspaceId: "w1", anchorPaneId: "p1", cwd: "/work" };

    const pane = await manager.allocateVisiblePane(req);

    // No split should have been attempted against the too-small tab.
    expect(herdr.splitCalls).toHaveLength(0);
    expect(herdr.tabCreateCalls).toHaveLength(1);
    expect(herdr.tabCreateCalls[0]?.focus).toBe(false);

    const newTabId = herdr.tabCreateCalls.length > 0 ? Array.from(herdr.tabs.keys()).find((id) => id !== "t1") : undefined;
    expect(newTabId).toBeDefined();
    const resetCursor = await cursors.get(newTabId!);
    expect(resetCursor).toEqual({ tabId: newTabId, anchorPaneId: pane.pane_id, nextDirection: "right" });

    const recording = events as ReturnType<typeof recordingEventSink>;
    expect(recording.events.some((e) => e.event === EVENTS.layoutOverflowTab)).toBe(true);
  });

  it("falls back to the tab's focused pane when the anchor pane has vanished", async () => {
    const herdr = new FakeHerdrClient();
    herdr.seedPane("p1", "t1", "w1", { x: 0, y: 0, width: 209, height: 53 }, false);
    herdr.seedPane("p9", "t1", "w1", { x: 0, y: 0, width: 209, height: 53 }, true);
    // Simulate p1 (a stale cursor anchor) having been closed already.
    herdr.panes.delete("p1");
    herdr.vanishedPaneIds.add("p1");

    const cursors = new InMemoryCursorStore();
    await cursors.set({ tabId: "t1", anchorPaneId: "p1", nextDirection: "right" });
    const { manager } = makeManager(herdr, { cursors });

    const req = { tabId: "t1", workspaceId: "w1", anchorPaneId: "p1", cwd: "/work" };
    await expect(manager.allocateVisiblePane(req)).resolves.toBeDefined();

    expect(herdr.splitCalls[0]?.target_pane_id).toBe("p9");
  });

  it("serializes two concurrent allocations on the same tab (no interleaved splits)", async () => {
    const herdr = new FakeHerdrClient();
    herdr.seedPane("p1", "t1", "w1", { x: 0, y: 0, width: 209, height: 53 });
    const { manager } = makeManager(herdr);
    const req = { tabId: "t1", workspaceId: "w1", anchorPaneId: "p1", cwd: "/work" };

    const order: string[] = [];
    let inFlight = 0;
    herdr.onSplit = async (params) => {
      inFlight += 1;
      order.push(`start:${params.target_pane_id}`);
      // If two allocations were not serialized by the tab lock, both would
      // be "in flight" here at once.
      expect(inFlight).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push(`end:${params.target_pane_id}`);
      inFlight -= 1;
    };

    await Promise.all([manager.allocateVisiblePane(req), manager.allocateVisiblePane(req)]);

    // Every "start" must be immediately followed by its own "end" before the
    // next "start" appears — proof the tab lock serialized the two calls.
    expect(order).toHaveLength(4);
    expect(order[0]?.startsWith("start:")).toBe(true);
    expect(order[1]?.startsWith("end:")).toBe(true);
    expect(order[2]?.startsWith("start:")).toBe(true);
    expect(order[3]?.startsWith("end:")).toBe(true);
  });
});

describe("DefaultLayoutManager.allocateHeadlessPane", () => {
  it("creates an unfocused background tab and returns its root pane", async () => {
    const herdr = new FakeHerdrClient();
    const { manager } = makeManager(herdr);

    const pane = await manager.allocateHeadlessPane({ cwd: "/work", workspaceId: "w1" });

    expect(herdr.tabCreateCalls).toHaveLength(1);
    expect(herdr.tabCreateCalls[0]).toMatchObject({ workspace_id: "w1", cwd: "/work", focus: false });
    expect(pane.pane_id).toBeDefined();
  });
});

describe("DefaultLayoutManager.releasePane", () => {
  it("tolerates an already-gone pane", async () => {
    const herdr = new FakeHerdrClient();
    const originalClose = herdr.paneClose.bind(herdr);
    herdr.paneClose = async () => {
      throw new DelegationFailure(ERROR_CODES.HERDR_API_ERROR, "pane not found", { herdrCode: "pane_not_found" });
    };
    const { manager } = makeManager(herdr);

    await expect(manager.releasePane("ghost")).resolves.toBeUndefined();
    void originalClose;
  });

  it("closes a real pane without throwing", async () => {
    const herdr = new FakeHerdrClient();
    herdr.seedPane("p1", "t1", "w1", { x: 0, y: 0, width: 209, height: 53 });
    const { manager } = makeManager(herdr);

    await manager.releasePane("p1");
    expect(herdr.panes.has("p1")).toBe(false);
  });
});
