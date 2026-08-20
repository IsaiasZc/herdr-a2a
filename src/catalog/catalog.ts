import type { AgentDescriptor, RuntimeDescriptor } from "../core/model.js";
import type { AgentCatalog, Clock, EventSink, HerdrDiscovery, LaunchabilityResolver } from "../core/ports.js";
import type { AgentInfo } from "../herdr/types.js";
import { EVENTS } from "../observability/events.js";
import { SingleFlight } from "./cache.js";
import { CustomRegistry } from "./custom-registry.js";

export interface AgentCatalogOptions {
  discovery: HerdrDiscovery;
  launchability: LaunchabilityResolver;
  customRegistry: CustomRegistry;
  /** Lets callers choose a session cache or direct socket read without coupling this package to either. */
  liveAgents: () => AgentInfo[] | Promise<AgentInfo[]>;
  eventSink: EventSink;
  clock: Pick<Clock, "now">;
  ttlMs: number;
}

export class AgentCatalogImpl implements AgentCatalog {
  private descriptors: AgentDescriptor[] | undefined;
  private refreshedAt = 0;
  private readonly flights = new SingleFlight();

  constructor(private readonly opts: AgentCatalogOptions) {}

  async refresh(): Promise<void> {
    return this.flights.run("catalog-refresh", async () => {
      this.opts.eventSink.emit(EVENTS.catalogRefreshStarted);
      const previous = new Map((this.descriptors ?? []).filter((entry) => entry.descriptorKind === "runtime").map((entry) => [entry.name, entry.available]));
      const [kinds, manifestStatus, integrations, liveAgents] = await Promise.all([
        this.opts.discovery.supportedKinds(),
        this.opts.discovery.manifests(),
        this.opts.discovery.integrationKinds(),
        this.opts.liveAgents(),
      ]);
      const manifests = new Map(manifestStatus.manifests.map((manifest) => [manifest.agent, manifest]));
      const integrationKinds = new Set(integrations);
      const liveCounts = new Map<string, number>();
      for (const agent of liveAgents) {
        if (!agent.agent) continue;
        liveCounts.set(agent.agent, (liveCounts.get(agent.agent) ?? 0) + 1);
      }

      const runtimes: RuntimeDescriptor[] = await Promise.all(kinds.map(async (kind) => {
        const [launchability, manifest] = await Promise.all([this.opts.launchability.resolve(kind), Promise.resolve(manifests.get(kind))]);
        return {
          kind,
          supportedByHerdr: true,
          hasDetectionManifest: manifest !== undefined,
          hasIntegration: integrationKinds.has(kind),
          launchable: launchability.launchable,
          runningInstances: liveCounts.get(kind) ?? 0,
          sources: [
            "herdr-cli-kinds",
            ...(manifest === undefined ? [] : ["herdr-manifests" as const]),
            ...(integrationKinds.has(kind) ? ["herdr-integrations" as const] : []),
            ...((liveCounts.get(kind) ?? 0) > 0 ? ["herdr-session" as const] : []),
          ],
          ...(manifest?.active_version ? { manifestVersion: manifest.active_version } : {}),
          ...(launchability.executablePath === undefined ? {} : { executablePath: launchability.executablePath }),
          launchableReason: launchability.reason,
        };
      }));
      const base: AgentDescriptor[] = runtimes.map((runtime) => ({
        name: runtime.kind,
        descriptorKind: "runtime",
        runtimeKind: runtime.kind,
        available: runtime.launchable === "yes",
        ...(runtime.launchable === "yes" ? {} : { unavailableReason: runtime.launchableReason ?? `runtime is ${runtime.launchable}` }),
        runtime,
        description: `Local ${runtime.kind} coding agent exposed through Herdr`,
      }));
      const next = [...base, ...this.opts.customRegistry.resolve(runtimes)];
      for (const entry of base) {
        const before = previous.get(entry.name);
        if (before !== undefined && before !== entry.available) {
          this.opts.eventSink.emit(EVENTS.catalogRuntimeChanged, { kind: entry.name, available: entry.available, previousAvailable: before });
        }
      }
      this.descriptors = next;
      this.refreshedAt = this.opts.clock.now().getTime();
      this.opts.eventSink.emit(EVENTS.catalogRefreshCompleted, { count: next.length, runtimeCount: runtimes.length });
    });
  }

  async list(): Promise<AgentDescriptor[]> {
    await this.ensureFresh();
    return this.descriptors ?? [];
  }

  async get(name: string): Promise<AgentDescriptor | undefined> {
    await this.ensureFresh();
    return this.descriptors?.find((entry) => entry.name === name);
  }

  private async ensureFresh(): Promise<void> {
    if (!this.descriptors || this.opts.clock.now().getTime() - this.refreshedAt >= this.opts.ttlMs) await this.refresh();
  }
}
