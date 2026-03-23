import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LivekitVoiceParticipantInfo } from "../types/matrix";

const POLL_MS = 5_000;

/**
 * Polls LiveKit Room Service for mute/deafen/speaking per Matrix voice room.
 * Returns empty maps when admin credentials are not configured or the SFU room name cannot be matched.
 */
export function useLivekitVoiceSnapshots(roomIds: string[]) {
  const [byRoom, setByRoom] = useState<Record<string, LivekitVoiceParticipantInfo[]>>({});
  const key = roomIds.slice().sort().join("\0");

  useEffect(() => {
    if (roomIds.length === 0) {
      setByRoom({});
      return;
    }

    let cancelled = false;

    const run = async () => {
      const entries: [string, LivekitVoiceParticipantInfo[]][] = await Promise.all(
        roomIds.map(async (roomId): Promise<[string, LivekitVoiceParticipantInfo[]]> => {
          try {
            const list = await invoke<LivekitVoiceParticipantInfo[]>(
              "get_livekit_voice_room_snapshot",
              { roomId }
            );
            return [roomId, list];
          } catch {
            return [roomId, []];
          }
        })
      );
      if (cancelled) return;
      const next: Record<string, LivekitVoiceParticipantInfo[]> = {};
      for (const [id, list] of entries) {
        next[id] = list;
      }
      setByRoom(next);
    };

    void run();
    const id = window.setInterval(() => void run(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [key]);

  return byRoom;
}