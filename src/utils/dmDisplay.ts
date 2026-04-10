import type { Room } from "../types/matrix";
import { isPendingDmRoomId } from "./matrix";

/** Matches Rust `get_rooms` fallback when the room has no canonical name yet. */
export const DM_ROOM_UNNAMED = "Unnamed";

type DmTitled = { name: string; dmPeerUserId?: string | null };

/** Whether the main chat chrome should use DM layout (banner, peer avatar, no member list). */
export function isDmChatUi(room: Room): boolean {
  if (isPendingDmRoomId(room.id)) return true;
  return room.isDirect === true;
}

/** Title for DM header and lists — never show a bare "Unnamed" when we know the peer. */
export function effectiveDmTitle(room: DmTitled): string {
  const raw = room.name?.trim() ?? "";
  if (raw && raw !== DM_ROOM_UNNAMED) return room.name;
  if (room.dmPeerUserId) return room.dmPeerUserId;
  return room.name || "";
}

export function dmInitialsFromLabel(label: string): string {
  const t = label.trim();
  if (!t) return "?";
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.slice(0, 2).toUpperCase();
  }
  return t.slice(0, 2).toUpperCase();
}

/** Presence badge color for DM rows (matches member list / space home). */
export function dmPresenceDotColor(p: string | undefined): string {
  switch (p) {
    case "online":
      return "#23a55a";
    case "unavailable":
      return "#f0b232";
    case "dnd":
      return "#f23f43";
    default:
      return "#80848e";
  }
}
