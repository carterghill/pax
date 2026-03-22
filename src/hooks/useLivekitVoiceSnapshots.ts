import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LivekitVoiceParticipantInfo } from "../types/matrix";

/** Fallback interval — the event-driven triggers handle most refreshes. */
const POLL_MS = 10_000;
/** Minimum gap between fetches to avoid hammering during rapid event bursts. */
const DEBOUNCE_MS = 800;

/**
 * Fetches LiveKit Room Service mute/deafen/speaking for all given voice rooms
 * via a single batched backend call.
 *
 * Refreshes are triggered by:
 *   - Initial mount (as soon as roomIds is non-empty)
 *   - `rooms-changed` events from the sync loop
 *   - `voice-state-changed` events (connect / disconnect / mute changes)
 *   - A fallback interval (every 10s)
 *
 * Polling is required for rooms the user is NOT connected to — LiveKit has no
 * push mechanism for external observers. The event triggers make the UX feel
 * instant for connect/disconnect while the interval catches slow drifts.
 */
export function useLivekitVoiceSnapshots(roomIds: string[]) {
  const [byRoom, setByRoom] = useState<Record<string, LivekitVoiceParticipantInfo[]>>({});
  const key = roomIds.slice().sort().join("\0");
  const lastFetchRef = useRef(0);
  const pendingRef = useRef(false);
  const cancelledRef = useRef(false);
  const roomIdsRef = useRef(roomIds);
  roomIdsRef.current = roomIds;

  useEffect(() => {
    if (roomIds.length === 0) {
      setByRoom({});
      return;
    }

    cancelledRef.current = false;

    const fetch = async () => {
      // Debounce: skip if we fetched very recently
      const now = Date.now();
      if (now - lastFetchRef.current < DEBOUNCE_MS) {
        // Schedule a deferred fetch if one isn't already pending
        if (!pendingRef.current) {
          pendingRef.current = true;
          setTimeout(() => {
            pendingRef.current = false;
            if (!cancelledRef.current) void fetch();
          }, DEBOUNCE_MS);
        }
        return;
      }
      lastFetchRef.current = now;

      try {
        const result = await invoke<Record<string, LivekitVoiceParticipantInfo[]>>(
          "get_all_livekit_voice_snapshots",
          { roomIds: roomIdsRef.current }
        );
        if (!cancelledRef.current) setByRoom(result);
      } catch {
        // Admin credentials missing or other error — keep previous state
      }
    };

    // Initial fetch
    void fetch();

    // Event-driven triggers
    const unlistenRooms = listen("rooms-changed", () => void fetch());
    const unlistenVoice = listen("voice-state-changed", () => void fetch());

    // Fallback interval
    const intervalId = window.setInterval(() => void fetch(), POLL_MS);

    return () => {
      cancelledRef.current = true;
      window.clearInterval(intervalId);
      unlistenRooms.then((fn) => fn());
      unlistenVoice.then((fn) => fn());
    };
  }, [key]);

  return byRoom;
}