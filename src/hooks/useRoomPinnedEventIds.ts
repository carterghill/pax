import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function useRoomPinnedEventIds(roomId: string | null) {
  const [pinnedEventIds, setPinnedEventIds] = useState<string[]>([]);

  const refreshPinned = useCallback(async () => {
    if (!roomId) {
      setPinnedEventIds([]);
      return;
    }
    try {
      const ids = await invoke<string[]>("get_room_pinned_event_ids", { roomId });
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
