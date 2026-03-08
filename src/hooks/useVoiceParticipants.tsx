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

  // Listen for targeted voice-participants-changed events (from sync detecting call member state changes)
  useEffect(() => {
    const unlisten = listen<string>("voice-participants-changed", (event) => {
      const changedRoomId = event.payload;
      if (roomIdsRef.current.includes(changedRoomId)) {
        fetchForRoom(changedRoomId);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [fetchForRoom]);

  // Also re-fetch on rooms-changed as a fallback (debounced)
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const unlisten = listen("rooms-changed", () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        fetchAll();
      }, 3000);
    });

    return () => {
      unlisten.then((fn) => fn());
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [fetchAll]);

  return participants;
}