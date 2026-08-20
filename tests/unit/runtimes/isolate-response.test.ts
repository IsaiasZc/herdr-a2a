import { describe, expect, test } from "vitest";

import { isolateResponse } from "../../../src/runtimes/default-adapter.js";

const PAD = " ".repeat(80);

/**
 * Captured from a real opencode worker in a narrow visible pane during a live
 * delegation. See docs/herdr-contract.md §11 on why a terminal read is the
 * weakest extraction tier.
 */
const NARROW_PANE_READ = [
  "  ┃",
  "  ┃  [peer-agent message]",
  "  ┃  from: claude:2ae7",
  "  ┃  task: 65a92f2b-d0dc-44c8-bac7-61286408ef60",
  "  ┃",
  "  ┃  Reply with exactly the single word: PONG. Nothing else.",
  "  ┃",
  "",
  "     PONG",
  "",
  "     ▣  Build · Muse Spark 1.2 Contributor · 4.4s",
].join("\n");

/**
 * Captured from the same worker in a WIDE headless tab, where the TUI renders a
 * right-hand column on the same rows. This shape broke an earlier version that
 * required the marker line to equal the marker exactly.
 */
const WIDE_TAB_READ = [
  `┃${PAD}`,
  "  ┃  [peer-agent message]",
  `  ┃  from: claude:2ae7${PAD}Context`,
  `  ┃  task: 4fe229e7-cac3-4405-acf5-3ccc6aabd0cf${PAD}44,560 tokens`,
  `  ┃${PAD}4% used`,
  `  ┃  Reply with only: HEADLESS-OK${PAD}`,
  "  ┃",
  `${PAD}`,
  `     Ready to help — what would you like to build or fix in herdr-a2a?${PAD}`,
  "",
  `     ▣  Build · Muse Spark 1.2 Contributor · 10.2s${PAD}`,
].join("\n");

describe("isolateResponse", () => {
  test("keeps only the response from a narrow visible pane", () => {
    const result = isolateResponse(NARROW_PANE_READ, "65a92f2b-d0dc-44c8-bac7-61286408ef60");
    expect(result).toContain("PONG");
    // The caller must not get their own prompt handed back as the answer.
    expect(result).not.toContain("Reply with exactly");
    expect(result).not.toContain("[peer-agent message]");
    expect(result).not.toContain("from: claude");
  });

  test("keeps only the response when the TUI renders a right-hand column", () => {
    const result = isolateResponse(WIDE_TAB_READ, "4fe229e7-cac3-4405-acf5-3ccc6aabd0cf");
    expect(result).toContain("Ready to help");
    expect(result).not.toContain("Reply with only");
    expect(result).not.toContain("[peer-agent message]");
    // The right-hand column shares rows with the envelope, so it goes with it.
    expect(result).not.toContain("44,560 tokens");
  });

  test("returns the read unchanged when our marker is absent", () => {
    const text = "some output with no envelope at all";
    expect(isolateResponse(text, "task_missing")).toBe(text);
  });

  test("returns empty when nothing follows the echoed block", () => {
    const text = ["┃ task: task_1", "┃", "┃ do the thing"].join("\n");
    expect(isolateResponse(text, "task_1")).toBe("");
  });

  test("uses the LAST echo of the marker when a transcript repeats it", () => {
    const text = [
      "┃ task: task_1",
      "┃",
      "┃ first ask",
      "",
      "stale answer",
      "┃ task: task_1",
      "┃",
      "┃ second ask",
      "",
      "fresh answer",
    ].join("\n");
    const result = isolateResponse(text, "task_1");
    expect(result).toBe("fresh answer");
    expect(result).not.toContain("stale");
  });
});
