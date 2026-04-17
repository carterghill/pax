import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Notification level enum — mirrors `commands::pax_settings::NotificationLevel`.
 *
 * Serialised by the backend with `serde(rename_all = "camelCase")`, so the
 * wire values are these lowercase-camelCase strings.  At the push-rule layer
 * only `all` vs everything-else is distinguishable; the finer-grained levels
 * are stored in account data and applied client-side by the (future)
 * desktop notification handler.
 */
export type NotificationLevel =
  | "all"
  | "userMentions"
  | "roomPings"
  | "allMentions"
  | "none";

/**
 * User-facing labels + short descriptions.  Kept here so the panel and any
 * future surfaces (room-context-menu, etc.) stay aligned.
 */
export const NOTIFICATION_LEVEL_LABELS: Record<NotificationLevel, string> = {
  all: "All messages",
  allMentions: "Mentions",
  userMentions: "Direct mentions only",
  roomPings: "@room only",
  none: "Off",
};

export interface NotificationSettings {
  version: number;
  globalDefault: NotificationLevel | null;
  spaces: Record<string, NotificationLevel>;
  rooms: Record<string, NotificationLevel>;
}

export interface UnreadSettings {
  version: number;
  global: boolean;
  spaces: Record<string, boolean>;
  rooms: Record<string, boolean>;
}

const defaultNotificationSettings: NotificationSettings = {
  version: 1,
  globalDefault: null,
  spaces: {},
  rooms: {},
};

const defaultUnreadSettings: UnreadSettings = {
  version: 1,
  global: true,
  spaces: {},
  rooms: {},
};

/**
 * Subscribes to the two pax account-data blobs and exposes setters for every
 * scope (global / space / room) for both notification levels and unread
 * indicators.  The setters all go through the Tauri command surface, which
 * is the single place that knows how to project levels into push rules +
 * trigger the reconciler.
 *
 * State updates arrive via two paths:
 *   - Initial fetch on mount, so the UI has something to render before any
 *     writes happen.
 *   - `pax-notification-settings-changed` / `pax-unread-settings-changed`
 *     events, emitted by the backend after every successful write.  This
 *     covers writes from any tab / component / even other devices (since
 *     account data syncs).
 */
export function useNotificationSettings() {
  const [notificationSettings, setNotificationSettings] =
    useState<NotificationSettings>(defaultNotificationSettings);
  const [unreadSettings, setUnreadSettings] =
    useState<UnreadSettings>(defaultUnreadSettings);
  const [loading, setLoading] = useState(true);

  // Initial fetch + event subscription.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    (async () => {
      try {
        const [notif, unread] = await Promise.all([
          invoke<NotificationSettings>("get_notification_settings"),
          invoke<UnreadSettings>("get_unread_settings"),
        ]);
        if (cancelled) return;
        setNotificationSettings(notif);
        setUnreadSettings(unread);
      } catch (e) {
        console.warn("[useNotificationSettings] initial fetch failed:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }

      try {
        const off1 = await listen<NotificationSettings>(
          "pax-notification-settings-changed",
          (e) => {
            if (!cancelled) setNotificationSettings(e.payload);
          },
        );
        unlisteners.push(off1);

        const off2 = await listen<UnreadSettings>(
          "pax-unread-settings-changed",
          (e) => {
            if (!cancelled) setUnreadSettings(e.payload);
          },
        );
        unlisteners.push(off2);
      } catch (e) {
        console.warn("[useNotificationSettings] listen failed:", e);
      }
    })();

    return () => {
      cancelled = true;
      for (const off of unlisteners) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  // --- Notification level setters -----------------------------------------

  /** Set the account-wide default.  `null` reverts to Element-style defaults. */
  const setGlobalDefault = useCallback(
    async (level: NotificationLevel | null): Promise<void> => {
      await invoke("set_global_default_notification_level", { level });
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

  // --- Read helpers --------------------------------------------------------

  /**
   * Ask the backend what level this room *effectively* has after walking the
   * override chain.  Used by the panel to display "Use default (currently:
   * Mentions)" when no explicit override exists.
   */
  const getRoomEffectiveLevel = useCallback(
    async (roomId: string): Promise<NotificationLevel> => {
      return await invoke<NotificationLevel>("get_room_notification_level", {
        roomId,
      });
    },
    [],
  );

  return {
    notificationSettings,
    unreadSettings,
    loading,

    setGlobalDefault,
    setSpaceLevel,
    setRoomLevel,
    clearRoomLevel,

    setGlobalUnreadIndicator,
    setSpaceUnreadIndicator,
    setRoomUnreadIndicator,

    getRoomEffectiveLevel,
  };
}