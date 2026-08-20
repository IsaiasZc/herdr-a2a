import { describe, expect, it } from "vitest";

import { HELP_TEXT, parseArgs } from "../../../src/bridge/cli.js";

describe("parseArgs", () => {
  it("parses discover with --json", () => {
    const result = parseArgs(["discover", "--json"]);
    expect(result).toEqual({ ok: true, command: { verb: "discover", json: true } });
  });

  it("parses doctor with no flags", () => {
    const result = parseArgs(["doctor"]);
    expect(result).toEqual({ ok: true, command: { verb: "doctor", json: false } });
  });

  it("parses delegate with flags in one order", () => {
    const result = parseArgs(["delegate", "codex", "Review", "this", "diff", "--model", "gpt-5", "--wait", "--json"]);
    expect(result).toEqual({
      ok: true,
      command: {
        verb: "delegate",
        agent: "codex",
        message: "Review this diff",
        wait: true,
        json: true,
        model: "gpt-5",
      },
    });
  });

  it("parses delegate with the same flags in a different order", () => {
    const result = parseArgs(["delegate", "--json", "--model", "gpt-5", "codex", "--wait", "Review this diff"]);
    expect(result).toEqual({
      ok: true,
      command: {
        verb: "delegate",
        agent: "codex",
        message: "Review this diff",
        wait: true,
        json: true,
        model: "gpt-5",
      },
    });
  });

  it("parses --headless into visibility: headless", () => {
    const result = parseArgs(["delegate", "codex", "do", "it", "--headless"]);
    expect(result).toEqual({
      ok: true,
      command: {
        verb: "delegate",
        agent: "codex",
        message: "do it",
        wait: false,
        json: false,
        visibility: "headless",
      },
    });
  });

  it("supports --base-url on any verb", () => {
    const result = parseArgs(["get", "task-1", "--base-url", "http://example.test:9"]);
    expect(result).toEqual({
      ok: true,
      command: { verb: "get", taskId: "task-1", json: false, baseUrl: "http://example.test:9" },
    });
  });

  it("treats -- as the end of flag parsing, so a message starting with a dash passes through literally", () => {
    const result = parseArgs(["delegate", "codex", "--", "-x is not a flag, it is the message"]);
    expect(result).toEqual({
      ok: true,
      command: {
        verb: "delegate",
        agent: "codex",
        message: "-x is not a flag, it is the message",
        wait: false,
        json: false,
      },
    });
  });

  it("parses continue with a message and --wait", () => {
    const result = parseArgs(["continue", "task-42", "Yes,", "update", "the", "tests", "too", "--wait"]);
    expect(result).toEqual({
      ok: true,
      command: {
        verb: "continue",
        taskId: "task-42",
        message: "Yes, update the tests too",
        wait: true,
        json: false,
      },
    });
  });

  it("parses cancel", () => {
    const result = parseArgs(["cancel", "task-7", "--json"]);
    expect(result).toEqual({ ok: true, command: { verb: "cancel", taskId: "task-7", json: true } });
  });

  it("rejects an unknown verb with the help text on stderr", () => {
    const result = parseArgs(["frobnicate"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe(HELP_TEXT);
  });

  it("rejects a missing verb the same way as an unknown one", () => {
    const result = parseArgs([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe(HELP_TEXT);
  });

  it("rejects delegate missing its message", () => {
    const result = parseArgs(["delegate", "codex"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/usage: herdr-a2a delegate/);
  });

  it("rejects delegate missing everything", () => {
    const result = parseArgs(["delegate"]);
    expect(result.ok).toBe(false);
  });

  it("rejects get with no task id", () => {
    const result = parseArgs(["get"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/usage: herdr-a2a get/);
  });

  it("rejects continue missing its message", () => {
    const result = parseArgs(["continue", "task-1"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/usage: herdr-a2a continue/);
  });

  it("rejects an unknown flag", () => {
    const result = parseArgs(["discover", "--bogus"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/unknown flag --bogus/);
  });

  it("rejects a valued flag missing its value", () => {
    const result = parseArgs(["delegate", "codex", "hi", "--model"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/--model requires a value/);
  });

  it("rejects extra positional arguments on discover", () => {
    const result = parseArgs(["discover", "extra"]);
    expect(result.ok).toBe(false);
  });

  it("rejects extra positional arguments on get", () => {
    const result = parseArgs(["get", "task-1", "task-2"]);
    expect(result.ok).toBe(false);
  });
});
