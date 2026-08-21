import { afterEach, describe, expect, it } from "vitest";

import { A2AGateway } from "../../../src/a2a/server.js";
import { cardForDescriptor } from "../../../src/a2a/cards.js";
import type { AgentDescriptor } from "../../../src/core/model.js";
import type { GatewayOptions } from "../../../src/a2a/server.js";

const descriptor: AgentDescriptor = {
  name: "codex",
  descriptorKind: "runtime",
  runtimeKind: "codex",
  available: true,
  description: "Coding agent",
  runtime: {
    kind: "codex",
    supportedByHerdr: true,
    hasDetectionManifest: true,
    hasIntegration: true,
    launchable: true,
    runningInstances: 0,
    sources: [],
  },
};

function createServer(): A2AGateway {
  const options: GatewayOptions = {
    catalog: {
      list: async () => [descriptor],
      get: async () => descriptor,
      refresh: async () => undefined,
    },
    delegation: {} as GatewayOptions["delegation"],
    taskService: {} as GatewayOptions["taskService"],
    tasks: {} as GatewayOptions["tasks"],
    config: {
      gateway: { host: "127.0.0.1", port: 0 },
      layout: { minColumns: 50, minRows: 12, overflow: "new_tab" },
      relay: { stableWindowMs: 1, turnStartTimeoutMs: 1, settleTimeoutMs: 1, messageTtlMs: 1, maxQueueDepth: 1, maxDeliveryAttempts: 1 },
      recovery: { maxLaunchAttempts: 1, maxDeliveryAttempts: 1 },
      defaults: { visibility: "visible", focusNewAgent: false },
      agents: {},
      dbPath: ":memory:",
      herdr: { binPath: "herdr", launchabilityTtlMs: 1 },
    },
    logger: { log: () => undefined, child: () => ({ log: () => undefined, child: () => ({}) as never }) },
  };
  return new A2AGateway(options);
}

function simulateBoundPort(gateway: A2AGateway, port: number): void {
  const fakeServer = {
    once(event: string, listener: () => void) {
      if (event === "listening") listener();
      return fakeServer;
    },
    address: () => ({ address: "127.0.0.1", family: "IPv4", port }),
    close: (listener: () => void) => listener(),
  };
  gateway.expressApp.listen = (() => fakeServer) as typeof gateway.expressApp.listen;
}

describe("A2AGateway ephemeral binding", () => {
  let gateway: A2AGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
  });

  it("derives its advertised URL from the real bound port rather than :0", async () => {
    gateway = createServer();
    simulateBoundPort(gateway, 4567);
    const listening = await gateway.listen();

    expect(listening.port).toBe(4567);
    expect(listening.baseUrl).toBe("http://127.0.0.1:4567");
    expect(gateway.advertisedBaseUrl).toBe(listening.baseUrl);
    expect(cardForDescriptor(descriptor, gateway.advertisedBaseUrl).supportedInterfaces.map((item) => item.url)).toEqual([
      "http://127.0.0.1:4567/a2a/agents/codex",
      "http://127.0.0.1:4567/a2a/agents/codex",
    ]);
  });
});
