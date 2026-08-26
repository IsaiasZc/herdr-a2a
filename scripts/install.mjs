#!/usr/bin/env node
/**
 * Installer for herdr-a2a.
 *
 * Four things get wired, and each is a symlink or a Herdr-managed link rather
 * than a copy, so editing this repo updates the installation in place:
 *
 *   1. the Herdr plugin  — Herdr starts the gateway whenever Herdr starts
 *   2. the `herdr-a2a` CLI on PATH
 *   3. the caller skill, into every agent skills directory found
 *   4. the gateway for the *currently running* session, since Herdr's startup
 *      hook only fires at server boot
 *
 * Usage:
 *   node scripts/install.mjs            install (idempotent — safe to re-run)
 *   node scripts/install.mjs status     show what is wired and what is not
 *   node scripts/install.mjs uninstall  remove every link this script created
 *
 * Nothing here writes into a system directory or needs root.
 */

import { execFile, spawn } from "node:child_process";
import { access, constants, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();
const HERDR = process.env["HERDR_BIN_PATH"] ?? "herdr";

const PLUGIN_ID = "herdr-a2a";
const SKILL_NAME = "herdr-a2a";
const SKILL_SOURCE = path.join(REPO, "src", "bridge", "skill");
/**
 * The committed launcher, not the compiled file. `tsc` rewrites dist/ on every
 * build without an executable bit, so a symlink straight at dist/ breaks after
 * each rebuild.
 */
const CLI_TARGET = path.join(REPO, "bin", "herdr-a2a");
const CLI_ENTRY = path.join(REPO, "dist", "bridge", "cli.js");

/**
 * Agent skill directories, in the convention each agent already uses:
 * `<dir>/<name>/SKILL.md`. Only directories that already exist are touched —
 * creating a skills directory for an agent that is not installed would be
 * litter.
 */
const SKILL_DIRS = [
  { agent: "Claude Code", dir: path.join(HOME, ".claude", "skills") },
  { agent: "Codex", dir: path.join(HOME, ".codex", "skills") },
  { agent: "OpenCode", dir: path.join(HOME, ".config", "opencode", "skills") },
];

/** Preferred bin directories, first one that exists and is on PATH wins. */
const BIN_CANDIDATES = [path.join(HOME, ".local", "bin"), path.join(HOME, "bin")];

// ---------------------------------------------------------------------------

const ok = (m) => console.log(`  ✓ ${m}`);
const skip = (m) => console.log(`  · ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const step = (m) => console.log(`\n${m}`);

async function isSymlinkTo(link, target) {
  try {
    const stat = await lstat(link);
    if (!stat.isSymbolicLink()) return false;
    return path.resolve(path.dirname(link), await readlink(link)) === path.resolve(target);
  } catch {
    return false;
  }
}

async function linkOnce(link, target, label) {
  if (await isSymlinkTo(link, target)) {
    skip(`${label} already linked`);
    return true;
  }
  try {
    const stat = await lstat(link);
    if (stat.isSymbolicLink()) {
      warn(`${label}: ${link} is already a symlink owned by something else — left untouched`);
    } else {
      warn(`${label}: ${link} exists and is not a symlink — left untouched`);
    }
    return false;
  } catch {
    /* absent, which is the happy path */
  }
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(target, link);
  ok(`${label} → ${link}`);
  return true;
}

async function unlinkOnce(link, target, label) {
  if (!(await isSymlinkTo(link, target))) {
    skip(`${label} not linked by us`);
    return;
  }
  await rm(link);
  ok(`${label} removed`);
}

async function pathDirs() {
  return (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean).map((d) => path.resolve(d));
}

async function chooseBinDir() {
  const onPath = new Set(await pathDirs());
  for (const dir of BIN_CANDIDATES) {
    if (existsSync(dir) && onPath.has(path.resolve(dir))) return { dir, onPath: true };
  }
  for (const dir of BIN_CANDIDATES) {
    if (existsSync(dir)) return { dir, onPath: false };
  }
  return { dir: BIN_CANDIDATES[0], onPath: onPath.has(path.resolve(BIN_CANDIDATES[0])) };
}

async function herdrJson(args) {
  const { stdout } = await run(HERDR, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function pluginLinked() {
  try {
    const res = await herdrJson(["plugin", "list", "--json"]);
    return (res.result?.plugins ?? []).find((p) => p.plugin_id === PLUGIN_ID);
  } catch {
    return undefined;
  }
}

function pluginIsOurs(plugin) {
  if (!plugin?.plugin_root) return false;
  return path.resolve(plugin.plugin_root) === REPO;
}

async function gatewayHealthy() {
  // Ask the CLI, which already knows how to find this session's gateway.
  try {
    const { stdout } = await run(process.execPath, [CLI_ENTRY, "discover", "--json"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    return { up: true, agents: parsed.agents?.length ?? 0, baseUrl: parsed.baseUrl };
  } catch {
    return { up: false };
  }
}

// ---------------------------------------------------------------------------

async function build() {
  step("Building");
  if (!existsSync(path.join(REPO, "node_modules"))) {
    await run("npm", ["ci", "--silent"], { cwd: REPO, maxBuffer: 32 * 1024 * 1024 });
    ok("dependencies installed from package-lock.json");
  } else {
    skip("dependencies already installed");
  }
  await run("npm", ["run", "build"], { cwd: REPO, maxBuffer: 32 * 1024 * 1024 });
  ok("compiled to dist/");
}

async function installPlugin() {
  step("Herdr plugin (so Herdr owns the gateway)");
  const existing = await pluginLinked();
  if (existing && !pluginIsOurs(existing)) {
    throw new Error(
      `plugin '${PLUGIN_ID}' is already registered from '${existing.plugin_root}'; unlink it explicitly if you want to replace it`,
    );
  }
  if (existing) {
    // Re-link only our own checkout so a moved manifest edit is picked up.
    await run(HERDR, ["plugin", "unlink", PLUGIN_ID]);
  }
  await run(HERDR, ["plugin", "link", REPO]);
  ok(`linked ${PLUGIN_ID} from ${REPO}`);
}

async function installCli() {
  step("CLI");
  const { dir, onPath } = await chooseBinDir();
  await mkdir(dir, { recursive: true });
  await linkOnce(path.join(dir, "herdr-a2a"), CLI_TARGET, "herdr-a2a");
  if (!onPath) {
    warn(`${dir} is not on your PATH — add it, or call ${CLI_TARGET} directly`);
  }
  // The launcher runs via its shebang and execs the compiled entry point, so
  // both have to be present before we claim the CLI is installed.
  await access(CLI_TARGET, constants.X_OK);
  await access(CLI_ENTRY, constants.R_OK);
}

async function installSkill() {
  step("Caller skill (symlinked, so editing the repo updates every agent)");
  let installed = 0;
  for (const { agent, dir } of SKILL_DIRS) {
    if (!existsSync(dir)) {
      skip(`${agent}: ${dir} does not exist — skipped`);
      continue;
    }
    if (await linkOnce(path.join(dir, SKILL_NAME), SKILL_SOURCE, `${agent} skill`)) installed += 1;
  }
  if (installed === 0) warn("no agent skill could be linked; the CLI still works on its own");
}

/**
 * Herdr's plugin startup hook fires at server boot, so an already-running Herdr
 * will not have started the gateway yet. Start it now, detached, and let the
 * next Herdr start take ownership — `serve` is idempotent, so whichever comes
 * first wins and the other exits.
 */
async function startGatewayNow() {
  step("Gateway for the current session");
  const before = await gatewayHealthy();
  if (before.up) {
    skip(`already serving at ${before.baseUrl} (${before.agents} agents)`);
    return;
  }
  if (!process.env["HERDR_SOCKET_PATH"]) {
    warn("not running inside a Herdr session — start the gateway from a Herdr pane");
    return;
  }

  const child = spawn(process.execPath, [path.join(REPO, "dist", "main.js"), "serve"], {
    cwd: REPO,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await gatewayHealthy();
    if (now.up) {
      ok(`serving at ${now.baseUrl} (${now.agents} delegatable agents)`);
      return;
    }
  }
  warn("the gateway did not come up in 15s — run `node dist/main.js doctor` to see why");
}

async function install() {
  console.log(`Installing herdr-a2a from ${REPO}`);
  await build();
  await installPlugin();
  await installCli();
  await installSkill();
  await startGatewayNow();

  console.log(`
Done. From any Herdr pane, any agent can now:

    herdr-a2a discover
    herdr-a2a delegate <agent> "<task>"
    herdr-a2a get <task-id>
    herdr-a2a continue <task-id> "<answer>"
    herdr-a2a cancel <task-id>

Herdr starts the gateway from now on, one per session. Re-run this script after
pulling changes; \`node scripts/install.mjs status\` shows what is wired.`);
}

async function status() {
  console.log(`herdr-a2a at ${REPO}\n`);

  const plugin = await pluginLinked();
  const pluginState = !plugin
    ? "NOT linked"
    : pluginIsOurs(plugin)
      ? `linked (enabled: ${plugin.enabled})`
      : `CONFLICT (registered from ${plugin.plugin_root})`;
  console.log(`plugin:   ${pluginState}`);

  const { dir } = await chooseBinDir();
  const cliLink = path.join(dir, "herdr-a2a");
  console.log(`cli:      ${(await isSymlinkTo(cliLink, CLI_TARGET)) ? cliLink : "NOT linked"}`);

  for (const { agent, dir: skillDir } of SKILL_DIRS) {
    const link = path.join(skillDir, SKILL_NAME);
    const state = !existsSync(skillDir)
      ? "agent not installed"
      : (await isSymlinkTo(link, SKILL_SOURCE))
        ? "linked"
        : "NOT linked";
    console.log(`skill:    ${agent.padEnd(12)} ${state}`);
  }

  const gw = await gatewayHealthy();
  console.log(`gateway:  ${gw.up ? `${gw.baseUrl} (${gw.agents} agents)` : "not reachable"}`);
  console.log(`built:    ${existsSync(CLI_ENTRY) ? "yes" : "no — run npm run build"}`);
}

async function uninstall() {
  console.log("Removing herdr-a2a links (the repo itself is left alone)");

  step("Herdr plugin");
  const plugin = await pluginLinked();
  if (!plugin) {
    skip("not linked");
  } else if (pluginIsOurs(plugin)) {
    await run(HERDR, ["plugin", "unlink", PLUGIN_ID]).catch((err) => warn(`could not unlink the plugin: ${short(err)}`));
    ok("unlinked");
  } else {
    skip("plugin with this ID belongs to another checkout — left untouched");
  }

  step("CLI");
  for (const dir of BIN_CANDIDATES) {
    await unlinkOnce(path.join(dir, "herdr-a2a"), CLI_TARGET, `herdr-a2a in ${dir}`);
  }

  step("Skill");
  for (const { agent, dir } of SKILL_DIRS) {
    await unlinkOnce(path.join(dir, SKILL_NAME), SKILL_SOURCE, `${agent} skill`);
  }

  console.log(`
A gateway started earlier is still running; it exits with its Herdr session.
Stop it now with:  pkill -f 'dist/main.js serve'`);
}

function short(err) {
  const text = err?.stderr || err?.message || String(err);
  return String(text).trim().split("\n")[0];
}

const verb = process.argv[2] ?? "install";
const verbs = { install, status, uninstall };
const action = verbs[verb];
if (!action) {
  console.error(`usage: node scripts/install.mjs [install|status|uninstall]`);
  process.exit(2);
}
action().catch((err) => {
  console.error(`\nfailed: ${short(err)}`);
  process.exit(1);
});
