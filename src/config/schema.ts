/**
 * Zod schema for `AppConfig` (src/core/ports.ts). This file does not redefine
 * `AppConfig` — it produces a zod schema whose parsed output is structurally
 * assignable to it. See tests/unit/config/schema.test.ts for the
 * `satisfies`-style assignability check.
 *
 * ACCEPTANCE CRITERION §55.1 / spec §5, §6: there is no default/base agent
 * list anywhere in this file. `agents` defaults to `{}` — custom profiles
 * only. Base runtimes are discovered live from Herdr (docs/herdr-contract.md
 * §6), never hardcoded here or anywhere else in this package.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { AppConfig } from "../core/ports.js";
import type { Visibility } from "../core/model.js";

// ---------------------------------------------------------------------------
// Custom agent profiles (spec §6)
// ---------------------------------------------------------------------------

/**
 * Profile names become an A2A endpoint path segment AND are fed to Herdr as
 * the `agent.start` `name` (which itself must match `[a-z][a-z0-9_-]{0,31}`,
 * docs/herdr-contract.md §7). Enforcing the stricter of the two here means a
 * config that validates can never fail later for a name reason.
 */
export const CUSTOM_AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

const visibilitySchema: z.ZodType<Visibility> = z.enum(["visible", "headless"]);

/** The YAML shape for one entry under `agents:` — no `name` field; the map key is the name. */
const customAgentProfileInputSchema = z
  .object({
    runtime: z.string().min(1, "custom agent profile requires a non-empty `runtime`"),
    model: z.string().min(1).optional(),
    visibility: visibilitySchema.optional(),
    instructions: z.string().optional(),
    args: z.array(z.string()).optional(),
  })
  .strict();

/**
 * `runtime` is deliberately a bare, unvalidated string here: whether that
 * runtime kind actually exists in the live Herdr catalog is the catalog's
 * job (docs/herdr-contract.md §6), not config's. Config only owns shape.
 */
const agentsSchema = z
  .record(z.string(), customAgentProfileInputSchema)
  .superRefine((agents, ctx) => {
    for (const name of Object.keys(agents)) {
      if (!CUSTOM_AGENT_NAME_PATTERN.test(name)) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message:
            `custom agent profile name "${name}" is invalid: must match ` +
            `${CUSTOM_AGENT_NAME_PATTERN.source} (lowercase, starts with a ` +
            "letter, at most 32 chars) because it becomes both a URL path " +
            "segment and a Herdr agent name",
        });
      }
    }
  })
  .transform((agents) => {
    // Left loosely typed on purpose — the whole `AppConfigSchema` is cast to
    // `AppConfig` in one place below, see the comment there.
    const out: Record<string, { name: string } & z.infer<typeof customAgentProfileInputSchema>> = {};
    for (const [name, profile] of Object.entries(agents)) {
      out[name] = { ...profile, name };
    }
    return out;
  });

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const gatewaySchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    baseUrl: z.string().min(1),
  })
  .strict();

const layoutSchema = z
  .object({
    minColumns: z.number().int().positive(),
    minRows: z.number().int().positive(),
    overflow: z.literal("new_tab"),
  })
  .strict();

const relaySchema = z
  .object({
    // spec §12.1: 250-500ms is a suggested starting default, NOT protocol
    // truth. Keep it configurable and never treat this number as a Herdr
    // guarantee.
    stableWindowMs: z.number().int().positive(),
    turnStartTimeoutMs: z.number().int().positive(),
    settleTimeoutMs: z.number().int().positive(),
    messageTtlMs: z.number().int().positive(),
    maxQueueDepth: z.number().int().positive(),
    maxDeliveryAttempts: z.number().int().positive(),
  })
  .strict();

const recoverySchema = z
  .object({
    maxLaunchAttempts: z.number().int().positive(),
    maxDeliveryAttempts: z.number().int().positive(),
  })
  .strict();

const defaultsSchema = z
  .object({
    visibility: visibilitySchema,
    focusNewAgent: z.boolean(),
  })
  .strict();

const herdrSchema = z
  .object({
    socketPath: z.string().min(1).optional(),
    binPath: z.string().min(1),
    launchabilityTtlMs: z.number().int().positive(),
  })
  .strict();

const rawAppConfigSchema = z
  .object({
    gateway: gatewaySchema,
    layout: layoutSchema,
    relay: relaySchema,
    recovery: recoverySchema,
    defaults: defaultsSchema,
    agents: agentsSchema,
    dbPath: z.string().min(1),
    herdr: herdrSchema,
  })
  .strict();

/**
 * zod v4 types every `.optional()` field as `T | undefined` even though the
 * property itself is marked `?:` on the object type — under this project's
 * `exactOptionalPropertyTypes: true`, that is a *different*, stricter type
 * than `AppConfig`'s own `field?: T` (which forbids an explicit `undefined`
 * value at that key). Plain assignment or `satisfies` against `AppConfig`
 * therefore fails to typecheck even though every value zod actually produces
 * already conforms: zod never sets an absent optional key to the literal
 * value `undefined`, it omits the key. The single cast below is the one
 * place that friction is absorbed, so every other file in this package can
 * treat `AppConfigSchema`'s output as a plain `AppConfig`. See the
 * assignability test in tests/unit/config/schema.test.ts.
 */
export const AppConfigSchema = rawAppConfigSchema.transform((config) => config as AppConfig);

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_GATEWAY_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_PORT = 4319;

/**
 * Every default in one place, computed against a caller-supplied `env` so
 * tests never touch the real process environment. `dbPath` and the `herdr`
 * block are the only env-dependent defaults (XDG_STATE_HOME, HERDR_SOCKET_PATH,
 * HERDR_BIN_PATH); everything else is a static spec default.
 *
 * `agents` is always `{}` here — see the module comment. There is no base
 * agent list to seed it with.
 */
export function buildDefaultConfig(env: NodeJS.ProcessEnv): AppConfig {
  const host = DEFAULT_GATEWAY_HOST;
  const port = DEFAULT_GATEWAY_PORT;
  const stateHome = env.XDG_STATE_HOME && env.XDG_STATE_HOME.length > 0
    ? env.XDG_STATE_HOME
    : join(homedir(), ".local", "state");

  const socketPath = env.HERDR_SOCKET_PATH && env.HERDR_SOCKET_PATH.length > 0
    ? env.HERDR_SOCKET_PATH
    : undefined;
  const binPath = env.HERDR_BIN_PATH && env.HERDR_BIN_PATH.length > 0 ? env.HERDR_BIN_PATH : "herdr";

  return {
    gateway: {
      host,
      port,
      baseUrl: `http://${host}:${port}`,
    },
    layout: {
      minColumns: 50,
      minRows: 12,
      overflow: "new_tab",
    },
    relay: {
      stableWindowMs: 350,
      turnStartTimeoutMs: 8000,
      settleTimeoutMs: 600000,
      messageTtlMs: 900000,
      maxQueueDepth: 32,
      maxDeliveryAttempts: 2,
    },
    recovery: {
      maxLaunchAttempts: 2,
      maxDeliveryAttempts: 2,
    },
    defaults: {
      visibility: "visible",
      focusNewAgent: false,
    },
    // §55.1: no default/base agent list. Custom profiles only, and only if
    // the user configures them.
    agents: {},
    dbPath: join(stateHome, "herdr-a2a", "state.sqlite"),
    herdr: {
      ...(socketPath === undefined ? {} : { socketPath }),
      binPath,
      launchabilityTtlMs: 300000,
    },
  };
}
