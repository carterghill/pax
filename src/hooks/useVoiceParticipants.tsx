import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { VoiceParticipant } from "../types/matrix";

type ParticipantMap = Record<string, VoiceParticipant[]>;
interface VoiceParticipantsChangedPayload {
  participantsByRoom: ParticipantMap;
}

export function useVoiceParticipants(voiceRoomIds: string[]) {
  // Full map of ALL voice rooms across ALL spaces, keyed by room ID.
  // Never filtered down -- space switching just projects from this.
  const [allParticipants, setAllParticipants] = useState<ParticipantMap>({});
  const mountedRef = useRef(true);
  const fetchingRef = useRef(false);

  // Initial snapshot -- mirrors how useRooms does invoke("get_rooms") on mount.
  useEffect(() => {
    mountedRef.current = true;
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    invoke<ParticipantMap>("get_all_voice_participants")
      .then((data) => {
        if (mountedRef.current) setAllParticipants(data);
      })
      .catch((e) => console.error("Failed to fetch voice participants:", e))
      .finally(() => {
        fetchingRef.current = false;
      });

    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Ongoing updates pushed from Rust on each sync response.
  useEffect(() => {
    const unlisten = listen<VoiceParticipantsChangedPayload>(
      "voice-participants-changed",
      (event) => {
        const incoming = event.payload?.participantsByRoom;
        if (incoming) setAllParticipants(incoming);
      }
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Derive the filtered view for only the current space's voice rooms.
  // Switching spaces just re-projects from the full map -- no fetch needed.
  const filtered = useMemo(() => {
    const result: ParticipantMap = {};
    for (const id of voiceRoomIds) {
      result[id] = allParticipants[id] ?? [];
    }
    return result;
  }, [voiceRoomIds, allParticipants]);

  return filtered;
}
