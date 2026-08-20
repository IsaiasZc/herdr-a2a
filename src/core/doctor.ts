import { ERROR_CODES, toDelegationError } from "./errors.js";
import type { AgentCatalog, AppConfig, HerdrClient, Logger } from "./ports.js";
import type { SchemaInfo } from "../herdr/schema-loader.js";

/** Methods the delegation layer cannot work without. */
export const REQUIRED_METHODS = [
  "ping",
  "session.snapshot",
  "server.agent_manifests",
  "agent.list",
  "agent.get",
  "agent.start",
  "agent.prompt",
  "agent.wait",
  "agent.read",
  "agent.send_keys",
  "pane.split",
  "pane.get",
  "pane.close",
  "pane.layout",
  "tab.create",
  "events.subscribe",
] as const;

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  herdrVersion?: string;
  protocol?: number;
  checks: DoctorCheck[];
  /** Whatever Herdr says exists — never an expectation of specific runtimes. */
  agents: { name: string; available: boolean; launchable: string; running: number }[];
}

export interface DoctorOptions {
  herdr: HerdrClient;
  catalog: AgentCatalog;
  config: AppConfig;
  logger: Logger;
  loadSchema: () => Promise<SchemaInfo>;
  /** Proves the database is writable rather than merely openable. */
  probeDatabase: () => Promise<void>;
}

/**
 * Operator- and test-facing readiness report (spec §49).
 *
 * It deliberately does NOT expect any particular runtime to exist. A machine
 * with zero coding agents installed is a healthy machine with an empty catalog,
 * not a failure — asserting otherwise would smuggle a hardcoded agent list in
 * through the back door.
 */
export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let herdrVersion: string | undefined;
  let protocol: number | undefined;

  const check = async (name: string, fn: () => Promise<string | undefined>): Promise<boolean> => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
      return true;
    } catch (err) {
      const e = toDelegationError(err, ERROR_CODES.HERDR_API_ERROR);
      checks.push({ name, ok: false, detail: `${e.code}: ${e.message}` });
      return false;
    }
  };

  const reachable = await check("herdr reachable", async () => {
    const pong = await opts.herdr.ping();
    herdrVersion = pong.version;
    protocol = pong.protocol;
    return `version ${pong.version}, protocol ${pong.protocol}`;
  });

  let schema: SchemaInfo | undefined;
  await check("schema readable", async () => {
    schema = await opts.loadSchema();
    return `protocol ${schema.protocol}, ${schema.methods.length} methods`;
  });

  await check("protocol compatible", async () => {
    if (!schema) throw new Error("schema was not readable");
    const missing = REQUIRED_METHODS.filter((m) => !schema!.has(m));
    if (missing.length > 0) {
      throw new Error(`missing methods: ${missing.join(", ")}`);
    }
    return "all required methods present";
  });

  await check("layout primitives present", async () => {
    if (!schema) throw new Error("schema was not readable");
    const layout = ["pane.split", "pane.layout", "tab.create"].filter((m) => !schema!.has(m));
    if (layout.length > 0) throw new Error(`missing: ${layout.join(", ")}`);
    return "pane.split, pane.layout, tab.create";
  });

  if (reachable) {
    await check("session snapshot readable", async () => {
      const snapshot = await opts.herdr.sessionSnapshot();
      return `${snapshot.workspaces.length} workspace(s), ${snapshot.panes.length} pane(s), ${snapshot.agents.length} live agent(s)`;
    });

    await check("event subscription works", async () => {
      const sub = await opts.herdr.subscribe([{ type: "layout.updated" }], () => {});
      sub.close();
      return "subscribed and closed cleanly";
    });
  }

  let agents: DoctorReport["agents"] = [];
  await check("catalog generation works", async () => {
    await opts.catalog.refresh();
    const list = await opts.catalog.list();
    agents = list.map((d) => ({
      name: d.name,
      available: d.available,
      launchable: d.runtime.launchable,
      running: d.runtime.runningInstances,
    }));
    const available = agents.filter((a) => a.available).length;
    return `${list.length} agent(s) in catalog, ${available} available`;
  });

  await check("custom config valid", async () => {
    const names = Object.keys(opts.config.agents);
    if (names.length === 0) return "no custom profiles defined";
    const list = await opts.catalog.list();
    const broken = list.filter((d) => d.descriptorKind === "custom" && !d.available);
    if (broken.length > 0) {
      throw new Error(
        broken.map((d) => `${d.name}: ${d.unavailableReason ?? "runtime unavailable"}`).join("; "),
      );
    }
    return `${names.length} profile(s) resolve`;
  });

  await check("sqlite writable", async () => {
    await opts.probeDatabase();
    return opts.config.dbPath;
  });

  return {
    ok: checks.every((c) => c.ok),
    ...(herdrVersion ? { herdrVersion } : {}),
    ...(protocol === undefined ? {} : { protocol }),
    checks,
    agents,
  };
}
