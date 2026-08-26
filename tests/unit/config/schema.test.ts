import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AppConfig } from "../../../src/core/ports.js";
import { AppConfigSchema, buildDefaultConfig, CUSTOM_AGENT_NAME_PATTERN } from "../../../src/config/schema.js";

const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe("buildDefaultConfig", () => {
  it("has no default/base agent list (spec §55.1)", () => {
    const config = buildDefaultConfig(EMPTY_ENV);
    expect(config.agents).toEqual({});
  });

  it("matches the spec defaults", () => {
    const config = buildDefaultConfig(EMPTY_ENV);
    expect(config.gateway.host).toBe("127.0.0.1");
    expect(config.gateway.port).toBe(0);
    expect(config.gateway.baseUrl).toBeUndefined();
    expect(config.layout).toEqual({ minColumns: 50, minRows: 12, overflow: "new_tab" });
    expect(config.relay).toEqual({
      stableWindowMs: 350,
      turnStartTimeoutMs: 8000,
      settleTimeoutMs: 600000,
      messageTtlMs: 900000,
      maxQueueDepth: 32,
      maxDeliveryAttempts: 2,
    });
    expect(config.recovery).toEqual({ maxLaunchAttempts: 2, maxDeliveryAttempts: 2 });
    expect(config.defaults).toEqual({ visibility: "visible", focusNewAgent: false });
    expect(config.herdr.binPath).toBe("herdr");
    expect(config.herdr.launchabilityTtlMs).toBe(300000);
    expect(config.herdr.socketPath).toBeUndefined();
  });

  it("respects XDG_STATE_HOME for dbPath", () => {
    const stateHome = join("/", "custom", "state");
    const config = buildDefaultConfig({ XDG_STATE_HOME: stateHome });
    expect(config.dbPath).toBe(join(stateHome, "herdr-a2a", "state.sqlite"));
  });

  it("respects HERDR_SOCKET_PATH and HERDR_BIN_PATH", () => {
    const config = buildDefaultConfig({
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_BIN_PATH: "/usr/local/bin/herdr",
    });
    expect(config.herdr.socketPath).toBe("/tmp/herdr.sock");
    expect(config.herdr.binPath).toBe("/usr/local/bin/herdr");
  });
});

describe("AppConfigSchema", () => {
  it("parses the built-in defaults without error", () => {
    const config = buildDefaultConfig(EMPTY_ENV);
    const result = AppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("produces output structurally assignable to AppConfig", () => {
    const parsed: AppConfig = AppConfigSchema.parse(buildDefaultConfig(EMPTY_ENV));
    // If this compiles and runs, the schema's output type satisfies AppConfig.
    expect(parsed.gateway.port).toBe(0);
  });

  it("accepts a custom profile whose runtime is a plain, unvalidated string", () => {
    const config = buildDefaultConfig(EMPTY_ENV);
    // Raw config input has no `name` field per entry — the map key IS the name.
    const raw = { ...config, agents: { reviewer: { runtime: "some-future-runtime-kind" } } };
    const result = AppConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents.reviewer?.runtime).toBe("some-future-runtime-kind");
    }
  });

  it("injects the map key as the profile name", () => {
    const config = buildDefaultConfig(EMPTY_ENV);
    // Raw input has no `name` field per spec §6 — the key IS the name.
    const raw = { ...config, agents: { reviewer: { runtime: "codex" } } };
    const result = AppConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents.reviewer).toEqual({ name: "reviewer", runtime: "codex" });
    }
  });

  it("rejects a custom profile name with an uppercase letter", () => {
    const config = buildDefaultConfig(EMPTY_ENV);
    const raw = { ...config, agents: { Reviewer: { runtime: "codex" } } };
    const result = AppConfigSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join("\n");
      expect(message).toMatch(/Reviewer/);
      expect(message).toMatch(CUSTOM_AGENT_NAME_PATTERN.source.length > 0 ? /invalid/ : /invalid/);
    }
  });

  it("rejects a custom profile name that is too long or starts with a digit", () => {
    const config = buildDefaultConfig(EMPTY_ENV);
    const tooLong = "a".repeat(40);
    const raw = { ...config, agents: { [tooLong]: { runtime: "codex" }, "1bad": { runtime: "codex" } } };
    const result = AppConfigSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys on a custom profile (strict object)", () => {
    const config = buildDefaultConfig(EMPTY_ENV);
    const raw = { ...config, agents: { reviewer: { runtime: "codex", bogusField: true } } };
    const result = AppConfigSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });
});
