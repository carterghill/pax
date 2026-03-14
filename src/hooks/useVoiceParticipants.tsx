import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { VoiceParticipant } from "../types/matrix";

type ParticipantMap = Record<string, VoiceParticipant[]>;

const RETRY_DELAY_MS = 2000;

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
      return result.length;
    } catch (e) {
      console.error(`Failed to fetch voice participants for ${roomId}:`, e);
      return 0;
    }
  }, []);

  const fetchAll = useCallback(async () => {
    const roomIds = roomIdsRef.current;
    if (roomIds.length === 0) return;

    for (const roomId of roomIds) {
      await fetchForRoom(roomId);
    }
  }, [fetchForRoom]);

  // Initial fetch when voice room IDs change (e.g. user navigates into a space).
  // Also schedule a single retry after RETRY_DELAY_MS to cover the sync timing gap:
  // room state may not be hydrated yet on first space entry.
  useEffect(() => {
    fetchAll();

    const timer = setTimeout(() => {
      fetchAll();
    }, RETRY_DELAY_MS);

    // Clean up stale room entries
    setParticipants((prev) => {
      const next: ParticipantMap = {};
      for (const id of voiceRoomIds) {
        if (prev[id]) next[id] = prev[id];
      }
      return next;
    });

    return () => clearTimeout(timer);
  }, [voiceRoomIds.join(","), fetchAll]);

  // Re-fetch all voice rooms on every sync cycle (voice-participants-changed)
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