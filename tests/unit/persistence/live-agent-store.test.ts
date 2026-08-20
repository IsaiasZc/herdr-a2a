import { beforeEach, describe, expect, it } from "vitest";

import type { LiveAgent } from "../../../src/core/model.js";
import type { Clock } from "../../../src/core/ports.js";
import { openDatabase } from "../../../src/persistence/db.js";
import { SqliteLiveAgentStore } from "../../../src/persistence/repositories/live-agent-store.js";

function createFakeClock(startIso = "2024-01-01T00:00:00.000Z"): Clock {
  return {
    now: () => new Date(startIso),
    nowIso: () => startIso,
    sleep: () => Promise.resolve(),
  };
}

function makeAgent(overrides: Partial<LiveAgent> = {}): LiveAgent {
  return {
    instanceId: "inst_1",
    logicalTarget: "codex",
    runtimeKind: "codex",
    herdrAgentName: "codex-a81f",
    paneId: "pane_1",
    terminalId: "term_1",
    sessionRef: "sess_1",
    workspaceId: "ws_1",
    tabId: "tab_1",
    cwd: "/home/user/project",
    visibility: "visible",
    model: "gpt-5",
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("SqliteLiveAgentStore", () => {
  let store: SqliteLiveAgentStore;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    store = new SqliteLiveAgentStore(db, createFakeClock());
  });

  it("round-trips put/get", async () => {
    const agent = makeAgent();
    await store.put(agent);
    await expect(store.get("inst_1")).resolves.toEqual(agent);
  });

  it("put upserts rather than duplicating", async () => {
    await store.put(makeAgent({ instanceId: "inst_1", paneId: "pane_1" }));
    await store.put(makeAgent({ instanceId: "inst_1", paneId: "pane_2" }));

    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.paneId).toBe("pane_2");
  });

  it("byLogicalTarget filters by logical target", async () => {
    await store.put(makeAgent({ instanceId: "inst_1", logicalTarget: "codex" }));
    await store.put(makeAgent({ instanceId: "inst_2", logicalTarget: "codex" }));
    await store.put(makeAgent({ instanceId: "inst_3", logicalTarget: "claude" }));

    const codexAgents = await store.byLogicalTarget("codex");
    expect(codexAgents.map((a) => a.instanceId).sort()).toEqual(["inst_1", "inst_2"]);
  });

  it("delete removes the row", async () => {
    await store.put(makeAgent({ instanceId: "inst_1" }));
    await store.delete("inst_1");
    await expect(store.get("inst_1")).resolves.toBeUndefined();
  });

  it("handles optional fields being absent", async () => {
    const agent = makeAgent({
      instanceId: "inst_headless",
      terminalId: undefined,
      sessionRef: undefined,
      workspaceId: undefined,
      tabId: undefined,
      model: undefined,
    });
    await store.put(agent);

    const fetched = await store.get("inst_headless");
    expect(fetched?.terminalId).toBeUndefined();
    expect(fetched?.sessionRef).toBeUndefined();
    expect(fetched?.model).toBeUndefined();
  });
});
