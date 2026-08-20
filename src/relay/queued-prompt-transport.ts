import { ERROR_CODES, fail } from "../core/errors.js";
import type { DelegationError } from "../core/errors.js";
import type { Blocker, RelayMessage, RelayReceipt } from "../core/model.js";
import type {
  Clock,
  EventSink,
  HerdrClient,
  LiveAgentStore,
  Logger,
  Mutex,
  QueueStore,
  Relay,
  RelayConfig,
  RuntimeAdapterRegistry,
} from "../core/ports.js";
import { DeliveryWorker } from "./delivery-worker.js";

export interface QueuedPromptTransportOptions {
  herdr: HerdrClient;
  queue: QueueStore;
  liveAgents: LiveAgentStore;
  adapters: RuntimeAdapterRegistry;
  lock: Mutex;
  clock: Clock;
  config: RelayConfig;
  events: EventSink;
  logger: Logger;
}

/** Durable FIFO transport shim for Herdr's immediate `agent.prompt` API. */
export class QueuedPromptTransport implements Relay {
  private readonly stateHandlers = new Set<(message: RelayMessage) => void>();
  private readonly startedHandlers = new Set<(message: RelayMessage, preSeq: number) => void>();
  private readonly blockerHandlers = new Set<(message: RelayMessage, blocker: Blocker) => void>();
  private readonly failedHandlers = new Set<(message: RelayMessage, error: DelegationError) => void>();
  private readonly worker: DeliveryWorker;

  constructor(private readonly opts: QueuedPromptTransportOptions) {
    this.worker = new DeliveryWorker({
      ...opts,
      onStateChange: (message) => this.emitState(message),
      onTurnStarted: (message, preSeq) => this.emitTurnStarted(message, preSeq),
      onFailed: (message, error) => this.emitFailed(message, error),
      onBlocker: (message, blocker) => this.emitBlocker(message, blocker),
    });
  }

  start(): Promise<void> {
    return this.worker.start();
  }

  stop(): Promise<void> {
    return this.worker.stop();
  }

  async enqueue(message: RelayMessage): Promise<RelayReceipt> {
    const existing = await this.opts.queue.get(message.id);
    if (existing) {
      return {
        messageId: existing.id,
        state: existing.state,
        queuePosition: await this.opts.queue.depth(existing.targetInstanceId),
      };
    }
    if (await this.opts.queue.depth(message.targetInstanceId) >= this.opts.config.maxQueueDepth) {
      throw fail(ERROR_CODES.QUEUE_FULL, "relay queue is at its configured depth", {
        targetInstanceId: message.targetInstanceId,
        maxQueueDepth: this.opts.config.maxQueueDepth,
      });
    }
    const position = await this.opts.queue.push(message);
    this.emitState(message);
    this.opts.events.emit("relay.queued", { messageId: message.id, targetInstanceId: message.targetInstanceId, position });
    this.notifyTargetChanged(message.targetInstanceId);
    return { messageId: message.id, state: message.state, queuePosition: position };
  }

  async cancel(messageId: string): Promise<void> {
    const message = await this.opts.queue.get(messageId);
    if (!message) throw fail(ERROR_CODES.RELAY_MESSAGE_NOT_FOUND, `no relay message with id ${messageId}`, { messageId });
    await this.opts.queue.remove(messageId);
    this.notifyTargetChanged(message.targetInstanceId);
  }

  async cancelForTarget(targetInstanceId: string): Promise<void> {
    let head = await this.opts.queue.peek(targetInstanceId);
    while (head) {
      await this.opts.queue.remove(head.id);
      head = await this.opts.queue.peek(targetInstanceId);
    }
  }

  onStateChange(handler: (message: RelayMessage) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  /** Hands TaskService the exact baseline required for settlement proof. */
  onTurnStarted(handler: (message: RelayMessage, preSeq: number) => void): () => void {
    this.startedHandlers.add(handler);
    return () => this.startedHandlers.delete(handler);
  }

  onFailed(handler: (message: RelayMessage, error: DelegationError) => void): () => void {
    this.failedHandlers.add(handler);
    return () => this.failedHandlers.delete(handler);
  }

  private emitFailed(message: RelayMessage, error: DelegationError): void {
    for (const handler of this.failedHandlers) {
      try {
        handler(message, error);
      } catch (err) {
        this.opts.logger.log("warn", "relay failure handler threw", { messageId: message.id, error: String(err) });
      }
    }
  }

  onBlocked(handler: (message: RelayMessage, blocker: Blocker) => void): () => void {
    this.blockerHandlers.add(handler);
    return () => this.blockerHandlers.delete(handler);
  }

  /** Event-driven nudge from the session-cache status fan-out. */
  notifyTargetChanged(instanceId: string): void {
    // A real observed change earns a fresh fallback-probe budget.
    this.worker.resetRecheckBudget(instanceId);
    this.worker.notifyTargetChanged(instanceId);
  }

  private emitState(message: RelayMessage): void {
    for (const handler of this.stateHandlers) handler(message);
  }

  private emitTurnStarted(message: RelayMessage, preSeq: number): void {
    for (const handler of this.startedHandlers) handler(message, preSeq);
  }

  private emitBlocker(message: RelayMessage, blocker: Blocker): void {
    for (const handler of this.blockerHandlers) handler(message, blocker);
  }
}
