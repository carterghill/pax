import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNotificationStore } from "../context/NotificationSettingsContext";
import type { NotificationLevel, TrayUnreadIndicatorMode } from "../types/notifications";
export type { NotificationLevel, TrayUnreadIndicatorMode, NotificationSettings, UnreadSettings } from "../types/notifications";

export const NOTIFICATION_LEVEL_LABELS: Record<NotificationLevel, string> = {
  all: "All messages",
  allMentions: "Mentions",
  userMentions: "Direct mentions only",
  roomPings: "@room only",
  none: "Off",
};

/** All consumers share one session snapshot and subscription set. */
export function useNotificationSettings() {
  const [snapshot, store] = useNotificationStore();
  // --- Notification level setters -----------------------------------------

  /** Set the account-wide default.  `null` reverts to Element-style defaults. */
  const setGlobalDefault = useCallback(
    async (level: NotificationLevel | null): Promise<void> => {
      await invoke("set_global_default_notification_level", { level });
    },
    [],
  );

  const setTrayUnreadIndicatorMode = useCallback(
    async (mode: TrayUnreadIndicatorMode): Promise<void> => {
      await invoke("set_tray_unread_indicator_mode", { mode });
    },
    [],
  );

  /** Set a space's default.  `null` removes the entry; child rooms then
   *  revert to the global default / Element defaults on reconcile. */
  const setSpaceLevel = useCallback(
    async (spaceId: string, level: NotificationLevel | null): Promise<void> => {
      await invoke("set_space_notification_level", { spaceId, level });
    },
    [],
  );

  /** Set a per-room override.  Use `clearRoomLevel` to re-inherit. */
  const setRoomLevel = useCallback(
    async (roomId: string, level: NotificationLevel): Promise<void> => {
      await invoke("set_room_notification_level", { roomId, level });
    },
    [],
  );

  /** Remove the per-room override — the room falls back through the chain. */
  const clearRoomLevel = useCallback(async (roomId: string): Promise<void> => {
    await invoke("clear_room_notification_level", { roomId });
  }, []);

  // --- Unread-indicator setters -------------------------------------------

  const setGlobalUnreadIndicator = useCallback(
    async (show: boolean): Promise<void> => {
      await invoke("set_global_unread_indicator", { show });
    },
    [],
  );

  /** `show: null` clears the override so the space inherits the global. */
  const setSpaceUnreadIndicator = useCallback(
    async (spaceId: string, show: boolean | null): Promise<void> => {
      await invoke("set_space_unread_indicator", { spaceId, show });
    },
    [],
  );

  /** `show: null` clears the override so the room inherits space / global. */
  const setRoomUnreadIndicator = useCallback(
    async (roomId: string, show: boolean | null): Promise<void> => {
      await invoke("set_room_unread_indicator", { roomId, show });
    },
    [],
  );

  const getRoomEffectiveLevel = useCallback((roomId: string) => store.getLevel(roomId), [store, snapshot.effectiveLevels]);
  return {
    ...snapshot,
    setGlobalDefault, setTrayUnreadIndicatorMode, setSpaceLevel, setRoomLevel, clearRoomLevel,
    setGlobalUnreadIndicator, setSpaceUnreadIndicator, setRoomUnreadIndicator, getRoomEffectiveLevel,
  };
}
