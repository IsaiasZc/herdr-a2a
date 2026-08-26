import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type { Clock, LaunchabilityResolver } from "../core/ports.js";
import type { Launchable } from "../core/model.js";
import type { LaunchabilityCache, LaunchabilityCacheRecord } from "./cache.js";

/**
 * Windows never resolves a bare command name — cmd.exe/PowerShell append each
 * `PATHEXT` extension in turn (falling back to a hardcoded default list when
 * the env var is unset, same as the shell does). Unix executables carry no
 * extension, so there this is just `[""]`. Reads `process.platform` (not a
 * destructured import) so tests can stub it per-case.
 */
function candidateSuffixes(env: NodeJS.ProcessEnv): readonly string[] {
  if (process.platform !== "win32") return [""];
  const pathExt = env["PATHEXT"] || ".COM;.EXE;.BAT;.CMD";
  return pathExt.split(";").filter(Boolean);
}

export interface LaunchabilityResolution {
  launchable: Launchable;
  reason: string;
  executablePath?: string;
}

export interface LaunchabilityResolverOptions {
  cache: LaunchabilityCache;
  ttlMs: number;
  clock: Pick<Clock, "now">;
  path?: string;
  /** A detection manifest may expose a CLI name that differs from the kind label. */
  commandHintForKind?: (kind: string) => string | null | undefined;
  existsExecutable?: (path: string) => Promise<boolean>;
}

async function defaultExistsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export class LaunchabilityResolverImpl implements LaunchabilityResolver {
  private readonly existsExecutable: (path: string) => Promise<boolean>;

  constructor(private readonly opts: LaunchabilityResolverOptions) {
    this.existsExecutable = opts.existsExecutable ?? defaultExistsExecutable;
  }

  async resolve(kind: string): Promise<LaunchabilityResolution> {
    const cached = await this.opts.cache.get(kind);
    if (cached && this.isFresh(cached)) return toResolution(cached);

    const hint = this.opts.commandHintForKind?.(kind);
    if (hint === null) {
      // A manifest can establish that the kind label is not a command while omitting its command name.
      return this.persist(kind, { launchable: "unknown", reason: "executable name cannot be inferred from this Herdr kind", checkedAt: this.opts.clock.now().toISOString() });
    }
    // A label is an executable candidate only when no authoritative manifest hint says otherwise.
    const executable = hint ?? kind;
    if (!executable) {
      return this.persist(kind, { launchable: "unknown", reason: "executable name cannot be inferred from this Herdr kind", checkedAt: this.opts.clock.now().toISOString() });
    }

    const pathEntries = (this.opts.path ?? process.env["PATH"] ?? "").split(delimiter).filter(Boolean);
    const suffixes = candidateSuffixes(process.env);
    for (const entry of pathEntries) {
      for (const suffix of suffixes) {
        const candidate = join(entry, executable + suffix);
        if (!await this.existsExecutable(candidate)) continue;
        return this.persist(kind, {
          launchable: "yes",
          reason: `resolved executable ${executable}${suffix} on PATH`,
          executablePath: candidate,
          checkedAt: this.opts.clock.now().toISOString(),
        });
      }
    }
    return this.persist(kind, {
      launchable: "no",
      reason: `executable ${executable} was not found on PATH`,
      checkedAt: this.opts.clock.now().toISOString(),
    });
  }

  async invalidate(kind?: string): Promise<void> {
    await this.opts.cache.invalidate(kind);
  }

  private isFresh(record: LaunchabilityCacheRecord): boolean {
    return this.opts.clock.now().getTime() - new Date(record.checkedAt).getTime() < this.opts.ttlMs;
  }

  private async persist(kind: string, record: LaunchabilityCacheRecord): Promise<LaunchabilityResolution> {
    await this.opts.cache.set(kind, record);
    return toResolution(record);
  }
}

function toResolution(record: LaunchabilityCacheRecord): LaunchabilityResolution {
  return {
    launchable: record.launchable,
    reason: record.reason,
    ...(record.executablePath === undefined ? {} : { executablePath: record.executablePath }),
  };
}
