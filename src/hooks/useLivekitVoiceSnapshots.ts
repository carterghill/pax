import { useEffect, useMemo } from "react";
import { useVoicePresence } from "../context/VoicePresenceContext";

/** Declare which sidebar/lobby rooms need remote activity snapshots. Overlapping
 * consumers share one batch and polling starts after the preceding read ends. */
export function useLivekitVoiceSnapshots(roomIds: string[], connectedRoomId: string | null, userId: string) {
  const [snapshot, store] = useVoicePresence();
  const key = [...new Set(roomIds)].sort().join("\0");
  useEffect(() => store.watchLivekit(key ? key.split("\0") : []), [store, key]);
  // Keep checking our own calls when the user navigates away from their space.
  const { participantsByRoom } = snapshot;
  const ownRooms = useMemo(() => Object.keys(participantsByRoom)
    .filter((id) => participantsByRoom[id].some((p) => p.userId === userId))
    .sort().join("\0"), [participantsByRoom, userId]);
  useEffect(() => store.watchLivekit(ownRooms ? ownRooms.split("\0") : []), [store, ownRooms]);
  useEffect(() => {
    store.setConnectedRoom(connectedRoomId);
    return () => store.setConnectedRoom(null);
  }, [store, connectedRoomId]);
  return snapshot;
}
