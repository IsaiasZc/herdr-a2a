/**
 * Config loading: YAML file (optional) < defaults, then caller `overrides` on
 * top, then zod validation.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { ERROR_CODES, fail } from "../core/errors.js";
import type { AppConfig } from "../core/ports.js";
import { AppConfigSchema, buildDefaultConfig } from "./schema.js";

/** Recursive partial, for caller-supplied config overrides. Arrays are replaced whole, not merged element-wise. */
export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface LoadConfigOptions {
  /** Explicit config file path, bypassing `HERDR_A2A_CONFIG` / XDG lookup. */
  path?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: DeepPartial<AppConfig>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merges plain objects; arrays and scalars from `patch` replace `base` wholesale. */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) {
    return (patch === undefined ? base : (patch as T));
  }
  if (!isPlainObject(base)) {
    return patch as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = deepMerge(out[key], value);
  }
  return out as T;
}

function resolveConfigPath(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  if (explicit) return explicit;
  if (env.HERDR_A2A_CONFIG && env.HERDR_A2A_CONFIG.length > 0) return env.HERDR_A2A_CONFIG;
  const configHome =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(configHome, "herdr-a2a", "config.yaml");
}

/** Reads and parses the YAML config file. A missing file is not an error — returns `undefined`. */
function readConfigFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  const parsed: unknown = parseYaml(raw);
  // An empty YAML file parses to `null`/`undefined`; treat that as "no config".
  if (parsed === null || parsed === undefined) return undefined;
  return parsed;
}

/**
 * Validates an already-merged raw config object (defaults + overlays) and
 * reports failures through the shared error taxonomy rather than a bare zod
 * error, so callers (gateway startup, `doctor`) get a structured
 * `DelegationFailure`.
 */
function parseOrFail(raw: unknown): AppConfig {
  const result = AppConfigSchema.safeParse(raw);
  if (!result.success) {
    throw fail(ERROR_CODES.INVALID_EXECUTION_OPTION, "invalid herdr-a2a configuration", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      })),
    });
  }
  return result.data;
}

/**
 * Loads `AppConfig` from (in increasing precedence): built-in defaults, the
 * YAML config file (optional — a missing file is not an error), and caller
 * `overrides`.
 */
export function loadConfig(opts: LoadConfigOptions = {}): AppConfig {
  const env = opts.env ?? process.env;
  const defaults = buildDefaultConfig(env);
  const filePath = resolveConfigPath(opts.path, env);
  const fileRaw = readConfigFile(filePath);
  const overridesRaw = opts.overrides;

  const merged = deepMerge(deepMerge(defaults as unknown as Record<string, unknown>, fileRaw), overridesRaw);

  return parseOrFail(merged);
}

/**
 * Validates a raw (possibly partial) config object for the `doctor` command,
 * layering it over the same defaults `loadConfig` would use so a config
 * fragment (e.g. just an `agents:` block) validates the same way it would in
 * a real file.
 */
export function validateConfig(raw: unknown): AppConfig {
  const defaults = buildDefaultConfig(process.env);
  const merged = deepMerge(defaults as unknown as Record<string, unknown>, raw);
  return parseOrFail(merged);
}
