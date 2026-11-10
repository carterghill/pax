import { useRoomMemberLabelResolver } from "../context/RoomMemberStore";

/** Presence updates keep the same label resolver and do not rerender this consumer. */
export function useResolveMemberLabel(roomId: string) {
  const resolveMemberLabel = useRoomMemberLabelResolver(roomId);
  return { resolveMemberLabel };
}
