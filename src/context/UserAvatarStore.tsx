import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { normalizeUserId } from "../utils/matrix";

/**
 * Global, user-id-keyed avatar cache.
 *
 * Single source of truth for "the currently-known avatar for user X".
 * Backed by the Rust `avatar_cache` (MXC → temp file) so bytes are
 * downloaded exactly once; this store only tracks which file path to
 * render for a given user.
 *
 * Population paths:
 *   - `<UserAvatar userId=… />` calls `requestFetch` on miss → batched
 *     `get_user_avatars` round-trip.
 *   - Every command response that already carries `(userId, avatarUrl)`
 *     — messages, room members, DM peer summary, voice participants, …
 *     — should call `primeMany` so we never have to re-fetch.
 *   - Sync handlers in Rust emit `user-avatar-invalidated` when a
 *     user's avatar MXC changes anywhere in our joined rooms, and
 *     `member-avatar-updated` for legacy per-room events with resolved
 *     paths.
 *
 * Subscription model:
 *   - Each `<UserAvatar>` subscribes ONLY to the slot for its own user
 *     id (see `useUserAvatar`). Writing one entry notifies exactly the
 *     consumers for that id — no cascading renders across the tree.
 */

type AvatarUrl = string | null;

const PENDING_DEBOUNCE_MS = 16;
const MAX_BATCH = 64;

class UserAvatarStore {
  /** Known entries. `undefined` from `lookup` = unknown; `null` = "no avatar". */
  private entries = new Map<string, AvatarUrl>();
  /** Per-user listener set for surgical subscriptions. */
  private listeners = new Map<string, Set<() => void>>();

  // Batched-fetch bookkeeping.
  private queued = new Set<string>();
  private inflight = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  lookup(userId: string): AvatarUrl | undefined {
    const key = normalizeUserId(userId);
    if (!key) return undefined;
    return this.entries.has(key) ? (this.entries.get(key) as AvatarUrl) : undefined;
  }

  subscribe(userId: string, listener: () => void): () => void {
    const key = normalizeUserId(userId);
    if (!key) return () => {};
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(key);
    };
  }

  private notify(key: string) {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const l of set) l();
  }

  private writeEntry(key: string, url: AvatarUrl): boolean {
    const had = this.entries.has(key);
    const prev = this.entries.get(key);
    if (had && prev === url) return false;
    this.entries.set(key, url);
    this.notify(key);
    return true;
  }

  /**
   * Authoritative single-user write. `null` is a real tombstone — use this
   * for per-user profile responses and avatar-change events where we know
   * the user genuinely has no avatar.
   */
  prime(userId: string, url: AvatarUrl | undefined): void {
    if (url === undefined) return;
    const key = normalizeUserId(userId);
    if (!key) return;
    this.writeEntry(key, url);
  }

  /**
   * Prime from list-type responses (rooms, members, messages). We
   * deliberately skip `null` here because list responses frequently
   * return null for avatars the backend hasn't resolved yet — not
   * because the user has no avatar. Writing those nulls would trap
   * the entry in a false "no avatar" state and block every future
   * fetch attempt (this was the v1 bug).
   */
  primeMany(
    entries: Iterable<{ userId?: string | null; avatarUrl?: string | null }>,
  ): void {
    for (const e of entries) {
      if (!e.userId) continue;
      if (!e.avatarUrl) continue;
      const key = normalizeUserId(e.userId);
      if (!key) continue;
      this.writeEntry(key, e.avatarUrl);
    }
  }

  /** Drop the entry so the next subscriber re-fetches. */
  invalidate(userId: string): void {
    const key = normalizeUserId(userId);
    if (!key) return;
    if (!this.entries.delete(key)) return;
    this.notify(key);
  }

  clearAll(): void {
    if (this.entries.size === 0) return;
    const keys = [...this.entries.keys()];
    this.entries.clear();
    for (const k of keys) this.notify(k);
  }

  requestFetch(userIds: Iterable<string>): void {
    let added = false;
    for (const raw of userIds) {
      const key = normalizeUserId(raw);
      if (!key) continue;
      if (this.inflight.has(key)) continue;
      if (this.queued.has(key)) continue;
      if (this.entries.has(key)) continue;
      this.queued.add(key);
      added = true;
    }
    if (added && this.flushTimer == null) {
      this.flushTimer = setTimeout(() => void this.flush(), PENDING_DEBOUNCE_MS);
    }
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (this.queued.size === 0) return;
    const batch = [...this.queued].slice(0, MAX_BATCH);
    for (const id of batch) {
      this.queued.delete(id);
      this.inflight.add(id);
    }
    try {
      const res = await invoke<Record<string, string | null>>("get_user_avatars", {
        userIds: batch,
      });
      for (const id of batch) {
        const url = res[id] ?? null;
        this.writeEntry(id, url);
      }
    } catch (e) {
      console.warn("[userAvatarStore] get_user_avatars failed:", e);
      // Record null so we stop infinitely retrying. A real `invalidate`
      // (onError from <img>, or `user-avatar-invalidated` event) will
      // clear the entry and allow a fresh fetch.
      for (const id of batch) {
        if (!this.entries.has(id)) this.writeEntry(id, null);
      }
    } finally {
      for (const id of batch) this.inflight.delete(id);
      if (this.queued.size > 0) {
        this.flushTimer = setTimeout(() => void this.flush(), 0);
      }
    }
  }
}

const UserAvatarStoreContext = createContext<UserAvatarStore | null>(null);

export function UserAvatarStoreProvider({ children }: { children: ReactNode }) {
  // One instance per provider. Identity is stable — subscribers live on
  // the store, not on the context value, so no tree-wide re-renders.
  const [store] = useState(() => new UserAvatarStore());

  useEffect(() => {
    const unA = listen<{ userId: string }>("user-avatar-invalidated", (ev) => {
      const { userId } = ev.payload;
      if (userId) store.invalidate(userId);
    });
    const unB = listen<{ userId: string; avatarUrl: string }>(
      "member-avatar-updated",
      (ev) => {
        const { userId, avatarUrl } = ev.payload;
        if (userId && avatarUrl) store.prime(userId, avatarUrl);
      },
    );
    return () => {
      void unA.then((fn) => fn());
      void unB.then((fn) => fn());
    };
  }, [store]);

  return (
    <UserAvatarStoreContext.Provider value={store}>
      {children}
    </UserAvatarStoreContext.Provider>
  );
}

export function useUserAvatarStore(): UserAvatarStore {
  const ctx = useContext(UserAvatarStoreContext);
  if (!ctx) {
    throw new Error("useUserAvatarStore requires UserAvatarStoreProvider");
  }
  return ctx;
}

export function useUserAvatarStoreOptional(): UserAvatarStore | null {
  return useContext(UserAvatarStoreContext);
}

/**
 * Subscribe to a single user's avatar slot. Returns `undefined` while the
 * store is resolving, `null` for "no avatar", or a URL/path.
 *
 * Only this user's entry triggers a re-render; updates to other users are
 * invisible to callers of this hook.
 */
export function useUserAvatar(userId: string): AvatarUrl | undefined {
  const store = useUserAvatarStore();
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(userId, listener),
    [store, userId],
  );
  const getSnapshot = useCallback(() => store.lookup(userId), [store, userId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export type { UserAvatarStore };
