import { describe, expect, test, vi } from "vitest";

import { ERROR_CODES } from "../../src/core/errors.js";
import { DefaultSpawnManager } from "../../src/spawn/spawn-manager.js";
import { DefaultPreflight } from "../../src/spawn/preflight.js";
import { createStores } from "../../src/persistence/index.js";
import { FakeHerdr, FakeLayout, FixedPreflight, NeverReuse, RecordingEvents, TestClock, adapters, agent, descriptor, flush, ids, logger, pane } from "./helpers/fakes.js";

function request(overrides: Record<string, unknown> = {}) {
  return { descriptor: descriptor(), cwd: "/tmp", visibility: "visible" as const, callerPaneId: "caller", callerTabId: "w:t", callerWorkspaceId: "w", ...overrides };
}
function manager(herdr: FakeHerdr, layout: FakeLayout, clock: TestClock, preflight = new FixedPreflight({ ok: true, checks: [] })) {
  const stores = createStores({ dbPath: ":memory:", clock });
  const m = new DefaultSpawnManager({ herdr, layout, preflight, reuse: new NeverReuse(), liveAgents: stores.liveAgents, adapters, ids, clock, config: { recovery: { maxLaunchAttempts: 2, maxDeliveryAttempts: 1 } }, events: new RecordingEvents(), logger });
  return { m, stores };
}

describe("fault injection: spawn", () => {
  test("schema/protocol mismatch fails preflight with HERDR_PROTOCOL_UNSUPPORTED before allocating a pane", async () => {
    vi.useFakeTimers();
    const clock = new TestClock(); const herdr = new FakeHerdr();
    herdr.ping = async () => { herdr.calls.ping += 1; return { version: "0.8.0", protocol: 19, capabilities: {} }; };
    const preflight = new DefaultPreflight({ herdr, adapters, events: new RecordingEvents(), logger, statDir: async () => ({ isDirectory: () => true }) });
    const layout = new FakeLayout(); const { m, stores } = manager(herdr, layout, clock, preflight);
    await expect(m.resolveOrSpawn(request())).rejects.toMatchObject({ code: ERROR_CODES.HERDR_PROTOCOL_UNSUPPORTED });
    expect(herdr.calls).toMatchObject({ ping: 1, paneProcessInfo: 0, agentStart: 0 });
    expect(layout.allocated).toEqual([]); stores.close(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });

  test("runtime start timeout exhausts exactly two starts and releases the allocated pane", async () => {
    vi.useFakeTimers();
    const clock = new TestClock(); const herdr = new FakeHerdr(); const layout = new FakeLayout([pane("p1")]);
    herdr.startImpl = async () => { throw new Error("agent.start timeout"); };
    herdr.getScript = [agent("one", { agent: null }), agent("one", { agent: null })];
    const { m, stores } = manager(herdr, layout, clock);
    await expect(m.resolveOrSpawn(request())).rejects.toMatchObject({ code: ERROR_CODES.RUNTIME_START_TIMEOUT });
    expect(herdr.calls).toMatchObject({ paneProcessInfo: 1, agentStart: 2, paneGet: 2, agentGet: 2, agentSendKeys: 0 });
    expect(layout.released).toEqual(["p1"]); stores.close(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });

  test("a custom runtime removed between discovery and spawn returns CUSTOM_AGENT_RUNTIME_UNAVAILABLE without creating a pane", async () => {
    vi.useFakeTimers();
    const clock = new TestClock(); const herdr = new FakeHerdr(); const layout = new FakeLayout();
    const preflight = new FixedPreflight({ ok: false, checks: [{ name: "descriptor_available", ok: false, detail: "runtime disappeared" }] });
    const { m, stores } = manager(herdr, layout, clock, preflight);
    await expect(m.resolveOrSpawn(request({ descriptor: descriptor({ descriptorKind: "custom", name: "reviewer" }) }))).rejects.toMatchObject({ code: ERROR_CODES.CUSTOM_AGENT_RUNTIME_UNAVAILABLE });
    expect(herdr.calls).toMatchObject({ paneProcessInfo: 0, agentStart: 0 });
    expect(layout.allocated).toEqual([]); stores.close(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });

  test("a not-yet-available shell is probed only 50 times before a single start attempt", async () => {
    vi.useFakeTimers();
    const clock = new TestClock(); const herdr = new FakeHerdr(); const layout = new FakeLayout([pane("p1")]);
    herdr.processScript = Array.from({ length: 50 }, () => ({ pane_id: "p1", shell_pid: 10, foreground_process_group_id: 99, foreground_processes: [{ pid: 99, name: "editor", argv: ["vim"], cmdline: "vim" }] }));
    const { m, stores } = manager(herdr, layout, clock);
    await m.resolveOrSpawn(request()); await flush();
    expect(herdr.calls).toMatchObject({ paneProcessInfo: 50, agentStart: 1, paneGet: 0, agentGet: 0 });
    expect(clock.sleeps).toHaveLength(50); expect(layout.released).toEqual([]);
    stores.close(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });
});
