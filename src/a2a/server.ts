import express, { type Express, type Router } from "express";
import type { Server } from "node:http";

import { DefaultRequestHandler } from "@a2a-js/sdk/server";
import { UserBuilder, jsonRpcHandler, restHandler } from "@a2a-js/sdk/server/express";

import { DelegationFailure, ERROR_CODES, toDelegationError } from "../core/errors.js";
import type { AgentDescriptor } from "../core/model.js";
import type { AgentCatalog, AppConfig, DelegationService, Logger, TaskStore } from "../core/ports.js";
import type { DelegatedTaskService } from "../core/task-service.js";
import { agentEndpointPath, cardForDescriptor, gatewayCard } from "./cards.js";
import { toA2aTask } from "./task-mapper.js";
import { DurableA2ATaskStore } from "./durable-task-store.js";
import { DelegatingExecutor } from "./executor.js";

export interface GatewayOptions {
  catalog: AgentCatalog;
  delegation: DelegationService;
  taskService: DelegatedTaskService;
  /** Durable task store; also the A2A-facing projection for every endpoint. */
  tasks: TaskStore;
  config: AppConfig;
  logger: Logger;
  /** Optional readiness report, surfaced at `GET /doctor`. */
  doctor?: () => Promise<unknown>;
}

interface AgentEndpoint {
  descriptor: AgentDescriptor;
  router: Router;
}

/**
 * One local process serving many virtual Agent Cards (spec §4).
 *
 * Endpoints are built lazily from the catalog rather than declared up front,
 * because the catalog is derived from the live Herdr environment and can change
 * between requests without a restart (spec §5).
 */
export class A2AGateway {
  private readonly app: Express;
  private readonly endpoints = new Map<string, AgentEndpoint>();
  private readonly a2aTasks: DurableA2ATaskStore;
  private server: Server | undefined;
  private boundBaseUrl: string | undefined;

  constructor(private readonly opts: GatewayOptions) {
    // ONE store shared by every endpoint, so any endpoint can resolve any task
    // id and a restart does not lose them.
    this.a2aTasks = new DurableA2ATaskStore(opts.tasks);
    this.app = this.build();
  }

  private get baseUrl(): string {
    const configured = this.opts.config.gateway.baseUrl;
    if (configured !== undefined) return configured.replace(/\/+$/, "");
    if (this.boundBaseUrl !== undefined) return this.boundBaseUrl;
    // No endpoint is reachable before listen() completes. This fallback only
    // keeps construction deterministic for callers that inspect the app early.
    return `http://${this.opts.config.gateway.host}:${this.opts.config.gateway.port}`;
  }

  /** The configured external URL or the concrete address assigned at bind time. */
  get advertisedBaseUrl(): string {
    return this.baseUrl;
  }

  private build(): Express {
    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "4mb" }));

    app.get("/healthz", (_req, res) => {
      res.json({ ok: true });
    });

    app.get("/doctor", (_req, res) => {
      if (!this.opts.doctor) {
        res.status(501).json({ error: "doctor is not wired in this process" });
        return;
      }
      void this.opts
        .doctor()
        .then((report) => res.json(report))
        .catch((err: unknown) => res.status(500).json(toDelegationError(err)));
    });

    /**
     * The local catalog helper. A2A has no standard "list every agent on this
     * machine" call (spec §3), so discovery is served here rather than pretended
     * to be part of the protocol.
     */
    app.get("/agents", (_req, res) => {
      void this.opts.catalog
        .list()
        .then((descriptors) =>
          res.json({
            baseUrl: this.baseUrl,
            agents: descriptors.map((d) => ({
              name: d.name,
              kind: d.descriptorKind,
              runtime: d.runtimeKind,
              available: d.available,
              ...(d.unavailableReason ? { unavailableReason: d.unavailableReason } : {}),
              description: d.description,
              url: `${this.baseUrl}${agentEndpointPath(d.name)}`,
              discovery: {
                supportedByHerdr: d.runtime.supportedByHerdr,
                hasDetectionManifest: d.runtime.hasDetectionManifest,
                hasIntegration: d.runtime.hasIntegration,
                launchable: d.runtime.launchable,
                runningInstances: d.runtime.runningInstances,
                sources: d.runtime.sources,
                ...(d.runtime.launchableReason ? { reason: d.runtime.launchableReason } : {}),
              },
            })),
          }),
        )
        .catch((err: unknown) => this.sendError(res, err));
    });

    /**
     * Local helper: which agent owns a task. A2A has no cross-agent task
     * lookup, and without this a client holding only a task id would have to
     * probe every endpoint in turn. The durable store already knows.
     */
    app.get("/tasks/:id", (req, res) => {
      const id = req.params["id"];
      if (!id) {
        res.status(404).json({ error: "TASK_NOT_FOUND" });
        return;
      }
      void this.opts.tasks
        .get(id)
        .then((task) => {
          if (!task) {
            res.status(404).json({ error: "TASK_NOT_FOUND", taskId: id });
            return;
          }
          res.json({
            agent: task.target.name,
            url: `${this.baseUrl}${agentEndpointPath(task.target.name)}`,
            task: toA2aTask(task),
          });
        })
        .catch((err: unknown) => this.sendError(res, err));
    });

    /**
     * Tears down the pane/process behind a finished task, on demand. Distinct
     * from A2A `cancelTask` (an in-flight interrupt): `close` acts on a task
     * that already reached a terminal state and has no A2A-native meaning, so
     * it lives here as a gateway-local route rather than in the per-agent
     * executor, exactly like `GET /tasks/:id` above.
     */
    app.post("/tasks/:id/close", (req, res) => {
      const id = req.params["id"];
      if (!id) {
        res.status(404).json({ error: "TASK_NOT_FOUND" });
        return;
      }
      void this.opts.delegation
        .close(id)
        .then((task) => {
          res.json({
            agent: task.target.name,
            url: `${this.baseUrl}${agentEndpointPath(task.target.name)}`,
            task: toA2aTask(task),
          });
        })
        .catch((err: unknown) => {
          // Mirror GET /tasks/:id's 404 so the CLI's TaskNotFoundError path
          // (keyed on HTTP status, not the error body) works identically here.
          if (err instanceof DelegationFailure && err.code === ERROR_CODES.TASK_NOT_FOUND) {
            res.status(404).json({ error: err.toJSON(), taskId: id });
            return;
          }
          this.sendError(res, err);
        });
    });

    app.get("/.well-known/agent-card.json", (_req, res) => {
      void this.opts.catalog
        .list()
        .then((list) => res.json(gatewayCard(this.baseUrl, list.length)))
        .catch((err: unknown) => this.sendError(res, err));
    });

    // Every agent-scoped route resolves the endpoint first, so an unknown name
    // is a clean 404 rather than a confusing protocol error.
    app.use("/a2a/agents/:name", (req, res, next) => {
      const name = req.params["name"];
      if (!name) {
        res.status(404).json({ error: "AGENT_NOT_FOUND" });
        return;
      }
      void this.endpointFor(name)
        .then((endpoint) => {
          if (!endpoint) {
            res.status(404).json({ error: "AGENT_NOT_FOUND", agent: name });
            return;
          }
          endpoint.router(req, res, next);
        })
        .catch((err: unknown) => this.sendError(res, err));
    });

    return app;
  }

  /**
   * Builds (and caches) the router for one logical agent. The cache is keyed by
   * name and invalidated when the descriptor's availability changes, so a
   * runtime that disappears stops answering instead of serving a stale card.
   */
  private async endpointFor(name: string): Promise<AgentEndpoint | undefined> {
    const descriptor = await this.opts.catalog.get(name);
    if (!descriptor) {
      this.endpoints.delete(name);
      return undefined;
    }

    const cached = this.endpoints.get(name);
    if (cached && sameShape(cached.descriptor, descriptor)) return cached;

    const card = cardForDescriptor(descriptor, this.baseUrl);
    const executor = new DelegatingExecutor({
      agentName: descriptor.name,
      delegation: this.opts.delegation,
      taskService: this.opts.taskService,
      config: this.opts.config,
      logger: this.opts.logger.child({ agent: descriptor.name }),
    });

    const requestHandler = new DefaultRequestHandler(card, this.a2aTasks, executor);

    const router = express.Router();
    router.get("/", (_req, res) => {
      res.json(card);
    });
    router.use(restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
    router.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

    const endpoint: AgentEndpoint = { descriptor, router };
    this.endpoints.set(name, endpoint);
    return endpoint;
  }

  private sendError(res: express.Response, err: unknown): void {
    const body = err instanceof DelegationFailure ? err.toJSON() : toDelegationError(err);
    res.status(500).json({ error: body });
  }

  get expressApp(): Express {
    return this.app;
  }

  async listen(): Promise<{ host: string; port: number; baseUrl: string }> {
    const { host, port } = this.opts.config.gateway;
    await new Promise<void>((resolve, reject) => {
      const server = this.app.listen(port, host);
      this.server = server;
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = this.server?.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const actualHost = typeof address === "object" && address ? address.address : host;
    if (this.opts.config.gateway.baseUrl === undefined) {
      this.boundBaseUrl = `http://${urlHost(actualHost)}:${actualPort}`;
    }
    return { host: actualHost, port: actualPort, baseUrl: this.baseUrl };
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.boundBaseUrl = undefined;
  }
}

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** Availability and runtime identity are what a card and executor depend on. */
function sameShape(a: AgentDescriptor, b: AgentDescriptor): boolean {
  return (
    a.available === b.available &&
    a.runtimeKind === b.runtimeKind &&
    a.runtime.manifestVersion === b.runtime.manifestVersion &&
    a.profile?.instructions === b.profile?.instructions
  );
}
