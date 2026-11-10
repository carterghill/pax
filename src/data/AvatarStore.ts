export type AvatarUrl = string | null;
export type AvatarLoader = (ids: string[]) => Promise<Record<string, AvatarUrl>>;

type Options = {
  load: AvatarLoader;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  storageKey: string;
  preload?: (path: string) => void;
  debounceMs?: number;
  retryMs?: number;
};

// User and room IDs have distinct prefixes. Preserve case for opaque room IDs.
function keyFor(id: string): string {
  const key = id.trim();
  return key.startsWith("!") ? key : key.toLowerCase();
}

/** Avatar identities and subscriptions only; bytes live in the Rust file cache. */
export class AvatarStore {
  private entries = new Map<string, AvatarUrl>();
  private listeners = new Map<string, Set<() => void>>();
  private revisions = new Map<string, number>();
  private queued = new Map<string, number>();
  private failures = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private running = false;
  private active = true;
  private options: Options;

  constructor(options: Options) {
    this.options = options;
    try {
      const stored = JSON.parse(options.storage?.getItem(options.storageKey) ?? "{}");
      if (stored && typeof stored === "object") {
        for (const [id, path] of Object.entries(stored)) {
          // Do not persist absent/error results across sessions.
          if (typeof path === "string" && path) {
            this.entries.set(keyFor(id), path);
            options.preload?.(path);
          }
        }
      }
    } catch { /* Corrupt storage is a cache miss. */ }
  }

  lookup(id: string): AvatarUrl | undefined {
    return this.entries.get(keyFor(id));
  }

  subscribe(id: string, listener: () => void): () => void {
    const key = keyFor(id);
    let listeners = this.listeners.get(key);
    if (!listeners) this.listeners.set(key, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        this.listeners.delete(key);
        this.queued.delete(key);
      }
    };
  }

  private notify(key: string) {
    for (const listener of this.listeners.get(key) ?? []) listener();
  }

  prime(id: string, path: AvatarUrl | undefined): void {
    if (path === undefined || !id.trim()) return;
    const key = keyFor(id);
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    this.queued.delete(key);
    this.failures.delete(key);
    if (this.entries.has(key) && this.entries.get(key) === path) return;
    this.entries.set(key, path);
    if (path) this.options.preload?.(path);
    this.notify(key);
    this.persist();
  }

  primeMany(entries: Iterable<{ userId?: string | null; avatarUrl?: string | null }>): void {
    for (const entry of entries) {
      // List responses omit unresolved avatars; only explicit lookups confirm absence.
      if (entry.userId && entry.avatarUrl) this.prime(entry.userId, entry.avatarUrl);
    }
  }

  invalidate(id: string): void {
    const key = keyFor(id);
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    this.entries.delete(key);
    this.failures.delete(key);
    this.notify(key);
    if (this.listeners.has(key)) this.requestFetch([key]);
    this.persist();
  }

  requestFetch(ids: Iterable<string>): void {
    if (!this.active) return;
    for (const id of ids) {
      const key = keyFor(id);
      if (key && !this.entries.has(key) && !this.queued.has(key)) this.queued.set(key, 0);
    }
    this.schedule();
  }

  /** Revalidate hydrated paths after sync, keeping them visible during refresh. */
  refreshVisible(): void {
    if (!this.active) return;
    for (const key of this.listeners.keys()) {
      if (!key) continue;
      this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
      this.queued.set(key, 0);
    }
    this.schedule();
  }

  private schedule(): void {
    if (!this.active || this.running || !this.queued.size) return;
    if (this.timer) clearTimeout(this.timer);
    const next = Math.min(...this.queued.values());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, Math.max(this.options.debounceMs ?? 16, next - Date.now()));
  }

  private retry(key: string): void {
    if (!this.listeners.has(key) || this.entries.has(key)) return;
    const failures = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, failures);
    const delay = Math.min((this.options.retryMs ?? 1000) * 2 ** Math.min(failures - 1, 5), 30_000);
    this.queued.set(key, Date.now() + delay);
  }

  private async flush(): Promise<void> {
    const ids = [...this.queued].filter(([, due]) => due <= Date.now()).slice(0, 64).map(([id]) => id);
    if (!ids.length) { this.schedule(); return; }
    const epoch = this.epoch;
    const revisions = ids.map((id) => this.revisions.get(id) ?? 0);
    for (const id of ids) this.queued.delete(id);
    this.running = true;
    try {
      const result = await this.options.load(ids);
      if (!this.active || epoch !== this.epoch) return;
      ids.forEach((id, index) => {
        if ((this.revisions.get(id) ?? 0) !== revisions[index]) return;
        // A missing key is unavailable, not a successful "no avatar" result.
        if (Object.prototype.hasOwnProperty.call(result, id)) this.prime(id, result[id]);
        else this.retry(id);
      });
    } catch {
      if (this.active && epoch === this.epoch) {
        ids.forEach((id, index) => {
          if ((this.revisions.get(id) ?? 0) === revisions[index]) this.retry(id);
        });
      }
    } finally {
      if (epoch === this.epoch) {
        this.running = false;
        this.schedule();
      }
    }
  }

  private persist(): void {
    if (!this.active || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        const paths = Object.fromEntries([...this.entries].filter(([, path]) => path && !path.startsWith("data:")));
        this.options.storage?.setItem(this.options.storageKey, JSON.stringify(paths));
      } catch { /* Storage failure does not affect live avatars. */ }
    }, 500);
  }

  /** React development remounts may reuse the store after disposing effects. */
  start(): void {
    this.active = true;
    this.refreshVisible();
  }

  dispose(): void {
    this.active = false;
    this.epoch += 1;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.timer = this.persistTimer = null;
    this.queued.clear();
  }

  clearAll(): void {
    this.dispose();
    const keys = [...this.entries.keys()];
    this.entries.clear();
    this.revisions.clear();
    this.failures.clear();
    try { this.options.storage?.removeItem(this.options.storageKey); } catch { /* optional */ }
    for (const key of keys) this.notify(key);
  }
}
