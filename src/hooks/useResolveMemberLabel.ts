import { useCallback, useMemo } from "react";
import { useRoomMembers } from "./useRoomMembers";

export function useResolveMemberLabel(roomId: string) {
  const { members } = useRoomMembers(roomId);

  const memberLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const mem of members) {
      const label = (mem.displayName?.trim() || mem.userId).trim();
      m.set(mem.userId.trim().toLowerCase(), label);
    }
    return m;
  }, [members]);

  const resolveMemberLabel = useCallback(
    (uid: string) => {
      const hit = memberLabelById.get(uid.trim().toLowerCase());
      if (hit) return hit;
      return uid;
    },
    [memberLabelById],
  );

  return { members, resolveMemberLabel };
}
