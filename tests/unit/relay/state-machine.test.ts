import { describe, expect, test } from "vitest";

import { canTransition, transition } from "../../../src/relay/state-machine.js";

describe("relay state machine", () => {
  test("allows a bounded delivery retry from DELIVERED back to QUEUED", () => {
    expect(canTransition("DELIVERED", "QUEUED")).toBe(true);
    expect(transition("DELIVERED", "QUEUED")).toBe("QUEUED");
  });

  test("rejects skipping turn-start proof", () => {
    expect(() => transition("DELIVERED", "SETTLED")).toThrow("invalid relay state transition");
  });
});
