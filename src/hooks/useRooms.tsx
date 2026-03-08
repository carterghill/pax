import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Room } from "../types/matrix";

export function useRooms(userId: string) {
  const [rooms, setRooms] = useState<Room[]>([]);

  const fetchRooms = useCallback(() => {
    invoke<Room[]>("get_rooms").then(setRooms).catch((e) =>
      console.error("Failed to fetch rooms:", e)
    );
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchRooms();
  }, [userId, fetchRooms]);

  // Re-fetch whenever the sync loop signals a change
  useEffect(() => {
    const unlisten = listen("rooms-changed", () => {
      fetchRooms();
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [fetchRooms]);

  const spaces = rooms.filter((r) => r.isSpace);

  const roomsBySpace = (spaceId: string | null) => {
    if (!spaceId) {
      // "Home" — show rooms that aren't in any space
      return rooms.filter((r) => !r.isSpace && r.parentSpaceIds.length === 0);
    }
    return rooms.filter((r) => !r.isSpace && r.parentSpaceIds.includes(spaceId));
  };

  const getRoom = (roomId: string) => rooms.find((r) => r.id === roomId) ?? null;

  return { rooms, spaces, roomsBySpace, getRoom };
}