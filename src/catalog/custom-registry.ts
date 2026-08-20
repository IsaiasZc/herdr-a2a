import { ERROR_CODES, fail } from "../core/errors.js";
import type { AgentDescriptor, CustomAgentProfile, RuntimeDescriptor } from "../core/model.js";

/** Our registry contains profiles only; discovered Herdr runtimes are never stored here. */
export class CustomRegistry {
  constructor(private readonly profiles: Record<string, CustomAgentProfile>) {}

  resolve(runtimes: RuntimeDescriptor[]): AgentDescriptor[] {
    const byKind = new Map(runtimes.map((runtime) => [runtime.kind, runtime]));
    const resolved: AgentDescriptor[] = [];
    for (const [key, profile] of Object.entries(this.profiles)) {
      const name = profile.name || key;
      if (byKind.has(name)) {
        throw fail(ERROR_CODES.INVALID_EXECUTION_OPTION, `custom profile ${name} collides with discovered Herdr runtime ${name}`, { name });
      }
      const runtime = byKind.get(profile.runtime);
      const available = runtime?.launchable === "yes";
      const unavailableReason = available
        ? undefined
        : `${ERROR_CODES.CUSTOM_AGENT_RUNTIME_UNAVAILABLE}: runtime ${profile.runtime} is ${runtime ? runtime.launchable : "not in the Herdr-derived catalog"}`;
      const fallbackRuntime: RuntimeDescriptor = runtime ?? {
        kind: profile.runtime,
        supportedByHerdr: false,
        hasDetectionManifest: false,
        hasIntegration: false,
        launchable: "unknown",
        runningInstances: 0,
        sources: ["custom-registry"],
        ...(unavailableReason === undefined ? {} : { launchableReason: unavailableReason }),
      };
      resolved.push({
        name,
        descriptorKind: "custom",
        runtimeKind: profile.runtime,
        available,
        ...(unavailableReason === undefined ? {} : { unavailableReason }),
        runtime: fallbackRuntime,
        profile,
        description: `Custom ${name} profile backed by ${profile.runtime}`,
      });
    }
    return resolved;
  }
}
