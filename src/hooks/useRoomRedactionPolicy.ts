import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RoomRedactionPolicy } from "../types/matrix";

const defaultPolicy: RoomRedactionPolicy = {
  canRedactOwn: false,
  canRedactOther: false,
};

export function useRoomRedactionPolicy(roomId: string | null) {
  const [policy, setPolicy] = useState<RoomRedactionPolicy>(defaultPolicy);

  useEffect(() => {
    if (!roomId) {
      setPolicy(defaultPolicy);
      return;
    }

    let cancelled = false;
    invoke<RoomRedactionPolicy>("get_room_redaction_policy", { roomId })
      .then((p) => {
        if (!cancelled) setPolicy(p);
      })
      .catch(() => {
        if (!cancelled) setPolicy(defaultPolicy);
      });

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  return policy;
}
