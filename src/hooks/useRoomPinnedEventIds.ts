import { useCallback, useEffect, useState } from "react";
import { getRoomPinnedEventIds } from "../features/chat/api";

export function useRoomPinnedEventIds(roomId: string | null) {
  const [pinnedEventIds, setPinnedEventIds] = useState<string[]>([]);

  const refreshPinned = useCallback(async () => {
    if (!roomId) {
      setPinnedEventIds([]);
      return;
    }
    try {
      const ids = await getRoomPinnedEventIds(roomId);
      setPinnedEventIds(ids);
    } catch {
      setPinnedEventIds([]);
    }
  }, [roomId]);

  useEffect(() => {
    void refreshPinned();
  }, [refreshPinned]);

  return { pinnedEventIds, refreshPinned };
}
