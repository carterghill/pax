import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RoomMemberStore, type MemberPresenceUpdate, type RoomMemberSnapshot } from "../data/RoomMemberStore";
import type { RoomMember, RoomMembersChangedPayload } from "../types/matrix";
import { useUserAvatarStore } from "./UserAvatarStore";

const RoomMemberStoreContext = createContext<RoomMemberStore | null>(null);

export function RoomMemberStoreProvider({ children }: { children: ReactNode }) {
  const avatars = useUserAvatarStore();
  const [store] = useState(() => new RoomMemberStore({
    load: (roomId) => invoke<RoomMember[]>("get_room_members", { roomId }),
    onMembers: (members) => avatars.primeMany(members),
  }));

  useEffect(() => {
    let cancelled = false;
    let frame: number | null = null;
    const pending = new Map<string, MemberPresenceUpdate>();
    const unlisteners: (() => void)[] = [];
    // Register before loading snapshots so updates during a fetch cannot be missed.
    void Promise.allSettled([
      listen<RoomMembersChangedPayload>("room-members-changed", (event) => {
        if (!cancelled) store.invalidate(event.payload.roomId);
      }),
      listen("sync-ready", () => { if (!cancelled) store.invalidateAll(); }),
      listen<MemberPresenceUpdate>("presence", (event) => {
        if (cancelled) return;
        pending.set(event.payload.userId, event.payload);
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          store.applyPresence(pending.values());
          pending.clear();
        });
      }),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === "fulfilled") {
          if (cancelled) result.value();
          else unlisteners.push(result.value);
        } else console.error("Failed to subscribe to room members:", result.reason);
      }
      if (!cancelled) store.start();
    });
    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
      if (frame !== null) cancelAnimationFrame(frame);
      pending.clear();
      store.dispose();
    };
  }, [store]);

  return <RoomMemberStoreContext.Provider value={store}>{children}</RoomMemberStoreContext.Provider>;
}

function useMemberSelection<T>(roomId: string, select: (snapshot: RoomMemberSnapshot) => T): T {
  const store = useContext(RoomMemberStoreContext);
  if (!store) throw new Error("Room members require RoomMemberStoreProvider");
  const subscribe = useCallback((listener: () => void) => store.subscribe(roomId, listener), [store, roomId]);
  const snapshot = useCallback(() => select(store.getSnapshot(roomId)), [store, roomId, select]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const selectSnapshot = (snapshot: RoomMemberSnapshot) => snapshot;
const selectLabels = (snapshot: RoomMemberSnapshot) => snapshot.resolveMemberLabel;
export function useRoomMemberSnapshot(roomId: string) { return useMemberSelection(roomId, selectSnapshot); }
export function useRoomMemberLabelResolver(roomId: string) { return useMemberSelection(roomId, selectLabels); }
