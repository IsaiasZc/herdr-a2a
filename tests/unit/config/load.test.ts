import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DelegationFailure, ERROR_CODES } from "../../../src/core/errors.js";
import type { AppConfig } from "../../../src/core/ports.js";
import { loadConfig, validateConfig } from "../../../src/config/load.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-a2a-config-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { XDG_STATE_HOME: join(dir, "state"), ...overrides };
}

describe("loadConfig", () => {
  it("returns defaults when no config file is present (missing file is not an error)", () => {
    const config = loadConfig({ path: join(dir, "does-not-exist.yaml"), env: baseEnv() });
    expect(config.agents).toEqual({});
    expect(config.gateway.port).toBe(0);
    expect(config.defaults.visibility).toBe("visible");
  });

  it("lets file values override defaults", () => {
    const file = join(dir, "config.yaml");
    writeFileSync(
      file,
      [
        "gateway:",
        "  port: 5000",
        "relay:",
        "  stableWindowMs: 500",
        "agents:",
        "  reviewer:",
        "    runtime: codex",
        "    model: gpt-5",
      ].join("\n"),
    );
    const config = loadConfig({ path: file, env: baseEnv() });
    expect(config.gateway.port).toBe(5000);
    // Without an explicit reverse-proxy URL, the gateway derives its URL after binding.
    expect(config.gateway.baseUrl).toBeUndefined();
    expect(config.relay.stableWindowMs).toBe(500);
    // Untouched fields keep their defaults.
    expect(config.relay.turnStartTimeoutMs).toBe(8000);
    expect(config.agents.reviewer).toEqual({ name: "reviewer", runtime: "codex", model: "gpt-5" });
  });

  it("lets `overrides` beat the file", () => {
    const file = join(dir, "config.yaml");
    writeFileSync(file, ["gateway:", "  port: 5000"].join("\n"));
    const config = loadConfig({ path: file, env: baseEnv(), overrides: { gateway: { port: 6000 } } });
    expect(config.gateway.port).toBe(6000);
    expect(config.gateway.baseUrl).toBeUndefined();
  });

  it("respects an explicit baseUrl instead of re-deriving it", () => {
    const file = join(dir, "config.yaml");
    writeFileSync(file, ["gateway:", "  port: 5000", "  baseUrl: https://example.internal"].join("\n"));
    const config = loadConfig({ path: file, env: baseEnv() });
    expect(config.gateway.baseUrl).toBe("https://example.internal");
  });

  it("throws a structured INVALID_EXECUTION_OPTION failure for a bad custom profile name", () => {
    const file = join(dir, "config.yaml");
    writeFileSync(file, ["agents:", "  Bad-Name:", "    runtime: codex"].join("\n"));
    try {
      loadConfig({ path: file, env: baseEnv() });
      expect.unreachable("loadConfig should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DelegationFailure);
      const failure = err as DelegationFailure;
      expect(failure.code).toBe(ERROR_CODES.INVALID_EXECUTION_OPTION);
      expect(JSON.stringify(failure.details)).toMatch(/Bad-Name/);
    }
  });

  it("accepts a custom profile whose runtime is a plain string not known to any catalog", () => {
    const file = join(dir, "config.yaml");
    writeFileSync(file, ["agents:", "  future-runtime:", "    runtime: not-a-real-kind-yet"].join("\n"));
    const config = loadConfig({ path: file, env: baseEnv() });
    expect(config.agents["future-runtime"]?.runtime).toBe("not-a-real-kind-yet");
  });

  it("produces a config structurally usable as AppConfig", () => {
    const config: AppConfig = loadConfig({ path: join(dir, "missing.yaml"), env: baseEnv() });
    expect(typeof config.dbPath).toBe("string");
  });
});

describe("validateConfig", () => {
  it("validates a raw object the same way loadConfig would", () => {
    const config = validateConfig({ agents: { reviewer: { runtime: "codex" } } });
    expect(config.agents.reviewer).toEqual({ name: "reviewer", runtime: "codex" });
  });

  it("rejects invalid input with a useful message", () => {
    expect(() => validateConfig({ agents: { BAD: { runtime: "codex" } } })).toThrow(DelegationFailure);
  });
});
