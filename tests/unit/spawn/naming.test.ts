import { describe, expect, it } from "vitest";

import { isValidHerdrAgentName, liveAgentName } from "../../../src/spawn/naming.js";

describe("liveAgentName", () => {
  it("produces a2a-<kind>-<shortid>", () => {
    expect(liveAgentName("codex", "a81f")).toBe("a2a-codex-a81f");
  });

  it("sanitizes uppercase and invalid characters to lowercase/dashes", () => {
    const name = liveAgentName("My.Weird Kind!", "a81f");
    expect(isValidHerdrAgentName(name)).toBe(true);
    expect(name).toBe(name.toLowerCase());
  });

  it("truncates a long kind rather than the short id, staying within 32 chars", () => {
    const longKind = "a".repeat(60);
    const name = liveAgentName(longKind, "a81f");

    expect(name.length).toBeLessThanOrEqual(32);
    expect(isValidHerdrAgentName(name)).toBe(true);
    // The short id must survive intact — it's what disambiguates instances.
    expect(name.endsWith("-a81f")).toBe(true);
  });

  it("always matches Herdr's naming regex even for pathological kinds", () => {
    const cases = ["123startswithdigit", "", "!!!", "Already-Valid_Name", "kind with spaces"];
    for (const kind of cases) {
      const name = liveAgentName(kind, "b2c3");
      expect(isValidHerdrAgentName(name)).toBe(true);
    }
  });
});

describe("isValidHerdrAgentName", () => {
  it("accepts names matching [a-z][a-z0-9_-]{0,31}", () => {
    expect(isValidHerdrAgentName("a2a-codex-a81f")).toBe(true);
    expect(isValidHerdrAgentName("a")).toBe(true);
  });

  it("rejects names starting with a digit, uppercase, or exceeding 32 chars", () => {
    expect(isValidHerdrAgentName("1abc")).toBe(false);
    expect(isValidHerdrAgentName("Abc")).toBe(false);
    expect(isValidHerdrAgentName("a".repeat(33))).toBe(false);
  });
});
