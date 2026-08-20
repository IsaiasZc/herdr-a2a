import { beforeEach, describe, expect, it } from "vitest";

import type { Clock } from "../../../src/core/ports.js";
import { openDatabase } from "../../../src/persistence/db.js";
import { SqliteLaunchabilityCache } from "../../../src/persistence/repositories/launchability-cache.js";

function createFakeClock(): Clock {
  return {
    now: () => new Date("2024-01-01T00:00:00.000Z"),
    nowIso: () => "2024-01-01T00:00:00.000Z",
    sleep: () => Promise.resolve(),
  };
}

describe("SqliteLaunchabilityCache", () => {
  let cache: SqliteLaunchabilityCache;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    cache = new SqliteLaunchabilityCache(db, createFakeClock());
  });

  it("returns undefined for an unknown kind", async () => {
    await expect(cache.get("codex")).resolves.toBeUndefined();
  });

  it("round-trips set/get including executablePath", async () => {
    await cache.set("codex", {
      launchable: "yes",
      reason: "found on PATH",
      executablePath: "/usr/local/bin/codex",
      checkedAt: "2024-01-01T00:00:00.000Z",
    });

    await expect(cache.get("codex")).resolves.toEqual({
      launchable: "yes",
      reason: "found on PATH",
      executablePath: "/usr/local/bin/codex",
      checkedAt: "2024-01-01T00:00:00.000Z",
    });
  });

  it("set upserts rather than duplicating", async () => {
    await cache.set("codex", { launchable: "unknown", reason: "not checked", checkedAt: "t0" });
    await cache.set("codex", { launchable: "no", reason: "not on PATH", checkedAt: "t1" });

    await expect(cache.get("codex")).resolves.toEqual({
      launchable: "no",
      reason: "not on PATH",
      checkedAt: "t1",
    });
  });

  it("invalidate(kind) removes a single entry", async () => {
    await cache.set("codex", { launchable: "yes", reason: "ok", checkedAt: "t0" });
    await cache.set("claude", { launchable: "yes", reason: "ok", checkedAt: "t0" });

    await cache.invalidate("codex");

    await expect(cache.get("codex")).resolves.toBeUndefined();
    await expect(cache.get("claude")).resolves.toBeDefined();
  });

  it("invalidate() with no kind clears everything", async () => {
    await cache.set("codex", { launchable: "yes", reason: "ok", checkedAt: "t0" });
    await cache.set("claude", { launchable: "yes", reason: "ok", checkedAt: "t0" });

    await cache.invalidate();

    await expect(cache.get("codex")).resolves.toBeUndefined();
    await expect(cache.get("claude")).resolves.toBeUndefined();
  });
});
