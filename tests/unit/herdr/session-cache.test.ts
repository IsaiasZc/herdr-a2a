import { describe, expect, it } from "vitest";

import { HerdrSessionCache } from "../../../src/herdr/session-cache.js";
import { FakeHerdr, RecordingEvents, TestClock, logger } from "../../fault-injection/helpers/fakes.js";

/**
 * `focusedContext()` is the fallback signal for tab targeting (see
 * src/a2a/caller-context.ts for the primary, per-caller mechanism): it must
 * seed from the boot-time snapshot and then track Herdr's live focus events,
 * since the snapshot alone goes stale the moment the human switches tabs.
 */
describe("HerdrSessionCache.focusedContext", () => {
  function build() {
    const herdr = new FakeHerdr();
    const cache = new HerdrSessionCache({ herdr, clock: new TestClock(), logger, events: new RecordingEvents() });
    return { herdr, cache };
  }

  it("is undefined before the cache has primed", () => {
    const { cache } = build();
    expect(cache.focusedContext()).toBeUndefined();
  });

  it("seeds from the boot-time session.snapshot", async () => {
    const { cache } = build();
    await cache.start();
    expect(cache.focusedContext()).toEqual({ workspaceId: "w", tabId: "w:t", paneId: "p1" });
  });

  it("tracks a live tab.focused event without disturbing the focused pane", async () => {
    const { herdr, cache } = build();
    await cache.start();

    herdr.emit("tab.focused", { tab_id: "w:t2", workspace_id: "w2" });

    expect(cache.focusedContext()).toEqual({ workspaceId: "w2", tabId: "w:t2", paneId: "p1" });
  });

  it("tracks a live pane.focused event", async () => {
    const { herdr, cache } = build();
    await cache.start();

    herdr.emit("pane.focused", { pane_id: "p9", workspace_id: "w3" });

    expect(cache.focusedContext()).toEqual({ workspaceId: "w3", tabId: "w:t", paneId: "p9" });
  });

  it("tracks a live workspace.focused event", async () => {
    const { herdr, cache } = build();
    await cache.start();

    herdr.emit("workspace.focused", { workspace_id: "w4" });

    expect(cache.focusedContext()).toEqual({ workspaceId: "w4", tabId: "w:t", paneId: "p1" });
  });
});
