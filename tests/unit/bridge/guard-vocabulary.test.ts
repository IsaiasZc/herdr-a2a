import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Enforces spec §8.1 / §55: the bridge is a thin A2A client facade with no
 * orchestration logic, and its skill (spec §8, Milestone 6) must never need
 * to explain pane topology, Herdr layout flags, or retry recipes. If any of
 * this vocabulary shows up in the shipped source or the skill file, the
 * abstraction has leaked. Scans everything under src/bridge EXCEPT the test
 * files themselves (this file included), which are of course allowed to name
 * the forbidden words in order to check for them.
 */
const FORBIDDEN = ["pane", "split", "--kind", "retry"];

const BRIDGE_DIR = join(process.cwd(), "src", "bridge");

function findForbidden(text: string): string[] {
  const lower = text.toLowerCase();
  return FORBIDDEN.filter((word) => lower.includes(word.toLowerCase()));
}

describe("bridge guard: forbidden vocabulary", () => {
  it("no file directly under src/bridge/*.ts mentions pane/split/--kind/retry", () => {
    const entries = readdirSync(BRIDGE_DIR, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts"),
    );
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      const path = join(BRIDGE_DIR, entry.name);
      const hits = findForbidden(readFileSync(path, "utf8"));
      expect(hits, `${entry.name} must not mention: ${hits.join(", ")}`).toEqual([]);
    }
  });

  it("src/bridge/skill/SKILL.md never teaches pane/split/--kind/retry", () => {
    const skillPath = join(BRIDGE_DIR, "skill", "SKILL.md");
    const hits = findForbidden(readFileSync(skillPath, "utf8"));
    expect(hits, `SKILL.md must not mention: ${hits.join(", ")}`).toEqual([]);
  });
});
