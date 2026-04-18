/**
 * Persisted snapshot of `get_space_info` per space so space home loads instantly
 * after restart; background refresh still updates from the server.
 *
 * NOTE: `avatarUrl` is intentionally stripped before persisting. Avatar URLs
 * are either filesystem paths into the Tauri temp dir (wiped on every app
 * launch) or `asset://` URLs that reference the same. Persisting them
 * across restarts only produces broken images; consumers should resolve
 * avatars via the in-memory cache / `<UserAvatar>` / backend fetch instead.
 */

const STORAGE_KEY = "pax_space_home_cache_v2";
const LEGACY_STORAGE_KEY_V1 = "pax_space_home_cache_v1";

export interface SpaceChildInfo {
  id: string;
  name: string;
  topic: string | null;
  avatarUrl: string | null;
  membership: string;
  joinRule: string | null;
  roomType: string | null;
  numJoinedMembers: number;
  isDirect?: boolean;
  dmPeerUserId?: string | null;
  dmPeerPresence?: string | null;
  dmPeerStatusMsg?: string | null;
}

export interface SpaceInfo {
  name: string;
  topic: string | null;
  avatarUrl: string | null;
  children: SpaceChildInfo[];
}

function loadFromStorage(): Map<string, SpaceInfo> {
  const map = new Map<string, SpaceInfo>();
  // Discard any leftover v1 entries — they stored filesystem paths that
  // point at now-deleted temp files.
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY_V1);
  } catch {
    /* ignore */
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return map;
    const obj = JSON.parse(raw) as Record<string, SpaceInfo>;
    if (!obj || typeof obj !== "object") return map;
    for (const [id, info] of Object.entries(obj)) {
      if (info && typeof info === "object" && Array.isArray(info.children)) {
        map.set(id, info);
      }
    }
  } catch {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
  return map;
}

/** Strip avatar URLs (temp filesystem paths) before persisting — see header comment. */
function stripForPersistence(info: SpaceInfo): SpaceInfo {
  return {
    ...info,
    avatarUrl: null,
    children: info.children.map((c) => ({ ...c, avatarUrl: null })),
  };
}

function saveToStorage(map: Map<string, SpaceInfo>) {
  try {
    const obj: Record<string, SpaceInfo> = {};
    for (const [id, info] of map) obj[id] = stripForPersistence(info);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch (e) {
    console.warn("Failed to persist space home cache:", e);
  }
}

const spaceHomeInfoCache = loadFromStorage();

export function getCachedSpaceInfo(spaceId: string): SpaceInfo | undefined {
  return spaceHomeInfoCache.get(spaceId);
}

export function setCachedSpaceInfo(spaceId: string, info: SpaceInfo) {
  // Keep the full (with avatars) copy in memory for same-session reuse,
  // but only persist the stripped form.
  spaceHomeInfoCache.set(spaceId, info);
  saveToStorage(spaceHomeInfoCache);
}

/** Call on sign-out so the next account does not see stale space snapshots. */
export function clearPersistedSpaceHomeCache() {
  spaceHomeInfoCache.clear();
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY_V1);
  } catch {
    /* ignore */
  }
}
