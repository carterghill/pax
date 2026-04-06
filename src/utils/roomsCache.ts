import type { Room } from "../types/matrix";

const STORAGE_KEY = "pax_rooms_list_v1";

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

/** Last successful `get_rooms` for this Matrix user — instant sidebar after restart. */
export function loadPersistedRooms(userId: string): Room[] | null {
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
    const payload: PersistedPayload = { userId, rooms };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("Failed to persist rooms list:", e);
  }
}

export function clearPersistedRoomsList() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
