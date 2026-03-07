import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Room } from "../types/matrix";

export function useRooms(userId: string) {
  const [rooms, setRooms] = useState<Room[]>([]);

  useEffect(() => {
    invoke<Room[]>("get_rooms").then(setRooms);
  }, [userId]);

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