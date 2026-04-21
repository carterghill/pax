import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RoomPinPermission } from "../types/matrix";

/** `null` while loading; on failure defaults to `false`. */
export function useRoomCanPinMessages(roomId: string | null) {
  const [canPin, setCanPin] = useState<boolean | null>(null);

  useEffect(() => {
    if (!roomId) {
      setCanPin(null);
      return;
    }

    let cancelled = false;
    setCanPin(null);

    invoke<RoomPinPermission>("get_room_can_pin_messages", { roomId })
      .then((r) => {
        if (!cancelled) setCanPin(r.canPin);
      })
      .catch(() => {
        if (!cancelled) setCanPin(false);
      });

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  return canPin;
}
