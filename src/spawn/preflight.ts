/**
 * Preflight (spec §16): everything checkable *before* mutating layout. A
 * failed check must never leave behind an empty pane discovered to be
 * useless later — that is the whole point of running this first.
 *
 * `Preflight.run` never throws for the checks it can normalize into a report
 * row (Herdr reachability/protocol, descriptor availability, cwd). The one
 * exception is the model/options check: `RuntimeAdapter.validateOptions`
 * already produces a fully-formed `DelegationFailure` (typically
 * `MODEL_UNSUPPORTED`), so that error propagates as-is instead of being
 * lossily downgraded to a string and reconstructed by the caller.
 *
 * `SpawnManager` is the one that turns a non-ok report into a thrown
 * `DelegationFailure` — `PreflightReport` has no error-code field, so the
 * mapping from failing check name to `ErrorCode` lives there (spec: "Return
 * the report; the SpawnManager decides to throw").
 */

import { promises as fs } from "node:fs";

import type { EventSink, HerdrClient, Logger, Preflight, PreflightReport, RuntimeAdapterRegistry } from "../core/ports.js";
import type { SpawnRequest } from "../core/model.js";
import { REQUIRED_PROTOCOL } from "../herdr/types.js";
import { EVENTS } from "../observability/events.js";

export interface PreflightDeps {
  herdr: HerdrClient;
  adapters: RuntimeAdapterRegistry;
  events: EventSink;
  logger: Logger;
  /** Injectable for tests; defaults to `fs.promises.stat`. */
  statDir?: (path: string) => Promise<{ isDirectory(): boolean }>;
}

type CheckRow = PreflightReport["checks"][number];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class DefaultPreflight implements Preflight {
  private readonly statDir: (path: string) => Promise<{ isDirectory(): boolean }>;

  constructor(private readonly deps: PreflightDeps) {
    this.statDir = deps.statDir ?? ((path: string) => fs.stat(path));
  }

  async run(req: SpawnRequest): Promise<PreflightReport> {
    const { events } = this.deps;
    events.emit(EVENTS.spawnPreflightStarted, { agent: req.descriptor.name, cwd: req.cwd });

    const checks: CheckRow[] = [];
    checks.push(...(await this.checkHerdr()));
    checks.push(this.checkDescriptor(req));
    checks.push(await this.checkCwd(req.cwd));

    try {
      await this.checkModel(req);
      checks.push({ name: "model_supported", ok: true });
    } catch (err) {
      events.emit(EVENTS.spawnPreflightFailed, {
        agent: req.descriptor.name,
        failed: [...checks.filter((c) => !c.ok).map((c) => c.name), "model_supported"],
      });
      throw err;
    }

    const ok = checks.every((c) => c.ok);
    if (!ok) {
      events.emit(EVENTS.spawnPreflightFailed, {
        agent: req.descriptor.name,
        failed: checks.filter((c) => !c.ok).map((c) => c.name),
      });
    }
    return { ok, checks };
  }

  private async checkHerdr(): Promise<CheckRow[]> {
    try {
      const pong = await this.deps.herdr.ping();
      const protocolOk = pong.protocol === REQUIRED_PROTOCOL;
      return [
        { name: "herdr_reachable", ok: true },
        {
          name: "herdr_protocol_compatible",
          ok: protocolOk,
          ...(protocolOk ? {} : { detail: `herdr protocol ${pong.protocol} != required ${REQUIRED_PROTOCOL}` }),
        },
      ];
    } catch (err) {
      const detail = message(err);
      return [
        { name: "herdr_reachable", ok: false, detail },
        { name: "herdr_protocol_compatible", ok: false, detail: "herdr unreachable" },
      ];
    }
  }

  private checkDescriptor(req: SpawnRequest): CheckRow {
    if (req.descriptor.available) return { name: "descriptor_available", ok: true };
    return {
      name: "descriptor_available",
      ok: false,
      detail: req.descriptor.unavailableReason ?? "agent descriptor is unavailable",
    };
  }

  private async checkCwd(cwd: string): Promise<CheckRow> {
    try {
      const stat = await this.statDir(cwd);
      if (!stat.isDirectory()) return { name: "cwd_exists", ok: false, detail: `${cwd} is not a directory` };
      return { name: "cwd_exists", ok: true };
    } catch (err) {
      return { name: "cwd_exists", ok: false, detail: message(err) };
    }
  }

  private async checkModel(req: SpawnRequest): Promise<void> {
    const adapter = this.deps.adapters.for(req.descriptor.runtimeKind);
    if (!adapter.validateOptions) return;
    await adapter.validateOptions({
      runtimeKind: req.descriptor.runtimeKind,
      cwd: req.cwd,
      ...(req.model === undefined ? {} : { model: req.model }),
      ...(req.args === undefined ? {} : { profileArgs: req.args }),
    });
  }
}
