import { useEffect, useRef } from "react";
import { extractMatrixUserId } from "../utils/matrix";
import type { VoiceParticipant } from "../types/matrix";
import type { VoicePresenceSnapshot } from "../data/VoicePresenceStore";
import type { VoiceCall } from "./useVoiceCall";

export type VoiceParticipantState = {
  status: "connected" | "connecting" | "interrupted" | "lost" | "unknown";
  isMuted?: boolean | null;
  isDeafened?: boolean | null;
  isSpeaking?: boolean | null;
  identity?: string;
};

export function useVoiceParticipantStates(
  roomIds: string[],
  members: Record<string, VoiceParticipant[]>,
  presence: VoicePresenceSnapshot,
  voice: VoiceCall,
  userId: string,
  recoveryRoomId?: string,
) {
  const seen = useRef(new Map<string, Set<string>>());
  const states: Record<string, Record<string, VoiceParticipantState>> = {};
  const keep = new Map<string, Set<string>>();
  const scoped = new Set(roomIds);
  if (voice.connectedRoomId) scoped.add(voice.connectedRoomId);
  for (const roomId of scoped) {
    const isHere = voice.connectedRoomId === roomId;
    const fresh = isHere || !!presence.livekitFreshByRoom[roomId];
    const media = isHere ? voice.participants : fresh ? presence.livekitByRoom[roomId] ?? [] : [];
    const rows: Record<string, VoiceParticipantState> = {};
    const previous = seen.current.get(roomId);
    const observed = new Set<string>();
    const roster = members[roomId] ?? [];
    const ids = [...new Set([userId, ...roster.map((person) => person.userId)])]
      .sort((left, right) => right.length - left.length);
    for (const participant of media) {
      const identity = participant.identity;
      const id = "isLocal" in participant && participant.isLocal ? userId : ids.find((mxid) =>
        identity === mxid || identity.startsWith(`${mxid}:`) || identity.startsWith(`${mxid}|`),
      ) ?? extractMatrixUserId(identity);
      const interrupted = "connectionInterrupted" in participant && participant.connectionInterrupted;
      if (interrupted && rows[id]?.status === "connected") continue;
      rows[id] = {
        status: interrupted ? "interrupted" : "connected",
        identity,
        isMuted: participant.isMuted,
        isDeafened: participant.isDeafened,
        isSpeaking: participant.isSpeaking,
      };
      observed.add(id);
    }
    for (const member of roster) {
      const id = member.userId;
      if (previous?.has(id)) observed.add(id);
      if (id === userId && voice.targetRoomId === roomId && voice.isConnecting) {
        rows[id] = { status: "connecting" };
      } else if (id === userId && recoveryRoomId === roomId && !isHere) {
        rows[id] = { status: "lost" };
      } else if (!rows[id]) {
        rows[id] = { status: id !== userId && fresh && previous?.has(id) ? "lost" : "unknown" };
      }
    }
    states[roomId] = rows;
    keep.set(roomId, observed);
  }
  useEffect(() => { seen.current = keep; });
  return states;
}
