import { useEffect, useState } from "react";
import { getRoomCanSendMessages } from "../features/chat/api";

/** `null` while loading for a room; on invoke failure defaults to `true` so a broken check does not block sending. */
export function useRoomCanSendMessages(roomId: string | null) {
  const [canSend, setCanSend] = useState<boolean | null>(null);

  useEffect(() => {
    if (!roomId) {
      setCanSend(null);
      return;
    }

    let cancelled = false;
    setCanSend(null);

    getRoomCanSendMessages(roomId)
      .then((r) => {
        if (!cancelled) setCanSend(r.canSend);
      })
      .catch(() => {
        if (!cancelled) setCanSend(true);
      });

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  return canSend;
}
