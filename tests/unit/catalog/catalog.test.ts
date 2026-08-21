import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { AgentCatalogImpl } from "../../../src/catalog/catalog.js";
import { InMemoryLaunchabilityCache } from "../../../src/catalog/cache.js";
import { CustomRegistry } from "../../../src/catalog/custom-registry.js";
import {
  HerdrDiscoveryImpl,
  parseAgentUsage,
  parseIntegrationUsage,
} from "../../../src/catalog/herdr-discovery.js";
import { LaunchabilityResolverImpl } from "../../../src/catalog/launchability.js";
import { DelegationFailure } from "../../../src/core/errors.js";
import type { AgentInfo, AgentManifestStatus } from "../../../src/herdr/types.js";
import { loadSchema } from "../../../src/herdr/schema-loader.js";

const ROOT = join(process.cwd());
const fixture = (name: string) => readFile(join(ROOT, "tests/fixtures/herdr", name), "utf8");

const emptyManifests: AgentManifestStatus = { manifests: [] };
const noEvents = { emit: () => {} };
const clock = (now = 0) => ({ now: () => new Date(now), nowIso: () => new Date(now).toISOString(), sleep: async () => {} });

describe("dynamic Herdr discovery", () => {
  test("parses every startable kind from captured herdr agent usage", async () => {
    expect(parseAgentUsage(await fixture("cli-agent-usage.txt"))).toHaveLength(21);
  });

  test("keeps integrations separate so an integration-only kind is not startable", async () => {
    const integrations = parseIntegrationUsage(await fixture("cli-integration-usage.txt"));
    const startable = parseAgentUsage(await fixture("cli-agent-usage.txt"));
    expect(integrations).toContain("antigravity-cli");
    expect(startable).not.toContain("antigravity-cli");
  });

  test("fails rather than treating missing kinds output as an empty successful catalog", async () => {
    const discovery = new HerdrDiscoveryImpl({
      binPath: "/fake/herdr",
      client: { agentManifests: async () => emptyManifests } as never,
      runCommand: async () => ({ stdout: "usage only", stderr: "", code: 0 }),
    });
    await expect(discovery.supportedKinds()).rejects.toMatchObject({ code: "HERDR_API_ERROR", details: { stdout: "usage only" } });
  });
});

describe("catalog composition", () => {
  test("keeps CLI-only kinds while surfacing manifest provenance", async () => {
    const usage = await fixture("cli-agent-usage.txt");
    const manifests = JSON.parse(await fixture("agent-manifests.json")).result as AgentManifestStatus;
    const catalog = makeCatalog({ usage, manifests, agents: [] });
    const runtimes = await catalog.list();
    for (const name of ["omp", "mastracode"]) {
      expect(runtimes.find((entry) => entry.name === name)?.runtime).toMatchObject({
        supportedByHerdr: true,
        hasDetectionManifest: false,
      });
    }
  });

  test("follows changed live discovery without a source edit", async () => {
    const catalog = makeCatalog({ usage: "kinds: newly-installed\n", manifests: emptyManifests, agents: [] });
    expect((await catalog.list()).map((entry) => entry.name)).toEqual(["newly-installed"]);
  });

  test("does not promote an integration-only kind into the startable catalog", async () => {
    const catalog = makeCatalog({
      usage: "kinds: runtime-a\n",
      integrationUsage: "  herdr integration install integration-only\n",
      manifests: emptyManifests,
      agents: [],
    });
    expect(await catalog.get("integration-only")).toBeUndefined();
  });

  test("counts running instances from live agents", async () => {
    const snapshot = JSON.parse(await fixture("session-snapshot.json")).result.snapshot;
    const catalog = makeCatalog({ usage: await fixture("cli-agent-usage.txt"), manifests: emptyManifests, agents: snapshot.agents });
    const descriptors = await catalog.list();
    expect(descriptors.find((entry) => entry.name === "codex")?.runtime.runningInstances).toBe(1);
    expect(descriptors.find((entry) => entry.name === "claude")?.runtime.runningInstances).toBe(1);
  });

  test("reflects a pane close in runningInstances without waiting for the TTL", async () => {
    let agents: AgentInfo[] = JSON.parse(await fixture("session-snapshot.json")).result.snapshot.agents;
    const catalog = makeCatalog({
      usage: await fixture("cli-agent-usage.txt"),
      manifests: emptyManifests,
      agents: [],
      liveAgents: () => agents,
    });
    await catalog.refresh();
    expect((await catalog.get("codex"))?.runtime.runningInstances).toBe(1);

    // The session cache updates instantly on `pane.closed` — well inside the
    // catalog's TTL, which is meant to bound expensive launchability probes,
    // not this already-live count.
    agents = agents.filter((agent) => agent.agent !== "codex");
    expect((await catalog.get("codex"))?.runtime.runningInstances).toBe(0);
    expect((await catalog.list()).find((entry) => entry.name === "codex")?.runtime.sources).not.toContain("herdr-session");
  });

  test("resolves custom profiles without replacing discovered runtimes", async () => {
    const catalog = makeCatalog({
      usage: "kinds: runtime-a\n",
      manifests: emptyManifests,
      agents: [],
      profiles: { reviewer: { name: "reviewer", runtime: "runtime-a" } },
    });
    expect((await catalog.get("reviewer"))?.available).toBe(true);
    expect((await catalog.get("runtime-a"))?.descriptorKind).toBe("runtime");
  });

  test("marks a custom profile with a missing runtime unavailable", async () => {
    const catalog = makeCatalog({
      usage: "kinds: runtime-a\n",
      manifests: emptyManifests,
      agents: [],
      profiles: { absent: { name: "absent", runtime: "gone" } },
    });
    expect(await catalog.get("absent")).toMatchObject({
      available: false,
      unavailableReason: expect.stringContaining("CUSTOM_AGENT_RUNTIME_UNAVAILABLE"),
    });
  });

  test("marks a custom profile unavailable when its discovered runtime cannot launch", async () => {
    const catalog = makeCatalog({
      usage: "kinds: runtime-a\n",
      manifests: emptyManifests,
      agents: [],
      profiles: { blocked: { name: "blocked", runtime: "runtime-a" } },
      launchable: "no",
    });
    expect(await catalog.get("blocked")).toMatchObject({
      available: false,
      unavailableReason: expect.stringContaining("CUSTOM_AGENT_RUNTIME_UNAVAILABLE"),
    });
  });

  test("surfaces a custom name collision with a base runtime", async () => {
    const catalog = makeCatalog({
      usage: "kinds: runtime-a\n",
      manifests: emptyManifests,
      agents: [],
      profiles: { "runtime-a": { name: "runtime-a", runtime: "runtime-a" } },
    });
    await expect(catalog.refresh()).rejects.toMatchObject({ code: "INVALID_EXECUTION_OPTION" });
  });

  test("shares one in-progress refresh", async () => {
    let calls = 0;
    const catalog = makeCatalog({ usage: "kinds: runtime-a\n", manifests: emptyManifests, agents: [], onDiscovery: () => { calls += 1; } });
    await Promise.all([catalog.refresh(), catalog.refresh(), catalog.refresh()]);
    expect(calls).toBe(1);
  });

  test("emits a runtime availability change on a later refresh", async () => {
    const events: string[] = [];
    let launchable: "yes" | "no" = "yes";
    const catalog = makeCatalog({
      usage: "kinds: runtime-a\n",
      manifests: emptyManifests,
      agents: [],
      launchable: () => launchable,
    }, { emit: (event) => events.push(event) });
    await catalog.refresh();
    launchable = "no";
    await catalog.refresh();
    expect(events).toContain("catalog.runtime.changed");
  });
});

describe("launchability", () => {
  test("uses the cached probe within its TTL and reprobes after invalidation", async () => {
    let probes = 0;
    let now = 0;
    const resolver = new LaunchabilityResolverImpl({
      cache: new InMemoryLaunchabilityCache(),
      ttlMs: 1_000,
      clock: { now: () => new Date(now) },
      path: "/bin",
      existsExecutable: async () => { probes += 1; return true; },
    });
    await resolver.resolve("runtime-a");
    await resolver.resolve("runtime-a");
    expect(probes).toBe(1);
    now = 1_001;
    await resolver.resolve("runtime-a");
    expect(probes).toBe(2);
    await resolver.invalidate("runtime-a");
    await resolver.resolve("runtime-a");
    expect(probes).toBe(3);
  });

  test("reports unknown when an authoritative source cannot infer the executable name", async () => {
    const resolver = new LaunchabilityResolverImpl({
      cache: new InMemoryLaunchabilityCache(),
      ttlMs: 1_000,
      clock: clock(),
      commandHintForKind: () => null,
      existsExecutable: async () => { throw new Error("unknown names must not be guessed"); },
    });
    await expect(resolver.resolve("runtime-label")).resolves.toMatchObject({ launchable: "unknown" });
  });

  test("uses a manifest command hint instead of assuming the kind label is a binary", async () => {
    const checked: string[] = [];
    const resolver = new LaunchabilityResolverImpl({
      cache: new InMemoryLaunchabilityCache(),
      ttlMs: 1_000,
      clock: clock(),
      path: "/bin",
      commandHintForKind: () => "actual-binary",
      existsExecutable: async (path) => { checked.push(path); return true; },
    });
    await expect(resolver.resolve("runtime-label")).resolves.toMatchObject({ executablePath: "/bin/actual-binary" });
    expect(checked).toEqual(["/bin/actual-binary"]);
  });
});

describe("schema capability inspection", () => {
  test("names exactly the missing methods", async () => {
    const schema = await fixture("schema.json");
    const info = await loadSchema({
      binPath: "/fake/herdr-schema",
      runCommand: async () => ({ stdout: schema, stderr: "", code: 0 }),
    });
    expect(() => info.assertMethods(["agent.list", "definitely.missing"])).toThrow(/definitely\.missing/);
  });
});

// §55.1: prevent a future edit from quietly replacing live discovery with a default base-agent list.
test("catalog sources contain no hardcoded multi-kind agent list", async () => {
  const roots = [join(ROOT, "src/catalog"), join(ROOT, "src/herdr")];
  const files = (await Promise.all(roots.map(async (root) => (await readdir(root))
    .filter((file) => root.endsWith("catalog") || file === "schema-loader.ts")
    .map((file) => join(root, file))))).flat();
  const source = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const knownKinds = new Set("pi claude codex gemini cursor devin agy cline omp mastracode opencode copilot kimi kiro droid amp grok hermes kilo qodercli maki".split(" "));
  for (const literal of source.join("\n").match(/\[[^\[\]]*\]/g) ?? []) {
    const kinds = [...literal.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]).filter((kind): kind is string => kind !== undefined && knownKinds.has(kind));
    expect(kinds.length, `hardcoded base kinds in ${literal}`).toBeLessThanOrEqual(1);
  }
});

function makeCatalog(input: {
  usage: string;
  manifests: AgentManifestStatus;
  agents: AgentInfo[];
  profiles?: Record<string, { name: string; runtime: string }>;
  onDiscovery?: () => void;
  launchable?: "yes" | "no" | "unknown" | (() => "yes" | "no" | "unknown");
  integrationUsage?: string;
  liveAgents?: () => AgentInfo[];
}, events = noEvents): AgentCatalogImpl {
  const discovery = new HerdrDiscoveryImpl({
    binPath: "/fake/herdr",
    client: { agentManifests: async () => input.manifests } as never,
    runCommand: async (argv) => {
      if (argv[1] === "agent") input.onDiscovery?.();
      return { stdout: argv[1] === "integration" ? input.integrationUsage ?? input.usage : input.usage, stderr: "", code: 0 };
    },
  });
  return new AgentCatalogImpl({
    discovery,
    launchability: { resolve: async () => ({ launchable: typeof input.launchable === "function" ? input.launchable() : input.launchable ?? "yes", reason: "test" }), invalidate: async () => {} },
    customRegistry: new CustomRegistry(input.profiles ?? {}),
    liveAgents: input.liveAgents ?? (() => input.agents),
    eventSink: events,
    clock: clock(),
    ttlMs: 1_000,
  });
}
