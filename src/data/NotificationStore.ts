import { defaultNotificationSettings, defaultUnreadSettings, type NotificationLevel, type NotificationSettings, type UnreadSettings } from "../types/notifications.ts";

export interface NotificationSnapshot {
  notificationSettings: NotificationSettings;
  unreadSettings: UnreadSettings;
  effectiveLevels: Record<string, NotificationLevel>;
  loading: boolean;
  error: string | null;
}

type Resource = "notificationSettings" | "unreadSettings" | "effectiveLevels";
type Values = Pick<NotificationSnapshot, Resource>;
type Loaders = { [K in Resource]: () => Promise<Values[K]> };
const resources: Resource[] = ["notificationSettings", "unreadSettings", "effectiveLevels"];

/** One session owns preferences and the backend's resolved levels. Revisions
 * prevent an initial fetch from overwriting an event received during it. */
export class NotificationStore {
  private snapshot: NotificationSnapshot = {
    notificationSettings: defaultNotificationSettings, unreadSettings: defaultUnreadSettings,
    effectiveLevels: {}, loading: true, error: null,
  };
  private listeners = new Set<() => void>();
  private dirty = new Set<Resource>(resources);
  private revisions: Record<Resource, number> = { notificationSettings: 0, unreadSettings: 0, effectiveLevels: 0 };
  private active = false;
  private epoch = 0;
  private flight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = 1000;
  private load: Loaders;
  private resolve: (roomId: string) => Promise<NotificationLevel>;

  constructor(load: Loaders, resolve: (roomId: string) => Promise<NotificationLevel>) {
    this.load = load;
    this.resolve = resolve;
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<NotificationSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }

  start() { this.active = true; this.queue(); }
  dispose() {
    this.active = false;
    this.epoch++;
    this.flight = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  replace<K extends Resource>(key: K, value: Values[K]) {
    this.revisions[key]++;
    this.dirty.delete(key);
    this.publish({ [key]: value });
    if (key === "notificationSettings") this.invalidate("effectiveLevels");
  }

  invalidate(...keys: Resource[]) {
    for (const key of keys.length ? keys : resources) {
      this.revisions[key]++;
      this.dirty.add(key);
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.retryMs = 1000;
    this.queue();
  }

  async getLevel(roomId: string): Promise<NotificationLevel> {
    if (!this.active) throw new Error("Notification session ended");
    const cached = this.snapshot.effectiveLevels[roomId];
    if (!this.dirty.has("effectiveLevels") && cached !== undefined) return cached;
    // During invalidation, ask the same backend snapshot rather than using a
    // second TTL cache. The backend combines concurrent snapshot loads.
    const epoch = this.epoch;
    const revision = this.revisions.effectiveLevels;
    try {
      const level = await this.resolve(roomId);
      if (epoch !== this.epoch) throw new Error("Notification session ended");
      if (revision !== this.revisions.effectiveLevels) return this.getLevel(roomId);
      return level;
    } catch (error) {
      if (epoch === this.epoch && cached !== undefined) return cached;
      throw error;
    }
  }

  private queue(delay = 0) {
    if (!this.active || this.flight || this.timer !== null || !this.dirty.size) return;
    this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, delay);
  }

  private async refresh() {
    const epoch = this.epoch;
    const keys = [...this.dirty];
    const revisions = { ...this.revisions };
    this.flight = true;
    const results = await Promise.allSettled(keys.map(async (key) => await this.load[key]()));
    if (epoch !== this.epoch) return;
    const update: Partial<NotificationSnapshot> = { loading: false, error: null };
    let failed = false;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (this.revisions[key] !== revisions[key]) continue;
      const result = results[i];
      if (result.status === "fulfilled") {
        // Each result is indexed by the same key used to call its loader.
        Object.assign(update, { [key]: result.value });
        this.dirty.delete(key);
      } else {
        failed = true;
        update.error = String(result.reason);
      }
    }
    this.flight = false;
    this.publish(update);
    const delay = failed ? this.retryMs : 0;
    this.retryMs = failed ? Math.min(this.retryMs * 2, 30_000) : 1000;
    this.queue(delay);
  }
}
