/**
 * Composition root. Everything above this file is dependency-injected; this is
 * the only place that decides which concrete implementation fills each port.
 */

import { loadConfig } from "./config/index.js";
import { AgentCatalogImpl } from "./catalog/catalog.js";
import { CustomRegistry } from "./catalog/custom-registry.js";
import { HerdrDiscoveryImpl } from "./catalog/herdr-discovery.js";
import { LaunchabilityResolverImpl } from "./catalog/launchability.js";
import { runDoctor } from "./core/doctor.js";
import { HerdrDelegationService } from "./core/delegation-service.js";
import { ERROR_CODES, fail } from "./core/errors.js";
import { callerFromEnv, toSnapshot } from "./core/identities.js";
import { TERMINAL_TASK_STATES } from "./core/model.js";
import type { AppConfig } from "./core/ports.js";
import { StateReconciler } from "./core/reconciliation.js";
import { KeyedMutex, idGenerator, systemClock } from "./core/runtime-support.js";
import { DelegatedTaskService } from "./core/task-service.js";
import { HerdrSessionCache } from "./herdr/session-cache.js";
import { HerdrSocketClient } from "./herdr/socket-client.js";
import { A2AGateway } from "./a2a/server.js";
import { LoggingEventSink } from "./observability/events.js";
import { JsonLogger } from "./observability/logger.js";
import { createStores } from "./persistence/index.js";

export interface Gateway {
  readonly config: AppConfig;
  start(): Promise<{ host: string; port: number; baseUrl: string }>;
  stop(): Promise<void>;
  doctor(): Promise<unknown>;
}

export async function createGateway(overrides?: { configPath?: string }): Promise<Gateway> {
  const config = loadConfig(overrides?.configPath ? { path: overrides.configPath } : {});

  const clock = systemClock;
  const ids = idGenerator;
  const logger = new JsonLogger({ component: "herdr-a2a" });
  const events = new LoggingEventSink(logger.child({ component: "events" }));

  // Herdr must be reachable before anything else is built: without it there is
  // no catalog, no worker and nothing to delegate to.
  if (process.env["HERDR_ENV"] !== "1") {
    logger.log("warn", "HERDR_ENV is not 1 — this process may not be inside a Herdr-managed pane");
  }

  const stores = createStores({ dbPath: config.dbPath, clock });

  let sessionCache: HerdrSessionCache | undefined;
  const herdr = new HerdrSocketClient({
    ...(config.herdr.socketPath ? { socketPath: config.herdr.socketPath } : {}),
    logger: logger.child({ component: "herdr" }),
    onDisconnect: () => sessionCache?.handleDisconnect(),
  });

  sessionCache = new HerdrSessionCache({
    herdr,
    clock,
    logger: logger.child({ component: "session-cache" }),
    events,
  });

  const discovery = new HerdrDiscoveryImpl({ binPath: config.herdr.binPath, client: herdr });

  // The manifest's own command hint is the only honest source for a kind whose
  // CLI binary is named differently from its Herdr label. Guessing would be the
  // trial-and-error §18 forbids.
  const launchability = new LaunchabilityResolverImpl({
    cache: stores.launchability,
    ttlMs: config.herdr.launchabilityTtlMs,
    clock,
  });

  const catalog = new AgentCatalogImpl({
    discovery,
    launchability,
    customRegistry: new CustomRegistry(config.agents),
    liveAgents: () => sessionCache!.agents(),
    eventSink: events,
    clock,
    ttlMs: config.herdr.launchabilityTtlMs,
  });

  const gateway = await wire({
    config,
    clock,
    ids,
    logger,
    events,
    herdr,
    sessionCache,
    catalog,
    stores,
  });

  return gateway;
}

/**
 * Split out from `createGateway` so integration tests can inject fakes for the
 * pieces they want to control without rebuilding the whole graph.
 */
async function wire(deps: {
  config: AppConfig;
  clock: typeof systemClock;
  ids: typeof idGenerator;
  logger: JsonLogger;
  events: LoggingEventSink;
  herdr: HerdrSocketClient;
  sessionCache: HerdrSessionCache;
  catalog: AgentCatalogImpl;
  stores: ReturnType<typeof createStores>;
}): Promise<Gateway> {
  const { config, clock, ids, logger, events, herdr, sessionCache, catalog, stores } = deps;

  const { DefaultRuntimeAdapterRegistry, defaultRuntimeAdapter } = await import("./runtimes/index.js");
  const { DefaultLayoutManager } = await import("./layout/index.js");
  const { DefaultSpawnManager, DefaultPreflight, DefaultReusePolicy } = await import("./spawn/index.js");
  const { QueuedPromptTransport } = await import("./relay/index.js");

  const adapters = new DefaultRuntimeAdapterRegistry([], defaultRuntimeAdapter);
  const layoutLock = new KeyedMutex();
  const targetLock = new KeyedMutex();

  const layout = new DefaultLayoutManager({
    herdr,
    cursors: stores.cursors,
    config: config.layout,
    lock: layoutLock,
    clock,
    events,
    logger: logger.child({ component: "layout" }),
  });

  const taskService = new DelegatedTaskService({
    tasks: stores.tasks,
    liveAgents: stores.liveAgents,
    herdr,
    adapters,
    clock,
    events,
    logger: logger.child({ component: "tasks" }),
  });

  const preflight = new DefaultPreflight({ herdr, adapters, events, logger });
  const reuse = new DefaultReusePolicy({
    herdr,
    hasActiveTask: async (instanceId: string) => {
      const tasks = await stores.tasks.listByInstance(instanceId);
      return tasks.some((t) => t.state === "submitted" || t.state === "working");
    },
    logger,
  });

  const spawn = new DefaultSpawnManager({
    herdr,
    layout,
    preflight,
    reuse,
    liveAgents: stores.liveAgents,
    adapters,
    ids,
    clock,
    config: { recovery: config.recovery },
    events,
    logger: logger.child({ component: "spawn" }),
  });

  const relay = new QueuedPromptTransport({
    herdr,
    queue: stores.queue,
    liveAgents: stores.liveAgents,
    adapters,
    lock: targetLock,
    clock,
    config: config.relay,
    events,
    logger: logger.child({ component: "relay" }),
  });

  const delegation = new HerdrDelegationService({
    catalog,
    spawn,
    relay,
    queue: stores.queue,
    tasks: stores.tasks,
    taskService,
    liveAgents: stores.liveAgents,
    adapters,
    herdr,
    config,
    ids,
    clock,
    events,
    logger: logger.child({ component: "delegation" }),
    resolveCaller: () => callerFromEnv(process.env, (paneId) => sessionCache.agentByPane(paneId)),
    callerContext: () => {
      const paneId = process.env["HERDR_PANE_ID"];
      const pane = paneId ? sessionCache.pane(paneId) : undefined;
      return {
        ...(paneId ? { paneId } : {}),
        ...(process.env["HERDR_TAB_ID"] ? { tabId: process.env["HERDR_TAB_ID"] } : {}),
        ...(process.env["HERDR_WORKSPACE_ID"] ? { workspaceId: process.env["HERDR_WORKSPACE_ID"] } : {}),
        ...(pane?.cwd ? { cwd: pane.cwd } : {}),
      };
    },
  });

  const reconciler = new StateReconciler({
    herdr,
    sessionCache,
    liveAgents: stores.liveAgents,
    tasks: stores.tasks,
    queue: stores.queue,
    relay,
    taskService,
    clock,
    events,
    logger: logger.child({ component: "reconcile" }),
  });

  const { loadSchema } = await import("./herdr/schema-loader.js");
  const doctor = () =>
    runDoctor({
      herdr,
      catalog,
      config,
      logger,
      loadSchema: () => loadSchema({ binPath: config.herdr.binPath }),
      probeDatabase: async () => {
        // A read-only open can succeed on a read-only file; a write proves it.
        stores.db.exec("CREATE TABLE IF NOT EXISTS _doctor_probe (ok INTEGER)");
        stores.db.exec("DROP TABLE IF EXISTS _doctor_probe");
      },
    });

  const http = new A2AGateway({
    catalog,
    delegation,
    taskService,
    tasks: stores.tasks,
    config,
    logger: logger.child({ component: "gateway" }),
    doctor,
  });

  const unsubscribers: (() => void)[] = [];

  return {
    config,

    async start() {
      await herdr.assertCompatible();
      await sessionCache.start();
      await catalog.refresh();
      await relay.start();

      // A status change is the only reliable signal that a target became
      // deliverable or that a turn ended, so it drives both the relay pump and
      // the task lifecycle instead of a polling loop (spec §53).
      unsubscribers.push(
        sessionCache.onAgentStatus((info) => {
          void (async () => {
            const snapshot = toSnapshot(info, clock);
            const records = await stores.liveAgents.all();
            const record = records.find((r) =>
              snapshot.sessionRef && r.sessionRef
                ? r.sessionRef === snapshot.sessionRef
                : r.terminalId === snapshot.terminalId,
            );
            if (!record) return;
            await taskService.observe(record.instanceId, snapshot);
            relay.notifyTargetChanged(record.instanceId);
          })().catch((err: unknown) =>
            logger.log("warn", "status fan-out failed", { error: String(err) }),
          );
        }),
      );

      // Herdr may have restarted under us; never resume a queue before identity
      // is re-verified (spec §40).
      unsubscribers.push(
        sessionCache.onResync(() => {
          void reconciler.reconcile().catch((err: unknown) =>
            logger.log("warn", "reconcile after resync failed", { error: String(err) }),
          );
        }),
      );

      // The relay proves turn-start; the task layer owns what that means for
      // the A2A lifecycle. Handing the pre-prompt sequence across that seam is
      // what keeps `idle` from ever being mistaken for `completed`.
      unsubscribers.push(
        relay.onTurnStarted((message, preSeq) => {
          void taskService.noteTurnStarted(message, preSeq).catch((err: unknown) =>
            logger.log("warn", "turn-start bookkeeping failed", {
              task_id: message.taskId,
              error: String(err),
            }),
          );
        }),
      );

      // The relay is the authority on when our turn ended, because it holds the
      // pre-prompt sequence baseline. Completion is driven from its SETTLED
      // transition rather than from a status event that may never arrive.
      unsubscribers.push(
        relay.onStateChange((message) => {
          if (message.state !== "SETTLED") return;
          void taskService
            .settleFromRelay(message.taskId, message.targetInstanceId)
            .catch((err: unknown) =>
              logger.log("warn", "settle from relay failed", {
                task_id: message.taskId,
                error: String(err),
              }),
            );
        }),
      );

      // A permanently failed delivery must fail its task. Otherwise a
      // delegation that can never land looks identical to one still in flight.
      unsubscribers.push(
        relay.onFailed((message, error) => {
          void stores.tasks
            .get(message.taskId)
            .then((task) => {
              if (!task || TERMINAL_TASK_STATES.has(task.state)) return undefined;
              return taskService.transition(message.taskId, "failed", { error });
            })
            .catch((err: unknown) =>
              logger.log("warn", "failing task after delivery failure failed", {
                task_id: message.taskId,
                error: String(err),
              }),
            );
        }),
      );

      // A blocked target is surfaced, never typed through (spec §29, §39).
      unsubscribers.push(
        relay.onBlocked((message, blocker) => {
          const state = blocker.kind === "auth" ? "auth-required" : "input-required";
          void taskService
            .transition(message.taskId, state, blocker.text ? { question: blocker.text } : {})
            .catch((err: unknown) =>
              logger.log("warn", "blocker surfacing failed", {
                task_id: message.taskId,
                error: String(err),
              }),
            );
        }),
      );

      await reconciler.reconcile();
      const listening = await http.listen();
      logger.log("info", "gateway listening", listening);
      return listening;
    },

    async stop() {
      for (const off of unsubscribers.splice(0)) off();
      await http.close();
      await relay.stop();
      await sessionCache.stop();
      await herdr.close();
      stores.close();
    },

    doctor,
  };
}

async function cli(): Promise<number> {
  const command = process.argv[2] ?? "serve";

  if (command === "doctor") {
    const gateway = await createGateway();
    try {
      const report = await gateway.doctor();
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return (report as { ok: boolean }).ok ? 0 : 1;
    } finally {
      await gateway.stop();
    }
  }

  if (command !== "serve") {
    process.stderr.write(`usage: herdr-a2a-gateway [serve|doctor]\n`);
    return 2;
  }

  const gateway = await createGateway();
  const listening = await gateway.start();
  process.stdout.write(`herdr-a2a gateway listening on ${listening.baseUrl}\n`);

  const shutdown = () => {
    void gateway.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return new Promise<number>(() => {
    /* run until signalled */
  });
}

const isEntrypoint = process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js");
if (isEntrypoint) {
  cli().then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${detail}\n`);
      process.exit(1);
    },
  );
}

export { fail, ERROR_CODES };
