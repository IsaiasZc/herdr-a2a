/** A persisted launchability result; storage is injected by the persistence package. */
export interface LaunchabilityCacheRecord {
  launchable: "yes" | "no" | "unknown";
  reason: string;
  executablePath?: string;
  checkedAt: string;
}

export interface LaunchabilityCache {
  get(kind: string): Promise<LaunchabilityCacheRecord | undefined>;
  set(kind: string, record: LaunchabilityCacheRecord): Promise<void>;
  invalidate(kind?: string): Promise<void>;
}

/** Test/local fallback; production persistence is deliberately outside this package. */
export class InMemoryLaunchabilityCache implements LaunchabilityCache {
  private readonly entries = new Map<string, LaunchabilityCacheRecord>();

  async get(kind: string): Promise<LaunchabilityCacheRecord | undefined> {
    return this.entries.get(kind);
  }

  async set(kind: string, record: LaunchabilityCacheRecord): Promise<void> {
    this.entries.set(kind, record);
  }

  async invalidate(kind?: string): Promise<void> {
    if (kind === undefined) this.entries.clear();
    else this.entries.delete(kind);
  }
}

/** Shares a keyed in-progress computation so callers do not stampede a live source. */
export class SingleFlight {
  private readonly pending = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const current = this.pending.get(key) as Promise<T> | undefined;
    if (current) return current;
    const created = work().finally(() => {
      if (this.pending.get(key) === created) this.pending.delete(key);
    });
    this.pending.set(key, created);
    return created;
  }
}
