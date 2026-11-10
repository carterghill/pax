import { useRoomMemberSnapshot } from "../context/RoomMemberStore";

/** Subscribe to the session's shared member resource for this room. */
export function useRoomMembers(roomId: string) {
  return useRoomMemberSnapshot(roomId);
}
