import { describe, expect, it } from "vitest";

import type { Clock } from "../../../src/core/ports.js";
import { LaunchabilityResolverImpl } from "../../../src/catalog/launchability.js";
import { InMemoryLaunchabilityCache } from "../../../src/catalog/cache.js";

function createFakeClock(): Clock {
  return {
    now: () => new Date("2024-01-01T00:00:00.000Z"),
    nowIso: () => "2024-01-01T00:00:00.000Z",
    sleep: () => Promise.resolve(),
  };
}

// Windows never ships a bare `claude` file — only `claude.exe` — the same way
// `notepad` on PATH really means `notepad.exe`. A resolver that checks only
// the exact literal name reports every Windows-native CLI as not launchable.
describe("LaunchabilityResolverImpl on win32", () => {
  it("resolves an executable that only exists with a PATHEXT suffix", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const resolver = new LaunchabilityResolverImpl({
        cache: new InMemoryLaunchabilityCache(),
        ttlMs: 60_000,
        clock: createFakeClock(),
        path: "C:\\bin",
        existsExecutable: async (candidate) => candidate.toLowerCase() === "c:\\bin\\claude.exe",
      });

      const result = await resolver.resolve("claude");

      expect(result.launchable).toBe("yes");
      expect(result.executablePath?.toLowerCase()).toBe("c:\\bin\\claude.exe");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("reports not launchable when no PATHEXT suffix matches", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const resolver = new LaunchabilityResolverImpl({
        cache: new InMemoryLaunchabilityCache(),
        ttlMs: 60_000,
        clock: createFakeClock(),
        path: "C:\\bin",
        existsExecutable: async () => false,
      });

      const result = await resolver.resolve("claude");

      expect(result.launchable).toBe("no");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
