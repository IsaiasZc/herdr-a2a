import type { EventSink, Logger } from "../core/ports.js";

/** Canonical event names (spec §48). Emitters must use these constants. */
export const EVENTS = {
  catalogRefreshStarted: "catalog.refresh.started",
  catalogRefreshCompleted: "catalog.refresh.completed",
  catalogRuntimeChanged: "catalog.runtime.changed",

  taskCreated: "task.created",
  taskWorking: "task.working",
  taskInputRequired: "task.input_required",
  taskAuthRequired: "task.auth_required",
  taskCompleted: "task.completed",
  taskFailed: "task.failed",
  taskCanceled: "task.canceled",

  relayQueued: "relay.queued",
  relayDelivering: "relay.delivering",
  relayDelivered: "relay.delivered",
  relayTurnStarted: "relay.turn_started",
  relaySettled: "relay.settled",
  relayRetry: "relay.retry",
  relayExpired: "relay.expired",
  relayFailed: "relay.failed",

  spawnPreflightStarted: "spawn.preflight.started",
  spawnPreflightFailed: "spawn.preflight.failed",
  spawnReused: "spawn.reused",
  spawnPaneAllocated: "spawn.pane_allocated",
  spawnRuntimeStarting: "spawn.runtime_starting",
  spawnRuntimeReady: "spawn.runtime_ready",
  spawnFailed: "spawn.failed",

  layoutOverflowTab: "layout.overflow_tab",

  reconcileStarted: "reconcile.started",
  reconcileCompleted: "reconcile.completed",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

type Listener = (event: string, fields: Record<string, unknown>) => void;

export class LoggingEventSink implements EventSink {
  private readonly listeners = new Set<Listener>();

  constructor(private readonly logger: Logger) {}

  emit(event: string, fields: Record<string, unknown> = {}): void {
    this.logger.log("info", event, fields);
    for (const listener of this.listeners) {
      try {
        listener(event, fields);
      } catch {
        // A misbehaving observer must not break the emitting path.
      }
    }
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const nullEventSink: EventSink = { emit: () => {} };
