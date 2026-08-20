import { randomBytes } from "node:crypto";

import type { Clock, IdGenerator, Mutex } from "./ports.js";

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function short(bytes = 3): string {
  return randomBytes(bytes).toString("hex");
}

export const idGenerator: IdGenerator = {
  taskId: () => `task_${short(6)}`,
  messageId: () => `msg_${short(6)}`,
  instanceId: () => `inst_${short(6)}`,
  shortId: () => short(2),
};

/**
 * Promise-chain mutex keyed by string. Serializes per key without blocking
 * unrelated keys — one lock per target instance, one per tab.
 */
export class KeyedMutex implements Mutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    // Swallow the predecessor's rejection so one failure cannot poison the key.
    const run = previous.then(
      () => fn(),
      () => fn(),
    );
    this.chains.set(key, run);
    try {
      return await run;
    } finally {
      if (this.chains.get(key) === run) this.chains.delete(key);
    }
  }
}

/** Rejects with `reason` if `promise` has not settled within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A promise plus its resolvers, for event-driven waits. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
