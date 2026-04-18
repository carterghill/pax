import type { Room } from "../types/matrix";

const STORAGE_KEY = "pax_rooms_list_v2";
const LEGACY_STORAGE_KEY_V1 = "pax_rooms_list_v1";

type PersistedPayload = {
  userId: string;
  rooms: Room[];
};

function isRoom(x: unknown): x is Room {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.isSpace === "boolean" &&
    Array.isArray(r.parentSpaceIds) &&
    typeof r.membership === "string"
  );
}

/** Avatar URLs are filesystem paths into the Tauri temp dir, which is
 *  wiped on every app launch; persisting them across restarts only yields
 *  broken-image icons. Consumers should resolve avatars at runtime via
 *  `<UserAvatar>` / the backend cache. */
function stripForPersistence(rooms: Room[]): Room[] {
  return rooms.map((r) => ({ ...r, avatarUrl: null }));
}

/** Last successful `get_rooms` for this Matrix user — instant sidebar after restart. */
export function loadPersistedRooms(userId: string): Room[] | null {
  // Discard v1 entries — they persisted now-deleted temp-file paths.
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY_V1);
  } catch {
    /* ignore */
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedPayload;
    if (!parsed || parsed.userId !== userId || !Array.isArray(parsed.rooms)) {
      return null;
    }
    if (!parsed.rooms.every(isRoom)) return null;
    return parsed.rooms;
  } catch {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function savePersistedRooms(userId: string, rooms: Room[]) {
  try {
    const payload: PersistedPayload = {
      userId,
      rooms: stripForPersistence(rooms),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("Failed to persist rooms list:", e);
  }
}

export function clearPersistedRoomsList() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY_V1);
  } catch {
    /* ignore */
  }
}
