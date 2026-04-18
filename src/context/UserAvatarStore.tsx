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
import { avatarSrc } from "../utils/avatarSrc";

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
 *   - On construction, the store hydrates its entries from
 *     `localStorage` (scoped by the logged-in user id). Combined with
 *     the persistent Rust avatar cache, this means every sidebar row
 *     renders with the real avatar on first paint after a warm
 *     restart — no flash of initials while `get_rooms` round-trips.
 *
 * Subscription model:
 *   - Each `<UserAvatar>` subscribes ONLY to the slot for its own user
 *     id (see `useUserAvatar`). Writing one entry notifies exactly the
 *     consumers for that id — no cascading renders across the tree.
 */

type AvatarUrl = string | null;

const PENDING_DEBOUNCE_MS = 16;
const MAX_BATCH = 64;

/**
 * How long we wait after a write before flushing `entries` to
 * `localStorage`. Coalesces burst writes (e.g. the initial
 * `primeDmPeerAvatars` call after `get_rooms` resolves) into one
 * serialise + store round-trip.
 */
const PERSIST_DEBOUNCE_MS = 500;

/**
 * Single localStorage key. We deliberately don't scope by user id:
 * the Rust `avatar_cache.clear()` call on login/logout already wipes
 * the on-disk files, and the `<img onError>` path invalidates any
 * surviving stale entries client-side, so sharing the in-memory keys
 * across accounts on the same machine is both safe and simpler.
 */
const STORAGE_KEY = "pax_user_avatars_v2";
/** Legacy scoped key (v1) — read on first load of v2 then discarded. */
const LEGACY_STORAGE_PREFIX = "pax_user_avatars_v1:";

class UserAvatarStore {
  /** Known entries. `undefined` from `lookup` = unknown; `null` = "no avatar". */
  private entries = new Map<string, AvatarUrl>();
  /** Per-user listener set for surgical subscriptions. */
  private listeners = new Map<string, Set<() => void>>();

  // Batched-fetch bookkeeping.
  private queued = new Set<string>();
  private inflight = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Debounced persistence timer handle. `null` = no flush pending.
   */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.hydrateFromStorage();
  }

  /**
   * Read previously-persisted entries synchronously during construction
   * so the very first render of every `<UserAvatar>` sees the resolved
   * path instead of falling through to initials. The Rust side writes
   * the same paths into `{app_cache_dir}/avatars/index.json` — the
   * filesystem file survives across restarts, so these paths resolve
   * instantly without any round-trip.
   *
   * Stale entries (path no longer on disk) are handled by the existing
   * `<img onError>` path: it calls `invalidate(userId)`, which drops
   * the entry and triggers a fresh `requestFetch` on the next render.
   */
  private hydrateFromStorage(): void {
    // One-time migration from v1 (per-user scoped) keys. If there's
    // no v2 entry but there's exactly one v1 entry, adopt it.
    try {
      if (localStorage.getItem(STORAGE_KEY) == null) {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k || !k.startsWith(LEGACY_STORAGE_PREFIX)) continue;
          const legacy = localStorage.getItem(k);
          if (legacy) {
            localStorage.setItem(STORAGE_KEY, legacy);
          }
          localStorage.removeItem(k);
          // Loop index now invalid — just restart; v2 is set.
          break;
        }
      }
    } catch {
      /* ignore — migration is best-effort */
    }

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return;
      }
      let count = 0;
      for (const [key, value] of Object.entries(parsed)) {
        // Keys must look like normalized user ids; values must be
        // strings (paths) or null. Anything else is either old-format
        // garbage or a tampered payload and gets dropped silently.
        if (typeof key !== "string" || !key) continue;
        if (value !== null && typeof value !== "string") continue;
        this.entries.set(key, value as AvatarUrl);
        // Fire-and-forget image preload — by the time React
        // renders the sidebar the fetches have already landed
        // in the browser's image cache, so the `<img>` paints
        // in the same frame it mounts instead of flashing
        // through a blank-box state that reads as initials.
        this.preload(value as AvatarUrl);
        count += 1;
      }
    } catch {
      // Corrupted blob — drop it so next boot starts clean.
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer != null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  private persistNow(): void {
    try {
      const obj: Record<string, AvatarUrl> = {};
      for (const [k, v] of this.entries.entries()) {
        obj[k] = v;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch (e) {
      // Quota errors, etc. — not fatal; cache just won't survive restart.
      // eslint-disable-next-line no-console
      console.warn("[userAvatarStore] persist failed:", e);
    }
  }

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

  /**
   * Kick the browser into fetching + decoding an avatar image
   * off-render, so by the time a `<UserAvatar>` actually mounts with
   * this src the pixels are already in the image cache and the `<img>`
   * paints synchronously on first layout.
   *
   * Without this, even with the store fully hydrated and `showImage`
   * true from the first render, there's a fetch-then-paint gap
   * (Tauri asset protocol round-trip + PNG decode) during which the
   * `<img>` box is empty. The container's `backgroundColor` +
   * centered bold text styling make that empty box look visually
   * identical to the initials fallback — a "flash of initials" that
   * isn't actually an initials render at all. Priming the image
   * cache eliminates the gap.
   */
  private preload(url: AvatarUrl): void {
    if (!url || typeof url !== "string") return;
    if (typeof window === "undefined") return; // SSR-safe guard
    try {
      const src = avatarSrc(url);
      if (!src) return;
      // `new Image()` triggers a fetch immediately. The element is
      // never inserted into the DOM — once the bytes arrive the
      // browser caches the decoded pixels and discards the
      // ephemeral node.
      const img = new Image();
      img.decoding = "async";
      img.src = src;
    } catch {
      /* ignore — preload is best-effort */
    }
  }

  private writeEntry(key: string, url: AvatarUrl): boolean {
    const had = this.entries.has(key);
    const prev = this.entries.get(key);
    if (had && prev === url) return false;
    this.entries.set(key, url);
    // Prime the browser's image cache for this path so the eventual
    // `<img>` mount paints without a fetch-then-paint flash.
    this.preload(url);
    this.notify(key);
    this.schedulePersist();
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
    this.schedulePersist();
  }

  clearAll(): void {
    // Wipe any pending persist — we're about to clear everything,
    // don't want a half-in-flight flush racing with localStorage.removeItem.
    if (this.persistTimer != null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const hadEntries = this.entries.size > 0;
    if (hadEntries) {
      const keys = [...this.entries.keys()];
      this.entries.clear();
      for (const k of keys) this.notify(k);
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
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
        // Crucial: do NOT overwrite entries that were populated from a more
        // authoritative source (message fetch, room list, explicit prime)
        // while our batch was in flight. get_user_avatars hits the profile
        // API and may legitimately return null on timeout / federation hiccup
        // — and clobbering a freshly-primed path back to null traps the
        // avatar on initials forever (no <img> ever renders to fire onError).
        if (this.entries.has(id)) continue;
        const url = res[id] ?? null;
        this.writeEntry(id, url);
      }
    } catch (e) {
      console.warn("[userAvatarStore] get_user_avatars failed:", e);
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

export function UserAvatarStoreProvider({
  children,
}: {
  children: ReactNode;
}) {
  // One instance per provider. Identity is stable across re-renders —
  // subscribers live on the store, not on the context value, so no
  // tree-wide re-renders. The initializer reads `localStorage`
  // SYNCHRONOUSLY, so the first render of every `<UserAvatar>` below
  // already sees the hydrated entries.
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