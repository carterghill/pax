import { useEffect } from "react";
import { useVoicePresence } from "../context/VoicePresenceContext";

/** Declare which sidebar/lobby rooms need remote activity snapshots. Overlapping
 * consumers share one batch and polling starts after the preceding read ends. */
export function useLivekitVoiceSnapshots(roomIds: string[]) {
  const [snapshot, store] = useVoicePresence();
  const key = [...new Set(roomIds)].sort().join("\0");
  useEffect(() => store.watchLivekit(key ? key.split("\0") : []), [store, key]);
  return snapshot.livekitByRoom;
}
