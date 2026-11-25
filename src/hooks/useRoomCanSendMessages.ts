import { useEffect, useState } from "react";
import { getRoomCanSendMessages } from "../features/chat/api";

/** `null` while loading for a room; on invoke failure defaults to `true` so a broken check does not block sending. */
export function useRoomCanSendMessages(roomId: string | null) {
  const [permission, setPermission] = useState<{ roomId: string; canSend: boolean } | null>(null);

  useEffect(() => {
    setPermission(null);
    if (!roomId) return;

    let cancelled = false;

    getRoomCanSendMessages(roomId)
      .then((r) => {
        if (!cancelled) setPermission({ roomId, canSend: r.canSend });
      })
      .catch(() => {
        if (!cancelled) setPermission({ roomId, canSend: true });
      });

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  return permission?.roomId === roomId ? permission.canSend : null;
}
