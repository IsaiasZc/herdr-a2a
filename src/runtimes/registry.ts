/**
 * `RuntimeAdapterRegistry` (src/core/ports.ts). Specific adapters are
 * exceptions, not the architecture (spec §17) — this registry exists so that
 * an exception, if one is ever needed, can override a single hook and
 * inherit everything else from the default adapter via `composeAdapter`
 * rather than reimplementing the whole interface.
 */

import type { RuntimeAdapter, RuntimeAdapterRegistry } from "../core/ports.js";
import { defaultRuntimeAdapter } from "./default-adapter.js";

/**
 * Builds a new adapter for `override.kind` that uses each hook from
 * `override` when present, falling back to the corresponding hook on `base`
 * otherwise. Keeps specific adapters tiny: they only need to implement the
 * one hook where the runtime genuinely differs (spec §17).
 */
export function composeAdapter(base: RuntimeAdapter, override: Partial<RuntimeAdapter> & { kind: string }): RuntimeAdapter {
  return {
    kind: override.kind,
    ...(override.validateOptions ? { validateOptions: override.validateOptions } : base.validateOptions ? { validateOptions: base.validateOptions } : {}),
    ...(override.buildAgentArgs ? { buildAgentArgs: override.buildAgentArgs } : base.buildAgentArgs ? { buildAgentArgs: base.buildAgentArgs } : {}),
    ...(override.classifyBlocker ? { classifyBlocker: override.classifyBlocker } : base.classifyBlocker ? { classifyBlocker: base.classifyBlocker } : {}),
    ...(override.extractResult ? { extractResult: override.extractResult } : base.extractResult ? { extractResult: base.extractResult } : {}),
    ...(override.formatPeerMessage ? { formatPeerMessage: override.formatPeerMessage } : base.formatPeerMessage ? { formatPeerMessage: base.formatPeerMessage } : {}),
  };
}

export class DefaultRuntimeAdapterRegistry implements RuntimeAdapterRegistry {
  private readonly byKind = new Map<string, RuntimeAdapter>();

  constructor(
    specificAdapters: readonly RuntimeAdapter[] = [],
    private readonly fallback: RuntimeAdapter = defaultRuntimeAdapter,
  ) {
    for (const adapter of specificAdapters) {
      this.byKind.set(adapter.kind, adapter);
    }
  }

  for(kind: string): RuntimeAdapter {
    return this.byKind.get(kind) ?? this.fallback;
  }
}
