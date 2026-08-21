import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The pre-discovery fallback retained for installations that predate the plugin. */
export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:4319";

export interface GatewayDescriptor {
  baseUrl: string;
  port: number;
  pid: number;
  herdrSocketPath: string;
  startedAt: string;
  version: string;
}

/**
 * Runtime state is scoped by Herdr's socket, not by a shared configuration
 * directory. Resolving first makes equivalent relative spellings share a key.
 */
export function discoveryPathFor(socketPath: string): string {
  const key = createHash("sha256").update(resolve(socketPath)).digest("hex").slice(0, 12);
  const runtimeDir = process.env["XDG_RUNTIME_DIR"] || tmpdir();
  return join(runtimeDir, "herdr-a2a", `${key}.json`);
}

/** Writes through a sibling and rename so readers never observe partial JSON. */
export function writeDescriptor(socketPath: string, descriptor: GatewayDescriptor): void {
  const path = discoveryPathFor(socketPath);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  const tempPath = join(parent, `.${randomUUID()}.tmp`);
  const value: GatewayDescriptor = { ...descriptor, herdrSocketPath: resolve(socketPath) };
  try {
    writeFileSync(tempPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, path);
  } catch (err) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // The original write/rename error is the useful one for the caller.
    }
    throw err;
  }
}

/** Corrupt runtime state is indistinguishable from no runtime state to callers. */
export function readDescriptor(socketPath: string): GatewayDescriptor | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(discoveryPathFor(socketPath), "utf8"));
    if (!isDescriptor(parsed)) return undefined;
    if (resolve(parsed.herdrSocketPath) !== resolve(socketPath)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** A stale runtime file must never prevent the next session gateway from starting. */
export function removeDescriptor(socketPath: string): void {
  try {
    rmSync(discoveryPathFor(socketPath), { force: true });
  } catch {
    // Cleanup is intentionally best-effort; process shutdown still continues.
  }
}

/**
 * Removes descriptors whose process is gone.
 *
 * Herdr kills a plugin process on shutdown without giving it time to run its
 * own cleanup, so a session that ends leaves its descriptor behind. Staleness
 * is already handled correctly on read, so this is hygiene rather than
 * correctness — it keeps the runtime directory from accumulating one dead file
 * per Herdr session ever started.
 */
export function pruneStaleDescriptors(): number {
  const dir = dirname(discoveryPathFor("/placeholder"));
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = join(dir, entry);
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      // A file we cannot recognise is not ours to delete.
      if (!isDescriptor(parsed)) continue;
      if (isAlive(parsed)) continue;
      rmSync(file, { force: true });
      removed += 1;
    } catch {
      // Unreadable or already gone; leave it alone either way.
    }
  }
  return removed;
}

export function isAlive(descriptor: GatewayDescriptor): boolean {
  try {
    process.kill(descriptor.pid, 0);
    return true;
  } catch (err) {
    return isSystemError(err, "EPERM");
  }
}

export async function probeHealthy(
  descriptor: GatewayDescriptor,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1500,
): Promise<boolean> {
  try {
    const baseUrl = descriptor.baseUrl.replace(/\/+$/, "");
    const response = await fetchImpl(`${baseUrl}/healthz`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface ResolveGatewayUrlOptions {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  socketPath?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Resolves the gateway for this Herdr session without starting, retrying, or
 * otherwise orchestrating it. A dead, unhealthy, or wrong-session descriptor
 * deliberately falls through to the compatibility URL.
 */
export async function resolveGatewayUrl(options: ResolveGatewayUrlOptions = {}): Promise<string> {
  if (options.flag && options.flag.length > 0) return options.flag;
  const env = options.env ?? process.env;
  const fromEnv = env["HERDR_A2A_URL"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const socketPath = options.socketPath ?? env["HERDR_SOCKET_PATH"];
  if (socketPath && socketPath.length > 0) {
    const descriptor = readDescriptor(socketPath);
    if (descriptor && isAlive(descriptor) && (await probeHealthy(descriptor, options.fetchImpl))) {
      return descriptor.baseUrl;
    }
  }
  return DEFAULT_GATEWAY_URL;
}

function isDescriptor(value: unknown): value is GatewayDescriptor {
  if (!isRecord(value)) return false;
  return (
    typeof value.baseUrl === "string" &&
    value.baseUrl.length > 0 &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65535 &&
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.herdrSocketPath === "string" &&
    value.herdrSocketPath.length > 0 &&
    typeof value.startedAt === "string" &&
    value.startedAt.length > 0 &&
    typeof value.version === "string" &&
    value.version.length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSystemError(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value && (value as { code?: unknown }).code === code;
}
