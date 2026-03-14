import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { VoiceParticipant } from "../types/matrix";

type ParticipantMap = Record<string, VoiceParticipant[]>;
interface VoiceParticipantsChangedPayload {
  participantsByRoom: ParticipantMap;
}

const sameParticipants = (a: VoiceParticipant[], b: VoiceParticipant[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].userId !== b[i]?.userId ||
      a[i].displayName !== b[i]?.displayName ||
      a[i].avatarUrl !== b[i]?.avatarUrl
    ) {
      return false;
    }
  }
  return true;
};

export function useVoiceParticipants(voiceRoomIds: string[]) {
  const [participants, setParticipants] = useState<ParticipantMap>({});
  const roomIdsRef = useRef<string[]>(voiceRoomIds);

  // Keep ref in sync so event listeners see the latest room IDs
  useEffect(() => {
    roomIdsRef.current = voiceRoomIds;
  }, [voiceRoomIds]);

  // Keep only currently visible voice rooms in local state.
  useEffect(() => {
    setParticipants((prev) => {
      const next: ParticipantMap = {};
      for (const id of voiceRoomIds) {
        next[id] = prev[id] ?? [];
      }
      const unchanged =
        Object.keys(prev).length === Object.keys(next).length &&
        voiceRoomIds.every((id) => sameParticipants(prev[id] ?? [], next[id]));
      return unchanged ? prev : next;
    });
  }, [voiceRoomIds.join(",")]);

  // Rust pushes a full participants map each sync; no frontend polling.
  useEffect(() => {
    const unlisten = listen<VoiceParticipantsChangedPayload>("voice-participants-changed", (event) => {
      const incoming = event.payload?.participantsByRoom ?? {};
      const activeRoomIds = roomIdsRef.current;

      setParticipants((prev) => {
        const next: ParticipantMap = {};
        for (const roomId of activeRoomIds) {
          next[roomId] = incoming[roomId] ?? [];
        }

        const changed =
          Object.keys(prev).length !== Object.keys(next).length ||
          activeRoomIds.some((roomId) => !sameParticipants(prev[roomId] ?? [], next[roomId]));

        return changed ? next : prev;
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return participants;
}