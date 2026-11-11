import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { VoicePresenceStore } from "../data/VoicePresenceStore";
import type { LivekitVoiceSnapshot, VoiceMembershipSnapshot } from "../types/matrix";
import { useUserAvatarStore } from "./UserAvatarStore";

const Context = createContext<VoicePresenceStore | null>(null);

export function VoicePresenceProvider({ children }: { children: ReactNode }) {
  const avatars = useUserAvatarStore();
  const [store] = useState(() => new VoicePresenceStore({
    loadMatrix: (roomIds) => invoke<VoiceMembershipSnapshot>("get_all_voice_participants", { roomIds: roomIds ?? null }),
    loadLivekit: (roomIds) => invoke<LivekitVoiceSnapshot>("get_all_livekit_voice_snapshots", { roomIds }),
    onParticipants: (participants) => avatars.primeMany(participants),
  }));

  useEffect(() => {
    let cancelled = false;
    const unlisteners: (() => void)[] = [];
    void Promise.allSettled([
      listen<{ roomIds: string[] }>("voice-participants-invalidated", ({ payload }) => {
        if (cancelled) return;
        store.invalidateMatrix(payload.roomIds);
        store.invalidateLivekit(payload.roomIds);
      }),
      listen("sync-ready", () => { if (!cancelled) store.invalidateMatrix(); }),
      listen("rooms-changed", () => { if (!cancelled) store.invalidateMatrix(); }),
      listen<{ connectedRoomId: string | null; isConnecting: boolean; error: string | null }>("voice-state-changed", ({ payload }) => {
        if (!cancelled) store.setConnectedRoom(!payload.isConnecting && !payload.error ? payload.connectedRoomId : null);
      }),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === "fulfilled") {
          if (cancelled) result.value(); else unlisteners.push(result.value);
        } else console.error("Failed to subscribe to voice presence:", result.reason);
      }
      if (!cancelled) store.start();
    });
    return () => { cancelled = true; unlisteners.forEach((off) => off()); store.dispose(); };
  }, [store]);

  return <Context.Provider value={store}>{children}</Context.Provider>;
}

export function useVoicePresence() {
  const store = useContext(Context);
  if (!store) throw new Error("Voice presence requires VoicePresenceProvider");
  return [useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot), store] as const;
}
