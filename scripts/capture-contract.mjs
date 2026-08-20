#!/usr/bin/env node
/**
 * Refreshes the Herdr contract fixtures from the INSTALLED Herdr.
 *
 * Run this after a Herdr upgrade. If a fixture changes shape, the unit tests
 * that read it will tell you which assumption in docs/herdr-contract.md no
 * longer holds — which is the point: the contract is captured, never assumed.
 */

import net from "node:net";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const OUT = path.join(process.cwd(), "tests", "fixtures", "herdr");
const BIN = process.env.HERDR_BIN_PATH ?? "herdr";
const SOCKET = process.env.HERDR_SOCKET_PATH;

function request(method, params = {}) {
  if (!SOCKET) throw new Error("HERDR_SOCKET_PATH is not set — run this inside a Herdr pane");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${method} timed out`));
    }, 10_000);

    socket.on("connect", () => socket.write(`${JSON.stringify({ id: "capture", method, params })}\n`));
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf("\n");
      if (idx < 0) return;
      clearTimeout(timer);
      socket.end();
      const frame = JSON.parse(buffer.slice(0, idx));
      if (frame.error) reject(new Error(`${method}: ${frame.error.code} ${frame.error.message}`));
      else resolve(frame.result);
    });
  });
}

function methodsFrom(schema) {
  const found = [];
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.properties?.method?.const) found.push(node.properties.method.const);
    for (const key of Object.keys(node)) walk(node[key]);
  })(schema.schemas.request);
  return [...new Set(found)].sort();
}

async function write(name, value) {
  await writeFile(path.join(OUT, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`  wrote ${name}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const { stdout: schemaRaw } = await run(BIN, ["api", "schema", "--json"], { maxBuffer: 32 * 1024 * 1024 });
  const schema = JSON.parse(schemaRaw);
  await write("schema.json", schema);
  await write("schema-methods.json", {
    protocol: schema.protocol,
    schema_version: schema.schema_version,
    methods: methodsFrom(schema),
  });

  await write("session-snapshot.json", { result: await request("session.snapshot") });
  await write("agent-manifests.json", { result: await request("server.agent_manifests") });

  // The kind list lives only in the binary's usage text — see
  // docs/herdr-contract.md §6 for why there is no socket method for it.
  for (const [group, file] of [
    ["agent", "cli-agent-usage.txt"],
    ["integration", "cli-integration-usage.txt"],
  ]) {
    // A command group invoked with no subcommand prints its usage to stderr and
    // exits 2. Capture both streams; the exit code is not a failure signal here.
    const captured = await run(BIN, [group]).catch((err) => ({
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    }));
    await writeFile(path.join(OUT, file), `${captured.stdout}${captured.stderr}`);
    console.log(`  wrote ${file}`);
  }

  const pong = await request("ping");
  console.log(`\nHerdr ${pong.version}, protocol ${pong.protocol}. Fixtures refreshed in ${OUT}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
