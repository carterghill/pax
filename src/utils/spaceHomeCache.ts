/**
 * Persisted snapshot of `get_space_info` per space so space home loads instantly
 * after restart; background refresh still updates from the server.
 */

const STORAGE_KEY = "pax_space_home_cache_v1";

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

function saveToStorage(map: Map<string, SpaceInfo>) {
  try {
    const obj: Record<string, SpaceInfo> = {};
    for (const [id, info] of map) obj[id] = info;
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
  spaceHomeInfoCache.set(spaceId, info);
  saveToStorage(spaceHomeInfoCache);
}

/** Call on sign-out so the next account does not see stale space snapshots. */
export function clearPersistedSpaceHomeCache() {
  spaceHomeInfoCache.clear();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}