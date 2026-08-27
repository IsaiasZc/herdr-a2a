import { execFile as execFileCallback } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { localSocketEndpointFor } from "../../src/herdr/socket-client.js";

const execFile = promisify(execFileCallback);

const BIN = process.env["HERDR_BIN_PATH"] ?? "herdr";

/**
 * Integration tests run against a REAL Herdr — but never the operator's live
 * session. Herdr's own guidance is explicit: use a named test session for
 * experiments that need an isolated server, and never stop the main one. So the
 * harness starts a private headless server, works only inside it, and tears it
 * down afterwards.
 */
export interface TestSession {
  name: string;
  socketPath: string;
  dbPath: string;
  /** Root pane of the session's single starting tab. */
  rootPaneId: string;
  workspaceId: string;
  tabId: string;
  stop(): Promise<void>;
}

interface SessionRow {
  name: string;
  running: boolean;
  socket_path: string;
  session_dir: string;
}

async function sessions(): Promise<SessionRow[]> {
  const { stdout } = await execFile(BIN, ["session", "list", "--json"], { encoding: "utf8" });
  return (JSON.parse(stdout) as { sessions: SessionRow[] }).sessions;
}

export function herdrAvailable(): boolean {
  return process.env["HERDR_ENV"] === "1" || Boolean(process.env["HERDR_SOCKET_PATH"]);
}

/**
 * `herdr --session <name> server` starts a detached headless server whose API
 * socket lives under `~/.config/herdr/sessions/<name>/`. The server command is
 * normally launched by Herdr's client, which supplies `HERDR_STARTUP_CWD` to
 * seed the first workspace/tab/pane; the harness must provide it itself.
 */
export async function startTestSession(label: string): Promise<TestSession> {
  const name = `a2a-it-${label}-${process.pid}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 31);

  const child = spawn(BIN, ["--session", name, "server"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, HERDR_STARTUP_CWD: process.cwd() },
  });
  child.unref();

  const socketPath = await waitFor(async () => {
    const row = (await sessions()).find((s) => s.name === name && s.running);
    return row?.socket_path;
  }, 15_000, `session ${name} did not start`);

  const snapshot = await request(socketPath, "session.snapshot", {});
  const snap = snapshot["snapshot"] as {
    workspaces: { workspace_id: string }[];
    tabs: { tab_id: string }[];
    panes: { pane_id: string }[];
  };

  const rootPaneId = snap.panes[0]?.pane_id;
  const workspaceId = snap.workspaces[0]?.workspace_id;
  const tabId = snap.tabs[0]?.tab_id;
  if (!rootPaneId || !workspaceId || !tabId) {
    throw new Error(`fresh session ${name} has no starting pane`);
  }

  const dbDir = await mkdtemp(path.join(tmpdir(), "herdr-a2a-it-"));

  return {
    name,
    socketPath,
    dbPath: path.join(dbDir, "state.sqlite"),
    rootPaneId,
    workspaceId,
    tabId,
    async stop() {
      // Stop before delete: a running session refuses deletion, and leaving one
      // behind would pollute the operator's `herdr session list`.
      await execFile(BIN, ["session", "stop", name]).catch(() => {});
      await execFile(BIN, ["session", "delete", name]).catch(() => {});
      await rm(dbDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Minimal NDJSON request, used by the harness itself before the client exists. */
export function request(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<Record<string, unknown> & { type: string }> {
  return import("node:net").then(
    (net) =>
      new Promise((resolve, reject) => {
        const socket = net.createConnection(localSocketEndpointFor(socketPath));
        let buffer = "";
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        socket.on("connect", () =>
          socket.write(`${JSON.stringify({ id: "harness", method, params })}\n`),
        );
        socket.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const idx = buffer.indexOf("\n");
          if (idx < 0) return;
          clearTimeout(timer);
          socket.end();
          const frame = JSON.parse(buffer.slice(0, idx)) as Record<string, unknown>;
          const error = frame["error"] as { code: string; message: string } | undefined;
          if (error) reject(new Error(`${method}: ${error.code} ${error.message}`));
          else resolve(frame["result"] as Record<string, unknown> & { type: string });
        });
      }),
  );
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  message: string,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Picks a runtime to test with FROM THE CATALOG, never from a hardcoded name.
 * Spec §51 is explicit that E2E tests must not assume `codex` or `claude` is
 * installed; a machine with no launchable runtime skips instead of failing.
 */
export function pickTestableRuntime<T extends { available: boolean; descriptorKind: string; name: string }>(
  descriptors: T[],
): T | undefined {
  return descriptors.find((d) => d.descriptorKind === "runtime" && d.available);
}
