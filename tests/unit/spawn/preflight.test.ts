import { describe, expect, it } from "vitest";

import { DefaultPreflight } from "../../../src/spawn/preflight.js";
import { DelegationFailure, ERROR_CODES } from "../../../src/core/errors.js";
import { nullEventSink } from "../../../src/observability/events.js";
import { silentLogger } from "../../../src/observability/logger.js";
import { REQUIRED_PROTOCOL } from "../../../src/herdr/types.js";
import type { HerdrClient, RuntimeAdapter, RuntimeAdapterRegistry } from "../../../src/core/ports.js";
import type { AgentDescriptor, SpawnRequest } from "../../../src/core/model.js";
import type { PongResult } from "../../../src/herdr/types.js";

function descriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    name: "codex",
    descriptorKind: "runtime",
    runtimeKind: "codex",
    available: true,
    runtime: {
      kind: "codex",
      supportedByHerdr: true,
      hasDetectionManifest: true,
      hasIntegration: true,
      launchable: "yes",
      runningInstances: 0,
      sources: ["herdr-cli-kinds"],
    },
    description: "codex runtime",
    ...overrides,
  };
}

function baseReq(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    descriptor: descriptor(),
    cwd: "/work/project",
    visibility: "visible",
    ...overrides,
  };
}

class FakeHerdrClient implements HerdrClient {
  constructor(private readonly pingImpl: () => Promise<PongResult>) {}
  ping(): ReturnType<HerdrClient["ping"]> {
    return this.pingImpl();
  }
  sessionSnapshot(): ReturnType<HerdrClient["sessionSnapshot"]> {
    throw new Error("unexpected call to sessionSnapshot");
  }
  agentManifests(): ReturnType<HerdrClient["agentManifests"]> {
    throw new Error("unexpected call to agentManifests");
  }
  agentList(): ReturnType<HerdrClient["agentList"]> {
    throw new Error("unexpected call to agentList");
  }
  agentGet(): ReturnType<HerdrClient["agentGet"]> {
    throw new Error("unexpected call to agentGet");
  }
  agentStart(): ReturnType<HerdrClient["agentStart"]> {
    throw new Error("unexpected call to agentStart");
  }
  agentPrompt(): ReturnType<HerdrClient["agentPrompt"]> {
    throw new Error("unexpected call to agentPrompt");
  }
  agentWait(): ReturnType<HerdrClient["agentWait"]> {
    throw new Error("unexpected call to agentWait");
  }
  agentRead(): ReturnType<HerdrClient["agentRead"]> {
    throw new Error("unexpected call to agentRead");
  }
  agentSendKeys(): ReturnType<HerdrClient["agentSendKeys"]> {
    throw new Error("unexpected call to agentSendKeys");
  }
  paneSplit(): ReturnType<HerdrClient["paneSplit"]> {
    throw new Error("unexpected call to paneSplit");
  }
  paneGet(): ReturnType<HerdrClient["paneGet"]> {
    throw new Error("unexpected call to paneGet");
  }
  paneList(): ReturnType<HerdrClient["paneList"]> {
    throw new Error("unexpected call to paneList");
  }
  paneClose(): ReturnType<HerdrClient["paneClose"]> {
    throw new Error("unexpected call to paneClose");
  }
  paneLayout(): ReturnType<HerdrClient["paneLayout"]> {
    throw new Error("unexpected call to paneLayout");
  }
  tabCreate(): ReturnType<HerdrClient["tabCreate"]> {
    throw new Error("unexpected call to tabCreate");
  }
  subscribe(): ReturnType<HerdrClient["subscribe"]> {
    throw new Error("unexpected call to subscribe");
  }
  async close(): Promise<void> {}
}

function okPing(): Promise<PongResult> {
  return Promise.resolve({ version: "0.8.0", protocol: REQUIRED_PROTOCOL, capabilities: {} });
}

function makeAdapters(adapter: RuntimeAdapter): RuntimeAdapterRegistry {
  return { for: () => adapter };
}

function makeStatDir(isDir: boolean): (path: string) => Promise<{ isDirectory(): boolean }> {
  return async () => ({ isDirectory: () => isDir });
}

describe("DefaultPreflight.run", () => {
  it("passes every check for a healthy request", async () => {
    const preflight = new DefaultPreflight({
      herdr: new FakeHerdrClient(okPing),
      adapters: makeAdapters({ kind: "codex" }),
      events: nullEventSink,
      logger: silentLogger,
      statDir: makeStatDir(true),
    });

    const report = await preflight.run(baseReq());
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  it("reports herdr_reachable as failing when ping rejects", async () => {
    const preflight = new DefaultPreflight({
      herdr: new FakeHerdrClient(() => Promise.reject(new Error("ECONNREFUSED"))),
      adapters: makeAdapters({ kind: "codex" }),
      events: nullEventSink,
      logger: silentLogger,
      statDir: makeStatDir(true),
    });

    const report = await preflight.run(baseReq());
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "herdr_reachable")?.ok).toBe(false);
  });

  it("reports herdr_protocol_compatible as failing on a protocol mismatch", async () => {
    const preflight = new DefaultPreflight({
      herdr: new FakeHerdrClient(() => Promise.resolve({ version: "0.8.0", protocol: REQUIRED_PROTOCOL + 1, capabilities: {} })),
      adapters: makeAdapters({ kind: "codex" }),
      events: nullEventSink,
      logger: silentLogger,
      statDir: makeStatDir(true),
    });

    const report = await preflight.run(baseReq());
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "herdr_protocol_compatible")?.ok).toBe(false);
  });

  it("reports descriptor_available as failing when the descriptor is unavailable", async () => {
    const preflight = new DefaultPreflight({
      herdr: new FakeHerdrClient(okPing),
      adapters: makeAdapters({ kind: "codex" }),
      events: nullEventSink,
      logger: silentLogger,
      statDir: makeStatDir(true),
    });

    const report = await preflight.run(baseReq({ descriptor: descriptor({ available: false, unavailableReason: "not on PATH" }) }));
    expect(report.ok).toBe(false);
    const check = report.checks.find((c) => c.name === "descriptor_available");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toBe("not on PATH");
  });

  it("reports cwd_exists as failing when the cwd is not a directory", async () => {
    const preflight = new DefaultPreflight({
      herdr: new FakeHerdrClient(okPing),
      adapters: makeAdapters({ kind: "codex" }),
      events: nullEventSink,
      logger: silentLogger,
      statDir: makeStatDir(false),
    });

    const report = await preflight.run(baseReq());
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "cwd_exists")?.ok).toBe(false);
  });

  it("lets a MODEL_UNSUPPORTED failure from the adapter propagate untouched", async () => {
    const adapter: RuntimeAdapter = {
      kind: "codex",
      validateOptions: async () => {
        throw new DelegationFailure(ERROR_CODES.MODEL_UNSUPPORTED, "codex does not support model 'nope'");
      },
    };
    const preflight = new DefaultPreflight({
      herdr: new FakeHerdrClient(okPing),
      adapters: makeAdapters(adapter),
      events: nullEventSink,
      logger: silentLogger,
      statDir: makeStatDir(true),
    });

    await expect(preflight.run(baseReq({ model: "nope" }))).rejects.toMatchObject({
      code: ERROR_CODES.MODEL_UNSUPPORTED,
    });
  });
});
