import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { VoiceParticipant } from "../types/matrix";

type ParticipantMap = Record<string, VoiceParticipant[]>;

export function useVoiceParticipants(voiceRoomIds: string[]) {
  const [participants, setParticipants] = useState<ParticipantMap>({});
  const roomIdsRef = useRef<string[]>(voiceRoomIds);

  // Keep ref in sync so event listeners see the latest room IDs
  useEffect(() => {
    roomIdsRef.current = voiceRoomIds;
  }, [voiceRoomIds]);

  const fetchForRoom = useCallback(async (roomId: string) => {
    try {
      const result = await invoke<VoiceParticipant[]>("get_voice_participants", { roomId });
      setParticipants((prev) => {
        // Only update if actually changed to avoid unnecessary renders
        const existing = prev[roomId] ?? [];
        const changed =
          existing.length !== result.length ||
          existing.some((p, i) => p.userId !== result[i]?.userId);
        if (!changed) return prev;
        return { ...prev, [roomId]: result };
      });
    } catch (e) {
      console.error(`Failed to fetch voice participants for ${roomId}:`, e);
    }
  }, []);

  const fetchAll = useCallback(() => {
    for (const roomId of roomIdsRef.current) {
      fetchForRoom(roomId);
    }
  }, [fetchForRoom]);

  // Initial fetch when voice room IDs change
  useEffect(() => {
    fetchAll();

    // Clean up stale room entries
    setParticipants((prev) => {
      const next: ParticipantMap = {};
      for (const id of voiceRoomIds) {
        if (prev[id]) next[id] = prev[id];
      }
      return next;
    });
  }, [voiceRoomIds.join(","), fetchAll]);

  // Re-fetch all voice rooms on every sync cycle
  // The dedup in fetchForRoom prevents unnecessary re-renders
  useEffect(() => {
    const unlisten = listen("voice-participants-changed", () => {
      fetchAll();
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [fetchAll]);

  return participants;
}