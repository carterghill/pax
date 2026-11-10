import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AvatarStore } from "../data/AvatarStore";
import { avatarSrc } from "../utils/avatarSrc";

const UserAvatarStoreContext = createContext<AvatarStore | null>(null);

export function UserAvatarStoreProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [store] = useState(() => new AvatarStore({
    storage: localStorage,
    storageKey: `pax_avatars_v3:${userId}`,
    preload: (path) => {
      const src = avatarSrc(path);
      if (src) { const img = new Image(); img.decoding = "async"; img.src = src; }
    },
    load: async (ids) => {
      const users = ids.filter((id) => !id.startsWith("!"));
      const rooms = ids.filter((id) => id.startsWith("!"));
      const results = await Promise.allSettled([
        users.length ? invoke<Record<string, string | null>>("get_user_avatars", { userIds: users }) : {},
        rooms.length ? invoke<Record<string, string | null>>("get_room_avatars", { roomIds: rooms }) : {},
      ]);
      return Object.assign({}, ...results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
    },
  }));

  useEffect(() => {
    store.start();
    const unlisten = listen<{ userId: string }>("user-avatar-invalidated", (event) => {
      store.invalidate(event.payload.userId);
    });
    const unRoom = listen<{ roomId: string }>("room-avatar-invalidated", (event) => {
      store.invalidate(event.payload.roomId);
    });
    const unReady = listen("sync-ready", () => store.refreshVisible());
    return () => {
      store.dispose();
      void unlisten.then((fn) => fn());
      void unRoom.then((fn) => fn());
      void unReady.then((fn) => fn());
    };
  }, [store]);

  return <UserAvatarStoreContext.Provider value={store}>{children}</UserAvatarStoreContext.Provider>;
}

export function useUserAvatarStore(): AvatarStore {
  const store = useContext(UserAvatarStoreContext);
  if (!store) throw new Error("useUserAvatarStore requires UserAvatarStoreProvider");
  return store;
}

export function useUserAvatarStoreOptional(): AvatarStore | null {
  return useContext(UserAvatarStoreContext);
}

export function useUserAvatar(id: string): string | null | undefined {
  const store = useUserAvatarStore();
  const subscribe = useCallback((listener: () => void) => store.subscribe(id, listener), [store, id]);
  const snapshot = useCallback(() => store.lookup(id), [store, id]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useRoomAvatar(roomId: string | null, hint?: string | null): string | null {
  const store = useUserAvatarStore();
  const value = useUserAvatar(roomId ?? "");
  useEffect(() => {
    if (roomId && hint && store.lookup(roomId) === undefined) store.prime(roomId, hint);
  }, [roomId, hint, store]);
  useEffect(() => {
    if (roomId && value === undefined) store.requestFetch([roomId]);
  }, [roomId, value, store]);
  return value === undefined ? hint ?? null : value;
}

export type { AvatarStore as UserAvatarStore };
