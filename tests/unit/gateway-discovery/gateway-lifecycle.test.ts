import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startGatewayServe, type Gateway } from "../../../src/main.js";
import { readDescriptor, writeDescriptor, type GatewayDescriptor } from "../../../src/gateway-discovery.js";

let dir: string;
let previousRuntimeDir: string | undefined;

const socketPath = "/tmp/herdr/session-a.sock";

function descriptor(overrides: Partial<GatewayDescriptor> = {}): GatewayDescriptor {
  return {
    baseUrl: "http://127.0.0.1:4567",
    port: 4567,
    pid: process.pid,
    herdrSocketPath: socketPath,
    startedAt: "2026-08-20T12:00:00.000Z",
    version: "0.1.0",
    ...overrides,
  };
}

function gateway(): { value: Gateway; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  const start = vi.fn(async () => ({ host: "127.0.0.1", port: 4567, baseUrl: "http://127.0.0.1:4567" }));
  const stop = vi.fn(async () => undefined);
  return {
    value: { config: {} as Gateway["config"], start, stop, doctor: async () => ({ ok: true }) },
    start,
    stop,
  };
}

function healthyFetch(): typeof fetch {
  return (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-a2a-lifecycle-test-"));
  previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = dir;
});

afterEach(() => {
  if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("session-scoped gateway lifecycle", () => {
  it("exits idempotently without binding when a live healthy gateway already serves this session", async () => {
    writeDescriptor(socketPath, descriptor());
    const fake = gateway();
    const stdout = vi.fn();

    const served = await startGatewayServe({
      env: { HERDR_SOCKET_PATH: socketPath },
      fetchImpl: healthyFetch(),
      createGateway: async () => fake.value,
      stdout,
    });

    expect(served.alreadyRunning).toBe(true);
    expect(fake.start).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith("herdr-a2a gateway already serves this Herdr session at http://127.0.0.1:4567");
  });

  it("removes a stale descriptor, starts the gateway, and clears its descriptor on clean shutdown", async () => {
    writeDescriptor(socketPath, descriptor({ pid: 2_147_483_647 }));
    const fake = gateway();

    const served = await startGatewayServe({
      env: { HERDR_SOCKET_PATH: socketPath },
      fetchImpl: healthyFetch(),
      createGateway: async () => fake.value,
      stdout: () => undefined,
    });

    expect(served.alreadyRunning).toBe(false);
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(readDescriptor(socketPath)).toMatchObject({ baseUrl: "http://127.0.0.1:4567", pid: process.pid });

    await served.stop();
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(readDescriptor(socketPath)).toBeUndefined();
  });

  it("replaces an unhealthy descriptor rather than allowing it to shadow a new gateway", async () => {
    writeDescriptor(socketPath, descriptor());
    const fake = gateway();
    const unhealthyFetch: typeof fetch = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;

    const served = await startGatewayServe({
      env: { HERDR_SOCKET_PATH: socketPath },
      fetchImpl: unhealthyFetch,
      createGateway: async () => fake.value,
      stdout: () => undefined,
    });

    expect(served.alreadyRunning).toBe(false);
    expect(fake.start).toHaveBeenCalledTimes(1);
    await served.stop();
  });
});
