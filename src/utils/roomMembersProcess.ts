import type { RoomMember } from "../types/matrix";

/** Same buckets as UserMenu (online includes dnd). */
export type MemberPresenceCounts = {
  online: number;
  unavailable: number;
  offline: number;
};

export function dedupeMembersByUserId(members: RoomMember[]): RoomMember[] {
  const byId = new Map<string, RoomMember>();
  for (const m of members) {
    byId.set(m.userId, m);
  }
  return [...byId.values()];
}

export function countPresenceForGroups(members: RoomMember[]): MemberPresenceCounts {
  let online = 0;
  let unavailable = 0;
  let offline = 0;
  for (const m of members) {
    if (m.presence === "online" || m.presence === "dnd") online++;
    else if (m.presence === "unavailable") unavailable++;
    else offline++;
  }
  return { online, unavailable, offline };
}

export function sortMembersForDisplay(members: RoomMember[]): RoomMember[] {
  return [...members].sort((a, b) => {
    const order: Record<string, number> = { online: 0, unavailable: 1, offline: 2 };

    const aOrder = order[a.presence] ?? 2;
    const bOrder = order[b.presence] ?? 2;

    if (aOrder !== bOrder) return aOrder - bOrder;

    const aName = (a.displayName ?? a.userId).toLowerCase();
    const bName = (b.displayName ?? b.userId).toLowerCase();

    return aName.localeCompare(bName);
  });
}

/** Dedupe, sort, and compute presence counts — pure CPU work suitable for a worker. */
export function processRoomMembersRaw(members: RoomMember[]): {
  members: RoomMember[];
  presenceCounts: MemberPresenceCounts;
  totalJoinedCount: number;
} {
  const deduped = dedupeMembersByUserId(members);
  const sorted = sortMembersForDisplay(deduped);
  const presenceCounts = countPresenceForGroups(deduped);
  return {
    members: sorted,
    presenceCounts,
    totalJoinedCount: deduped.length,
  };
}
