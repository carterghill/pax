import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Room } from "../types/matrix";

export function useRooms(userId: string) {
  const [rooms, setRooms] = useState<Room[]>([]);

  useEffect(() => {
    invoke<Room[]>("get_rooms").then(setRooms);
  }, [userId]);

  const spaces = rooms.filter((r) => r.is_space);
  const roomsBySpace = (spaceId: string) =>
    rooms.filter((r) => !r.is_space); // TODO: filter by actual parent space

  return { rooms, spaces, roomsBySpace };
}