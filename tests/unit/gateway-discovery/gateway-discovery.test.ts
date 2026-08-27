import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_GATEWAY_URL,
  discoveryPathFor,
  isAlive,
  probeHealthy,
  pruneStaleDescriptors,
  readDescriptor,
  resolveGatewayUrl,
  writeDescriptor,
  type GatewayDescriptor,
} from "../../../src/gateway-discovery.js";

let dir: string;
let previousRuntimeDir: string | undefined;

const socketA = "/tmp/herdr/session-a.sock";
const socketB = "/tmp/herdr/session-b.sock";

function descriptor(overrides: Partial<GatewayDescriptor> = {}): GatewayDescriptor {
  return {
    baseUrl: "http://127.0.0.1:4567",
    port: 4567,
    pid: process.pid,
    herdrSocketPath: socketA,
    startedAt: "2026-08-20T12:00:00.000Z",
    version: "0.0.1",
    ...overrides,
  };
}

function healthyFetch(url: string): typeof fetch {
  return (async (input: unknown) => {
    expect(String(input)).toBe(`${url}/healthz`);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-a2a-discovery-test-"));
  previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = dir;
});

afterEach(() => {
  if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("gateway discovery files", () => {
  it("uses a stable per-socket key under XDG_RUNTIME_DIR and different sockets get different paths", () => {
    const first = discoveryPathFor(socketA);
    expect(first).toBe(discoveryPathFor(socketA));
    expect(first).not.toBe(discoveryPathFor(socketB));
    expect(dirname(first)).toBe(join(dir, "herdr-a2a"));
    expect(basename(first)).toMatch(/^[0-9a-f]{12}\.json$/);
  });

  it("falls back to the operating-system temp directory without XDG_RUNTIME_DIR", () => {
    delete process.env.XDG_RUNTIME_DIR;
    const first = discoveryPathFor(socketA);
    expect(dirname(first)).toBe(join(tmpdir(), "herdr-a2a"));
    expect(basename(first)).toMatch(/^[0-9a-f]{12}\.json$/);
  });

  it("atomically round-trips a descriptor without leaving a temporary sibling", () => {
    const value = descriptor();
    writeDescriptor(socketA, value);

    expect(readDescriptor(socketA)).toEqual({ ...value, herdrSocketPath: resolve(socketA) });
    const parent = join(dir, "herdr-a2a");
    expect(readdirSync(parent).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("returns undefined for corrupt or truncated JSON", () => {
    const path = discoveryPathFor(socketA);
    writeDescriptor(socketA, descriptor());
    writeFileSync(path, "{\"baseUrl\":");

    expect(readDescriptor(socketA)).toBeUndefined();
  });

  it("rejects a descriptor for a different Herdr session even when it sits at this session's path", () => {
    const path = discoveryPathFor(socketA);
    writeDescriptor(socketA, descriptor());
    writeFileSync(path, JSON.stringify(descriptor({ herdrSocketPath: socketB })));

    expect(readDescriptor(socketA)).toBeUndefined();
  });

  it("treats a dead process as stale", () => {
    const dead = descriptor({ pid: 2_147_483_647 });
    expect(isAlive(dead)).toBe(false);
  });

  it("treats a failed health probe as stale", async () => {
    const failedFetch: typeof fetch = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    expect(await probeHealthy(descriptor(), failedFetch)).toBe(false);
  });
});

describe("resolveGatewayUrl", () => {
  it("honours flag, then environment, then a healthy same-session descriptor, then the legacy default", async () => {
    writeDescriptor(socketA, descriptor());
    const fetchImpl = healthyFetch("http://127.0.0.1:4567");

    await expect(
      resolveGatewayUrl({ flag: "http://flag.test", env: { HERDR_A2A_URL: "http://env.test", HERDR_SOCKET_PATH: socketA }, fetchImpl }),
    ).resolves.toBe("http://flag.test");
    await expect(
      resolveGatewayUrl({ env: { HERDR_A2A_URL: "http://env.test", HERDR_SOCKET_PATH: socketA }, fetchImpl }),
    ).resolves.toBe("http://env.test");
    await expect(resolveGatewayUrl({ env: { HERDR_SOCKET_PATH: socketA }, fetchImpl })).resolves.toBe("http://127.0.0.1:4567");

    expect(existsSync(discoveryPathFor(socketB))).toBe(false);
    await expect(resolveGatewayUrl({ env: { HERDR_SOCKET_PATH: socketB }, fetchImpl })).resolves.toBe(DEFAULT_GATEWAY_URL);
  });

  it("falls through when the descriptor is dead or unhealthy", async () => {
    writeDescriptor(socketA, descriptor({ pid: 2_147_483_647 }));
    await expect(resolveGatewayUrl({ env: { HERDR_SOCKET_PATH: socketA }, fetchImpl: healthyFetch("http://127.0.0.1:4567") })).resolves.toBe(
      DEFAULT_GATEWAY_URL,
    );

    writeDescriptor(socketA, descriptor());
    const unhealthyFetch: typeof fetch = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    await expect(resolveGatewayUrl({ env: { HERDR_SOCKET_PATH: socketA }, fetchImpl: unhealthyFetch })).resolves.toBe(DEFAULT_GATEWAY_URL);
  });
});

describe("pruneStaleDescriptors", () => {
  // pid 1 is init: present but not ours, so `process.kill(1, 0)` raises EPERM,
  // which counts as alive. A very high pid is reliably absent.
  const DEAD_PID = 0x7ffffff0;

  it("removes descriptors whose process is gone and keeps live ones", () => {
    writeDescriptor(socketA, descriptor({ herdrSocketPath: socketA, pid: DEAD_PID }));
    writeDescriptor(socketB, descriptor({ herdrSocketPath: socketB, pid: process.pid }));

    expect(pruneStaleDescriptors()).toBe(1);
    expect(readDescriptor(socketA)).toBeUndefined();
    expect(readDescriptor(socketB)).toBeDefined();
  });

  it("leaves files it does not recognise alone", () => {
    // Herdr's runtime directory is shared with whatever else lives there, so a
    // file we cannot parse as ours is not ours to delete.
    writeDescriptor(socketA, descriptor({ herdrSocketPath: socketA, pid: DEAD_PID }));
    const stranger = join(dirname(discoveryPathFor(socketA)), "not-ours.json");
    writeFileSync(stranger, '{"something":"else"}');

    expect(pruneStaleDescriptors()).toBe(1);
    expect(existsSync(stranger)).toBe(true);
  });

  it("reports zero when the runtime directory does not exist yet", () => {
    expect(pruneStaleDescriptors()).toBe(0);
  });
});
