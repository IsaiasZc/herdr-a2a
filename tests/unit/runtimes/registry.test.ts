import { describe, expect, it } from "vitest";

import type { RuntimeAdapter, RuntimeContext } from "../../../src/core/ports.js";
import { defaultRuntimeAdapter } from "../../../src/runtimes/default-adapter.js";
import { composeAdapter, DefaultRuntimeAdapterRegistry } from "../../../src/runtimes/registry.js";

describe("DefaultRuntimeAdapterRegistry", () => {
  it("falls back to the default adapter for an unknown kind", () => {
    const registry = new DefaultRuntimeAdapterRegistry([]);
    expect(registry.for("some-unregistered-kind")).toBe(defaultRuntimeAdapter);
  });

  it("returns a specific adapter when one is registered for that kind", () => {
    const specific: RuntimeAdapter = { kind: "widget", buildAgentArgs: async () => ["--widget"] };
    const registry = new DefaultRuntimeAdapterRegistry([specific]);
    expect(registry.for("widget")).toBe(specific);
    expect(registry.for("other")).toBe(defaultRuntimeAdapter);
  });
});

describe("composeAdapter", () => {
  it("uses the override hook when present and falls back to the base hook otherwise", async () => {
    const composed = composeAdapter(defaultRuntimeAdapter, {
      kind: "widget",
      buildAgentArgs: async () => ["--widget-only"],
    });
    expect(composed.kind).toBe("widget");
    await expect(composed.buildAgentArgs?.({ runtimeKind: "widget", cwd: "/tmp" })).resolves.toEqual([
      "--widget-only",
    ]);
    // classifyBlocker was not overridden, so it inherits the default adapter's.
    expect(composed.classifyBlocker).toBe(defaultRuntimeAdapter.classifyBlocker);
    // validateOptions likewise inherited: still throws MODEL_UNSUPPORTED for a model request.
    const ctx: RuntimeContext = { runtimeKind: "widget", cwd: "/tmp", model: "x" };
    await expect(composed.validateOptions?.(ctx)).rejects.toMatchObject({ code: "MODEL_UNSUPPORTED" });
  });

  it("omits a hook entirely when neither base nor override defines it", () => {
    const bareBase: RuntimeAdapter = { kind: "base" };
    const composed = composeAdapter(bareBase, { kind: "widget" });
    expect(composed.formatPeerMessage).toBeUndefined();
  });
});
