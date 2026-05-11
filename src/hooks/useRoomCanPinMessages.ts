import { useEffect, useState } from "react";
import { getRoomCanPinMessages } from "../features/chat/api";

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

    getRoomCanPinMessages(roomId)
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
