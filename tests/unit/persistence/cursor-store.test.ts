import { beforeEach, describe, expect, it } from "vitest";

import type { Clock } from "../../../src/core/ports.js";
import { openDatabase } from "../../../src/persistence/db.js";
import { SqliteCursorStore } from "../../../src/persistence/repositories/cursor-store.js";

function createFakeClock(): Clock {
  return {
    now: () => new Date("2024-01-01T00:00:00.000Z"),
    nowIso: () => "2024-01-01T00:00:00.000Z",
    sleep: () => Promise.resolve(),
  };
}

describe("SqliteCursorStore", () => {
  let store: SqliteCursorStore;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    store = new SqliteCursorStore(db, createFakeClock());
  });

  it("returns undefined for a tab with no cursor", async () => {
    await expect(store.get("tab_1")).resolves.toBeUndefined();
  });

  it("round-trips set/get", async () => {
    await store.set({ tabId: "tab_1", anchorPaneId: "pane_1", nextDirection: "right" });
    await expect(store.get("tab_1")).resolves.toEqual({
      tabId: "tab_1",
      anchorPaneId: "pane_1",
      nextDirection: "right",
    });
  });

  it("set upserts an existing cursor rather than erroring", async () => {
    await store.set({ tabId: "tab_1", anchorPaneId: "pane_1", nextDirection: "right" });
    await store.set({ tabId: "tab_1", anchorPaneId: "pane_2", nextDirection: "down" });

    await expect(store.get("tab_1")).resolves.toEqual({
      tabId: "tab_1",
      anchorPaneId: "pane_2",
      nextDirection: "down",
    });
  });

  it("delete removes the cursor", async () => {
    await store.set({ tabId: "tab_1", anchorPaneId: "pane_1", nextDirection: "right" });
    await store.delete("tab_1");
    await expect(store.get("tab_1")).resolves.toBeUndefined();
  });
});
