import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Room } from "../types/matrix";
import { loadPersistedRooms, savePersistedRooms } from "../utils/roomsCache";

export type RoomsForLayout = {
  spaces: Room[];
  roomsBySpace: (spaceId: string | null) => Room[];
  getRoom: (roomId: string) => Room | null;
  fetchRooms: () => Promise<Room[]>;
  upsertOptimisticRoom: (room: Room) => void;
};

export function useRooms(userId: string | null) {
  const [fetchedRooms, setFetchedRooms] = useState<Room[]>([]);
  const [optimisticRooms, setOptimisticRooms] = useState<Room[]>([]);
  const [initialLoadComplete, setInitialLoadComplete] = useState(() => !userId);
  const fetchingRef = useRef(false);

  const mergeRooms = useCallback((serverRooms: Room[], pendingRooms: Room[]) => {
    const byId = new Map(serverRooms.map((room) => [room.id, room]));
    for (const room of pendingRooms) {
      if (!byId.has(room.id)) {
        byId.set(room.id, room);
      }
    }
    return Array.from(byId.values());
  }, []);

  const fetchRooms = useCallback(async (): Promise<Room[]> => {
    if (!userId || fetchingRef.current) return [];
    fetchingRef.current = true;

    try {
      const list = await invoke<Room[]>("get_rooms");
      setFetchedRooms(list);
      savePersistedRooms(userId, list);
      let merged: Room[] = [];
      setOptimisticRooms((prev) => {
        const next = prev.filter(
          (pending) => !list.some((room) => room.id === pending.id)
        );
        merged = mergeRooms(list, next);
        return next;
      });
      return merged;
    } catch (e) {
      console.error("Failed to fetch rooms:", e);
      return [];
    } finally {
      fetchingRef.current = false;
    }
  }, [userId, mergeRooms]);

  const upsertOptimisticRoom = useCallback((room: Room) => {
    setOptimisticRooms((prev) => [room, ...prev.filter((existing) => existing.id !== room.id)]);
  }, []);

  // Hydrate from disk so "Loading rooms…" can skip when we have a prior snapshot for this user.
  useLayoutEffect(() => {
    if (!userId) return;
    setOptimisticRooms([]);
    const cached = loadPersistedRooms(userId);
    if (cached) {
      setFetchedRooms(cached);
      setInitialLoadComplete(true);
    } else {
      setInitialLoadComplete(false);
    }
  }, [userId]);

  // Always refresh from the server (parallel + faster on the Rust side; cache is stale-while-revalidate).
  useEffect(() => {
    if (!userId) {
      setFetchedRooms([]);
      setOptimisticRooms([]);
      setInitialLoadComplete(true);
      return;
    }

    let cancelled = false;
    fetchingRef.current = true;

    invoke<Room[]>("get_rooms")
      .then((list) => {
        if (cancelled) return;
        setFetchedRooms(list);
        savePersistedRooms(userId, list);
      })
      .catch((e) => {
        console.error("Failed to fetch rooms:", e);
      })
      .finally(() => {
        fetchingRef.current = false;
        if (!cancelled) setInitialLoadComplete(true);
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Re-fetch whenever the sync loop signals a change
  useEffect(() => {
    const unlisten = listen("rooms-changed", () => {
      fetchRooms();
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [fetchRooms]);

  const rooms = useMemo(
    () => mergeRooms(fetchedRooms, optimisticRooms),
    [fetchedRooms, optimisticRooms, mergeRooms]
  );

  const spaces = useMemo(() => rooms.filter((r) => r.isSpace), [rooms]);

  const roomsBySpaceMap = useMemo(() => {
    const map = new Map<string, Room[]>();
    const homeRooms: Room[] = [];

    for (const room of rooms) {
      if (room.isSpace) continue;

      if (room.parentSpaceIds.length === 0) {
        homeRooms.push(room);
        continue;
      }

      for (const parentSpaceId of room.parentSpaceIds) {
        const current = map.get(parentSpaceId);
        if (current) {
          current.push(room);
        } else {
          map.set(parentSpaceId, [room]);
        }
      }
    }

    map.set("", homeRooms);
    return map;
  }, [rooms]);

  const roomsBySpace = useCallback(
    (spaceId: string | null) => roomsBySpaceMap.get(spaceId ?? "") ?? [],
    [roomsBySpaceMap]
  );

  const getRoom = (roomId: string) => rooms.find((r) => r.id === roomId) ?? null;

  return {
    rooms,
    spaces,
    roomsBySpace,
    getRoom,
    fetchRooms,
    upsertOptimisticRoom,
    initialLoadComplete,
  };
}