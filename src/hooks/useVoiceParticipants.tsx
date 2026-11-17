import { useMemo } from "react";
import type { VoiceParticipant } from "../types/matrix";
import { useVoicePresence } from "../context/VoicePresenceContext";

type ParticipantMap = Record<string, VoiceParticipant[]>;
export type VoiceParticipantsResult = {
  participantsInScope: ParticipantMap;
  allParticipantsByRoom: ParticipantMap;
};

/** Snapshots are deduplicated/sorted once by the shared session store. */
export function useVoiceParticipants(voiceRoomIds: string[]): VoiceParticipantsResult {
  const [{ participantsByRoom }] = useVoicePresence();
  const filtered = useMemo(() => Object.fromEntries(
    voiceRoomIds.map((id) => [id, participantsByRoom[id] ?? []]),
  ), [voiceRoomIds, participantsByRoom]);
  return { participantsInScope: filtered, allParticipantsByRoom: participantsByRoom };
}
