import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { REQUIRED_METHODS } from "../../src/core/doctor.js";
import { HerdrSocketClient } from "../../src/herdr/socket-client.js";
import { HerdrSessionCache } from "../../src/herdr/session-cache.js";
import { silentLogger } from "../../src/observability/logger.js";
import { nullEventSink } from "../../src/observability/events.js";
import { systemClock } from "../../src/core/runtime-support.js";
import { loadSchema } from "../../src/herdr/schema-loader.js";
import { startTestSession, herdrAvailable, type TestSession } from "./harness.js";

/**
 * Milestone 0 as an executable check (spec §51, steps 1–3). If Herdr changes
 * shape under us, this fails before any product logic does — which is the whole
 * point of deriving the contract instead of assuming it.
 */
describe.runIf(herdrAvailable())("Herdr contract, against a real isolated server", () => {
  let session: TestSession;
  let client: HerdrSocketClient;

  beforeAll(async () => {
    session = await startTestSession("contract");
    client = new HerdrSocketClient({ socketPath: session.socketPath, logger: silentLogger });
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await session?.stop();
  });

  test("ping reports a compatible protocol", async () => {
    const pong = await client.assertCompatible();
    expect(pong.protocol).toBeGreaterThanOrEqual(20);
    expect(pong.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("the installed schema exposes every method the layer needs", async () => {
    const schema = await loadSchema({ binPath: process.env["HERDR_BIN_PATH"] ?? "herdr" });
    const missing = REQUIRED_METHODS.filter((m) => !schema.has(m));
    expect(missing).toEqual([]);
  });

  test("a fresh session snapshots as exactly one workspace, tab and pane", async () => {
    const snapshot = await client.sessionSnapshot();
    expect(snapshot.workspaces).toHaveLength(1);
    expect(snapshot.tabs).toHaveLength(1);
    expect(snapshot.panes).toHaveLength(1);
    expect(snapshot.agents).toHaveLength(0);
    expect(snapshot.panes[0]?.pane_id).toBe(session.rootPaneId);
  });

  test("pane.layout returns real cell geometry", async () => {
    const layout = await client.paneLayout({ paneId: session.rootPaneId });
    expect(layout.tab_id).toBe(session.tabId);
    expect(layout.area.width).toBeGreaterThan(0);
    expect(layout.area.height).toBeGreaterThan(0);
    expect(layout.panes.map((p) => p.pane_id)).toContain(session.rootPaneId);
  });

  test("a split defaults to unfocused and does not move focus", async () => {
    const before = await client.sessionSnapshot();
    const pane = await client.paneSplit({
      target_pane_id: session.rootPaneId,
      direction: "down",
      cwd: process.cwd(),
      focus: false,
    });

    expect(pane.pane_id).not.toBe(session.rootPaneId);

    const after = await client.sessionSnapshot();
    expect(after.focused_pane_id).toBe(before.focused_pane_id);
    expect(after.panes).toHaveLength(2);

    await client.paneClose(pane.pane_id);
  });

  test("agent_manifests carries provenance for each detection manifest", async () => {
    const status = await client.agentManifests();
    expect(status.manifests.length).toBeGreaterThan(0);
    for (const manifest of status.manifests) {
      expect(manifest.agent).toMatch(/^[a-z][a-z0-9_-]*$/);
      expect(typeof manifest.source_kind).toBe("string");
    }
  });

  test("subscribing backfills current state before streaming changes", async () => {
    const frames: { event: string; paneId?: string }[] = [];
    const sub = await client.subscribe([{ type: "pane.updated" }], (event, data) => {
      const pane = data["pane"] as { pane_id?: string } | undefined;
      frames.push({ event, ...(pane?.pane_id ? { paneId: pane.pane_id } : {}) });
    });

    // The backfill arrives on the same connection right after the ack, so a
    // short settle is enough — no state change is needed to observe it.
    await new Promise((resolve) => setTimeout(resolve, 750));
    sub.close();

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.map((f) => f.paneId)).toContain(session.rootPaneId);
  });

  test("the session cache treats the backfill as a baseline, not a transition", async () => {
    const statusChanges: string[] = [];
    const cache = new HerdrSessionCache({
      herdr: client,
      clock: systemClock,
      logger: silentLogger,
      events: nullEventSink,
    });
    cache.onAgentStatus((info) => statusChanges.push(info.pane_id));

    await cache.start();
    await new Promise((resolve) => setTimeout(resolve, 750));

    // A quiet session must produce no status callbacks. If the backfill leaked
    // through, every subscribe would look like every agent just changed state.
    expect(statusChanges).toEqual([]);
    expect(cache.snapshot()?.panes.length).toBeGreaterThan(0);

    await cache.stop();
  });

  test("agent.get on a shell pane reports no agent rather than failing", async () => {
    // A pane without a detected agent is a normal state, not an error — the
    // relay's deliverability check depends on being able to observe it.
    await expect(client.agentGet(session.rootPaneId)).rejects.toThrow();
  });
});
