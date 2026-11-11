import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { NotificationStore } from "../data/NotificationStore";
import type { NotificationLevel, NotificationSettings, UnreadSettings } from "../types/notifications";

const Context = createContext<NotificationStore | null>(null);

export function NotificationSettingsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new NotificationStore({
    notificationSettings: () => invoke<NotificationSettings>("get_notification_settings"),
    unreadSettings: () => invoke<UnreadSettings>("get_unread_settings"),
    effectiveLevels: () => invoke<Record<string, NotificationLevel>>("get_all_room_notification_levels"),
  }, (roomId) => invoke<NotificationLevel>("get_room_notification_level", { roomId })));

  useEffect(() => {
    let cancelled = false;
    const unlisteners: (() => void)[] = [];
    void Promise.allSettled([
      listen<NotificationSettings>("pax-notification-settings-changed", (e) => { if (!cancelled) store.replace("notificationSettings", e.payload); }),
      listen<UnreadSettings>("pax-unread-settings-changed", (e) => { if (!cancelled) store.replace("unreadSettings", e.payload); }),
      listen("pax-notification-settings-invalidated", () => { if (!cancelled) store.invalidate("notificationSettings", "effectiveLevels"); }),
      listen("pax-notification-levels-invalidated", () => { if (!cancelled) store.invalidate("effectiveLevels"); }),
      listen("sync-ready", () => { if (!cancelled) store.invalidate(); }),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === "fulfilled") {
          if (cancelled) result.value(); else unlisteners.push(result.value);
        } else console.error("Failed to subscribe to notification settings:", result.reason);
      }
      if (!cancelled) store.start();
    });
    return () => { cancelled = true; unlisteners.forEach((off) => off()); store.dispose(); };
  }, [store]);

  return <Context.Provider value={store}>{children}</Context.Provider>;
}

export function useNotificationStore() {
  const store = useContext(Context);
  if (!store) throw new Error("Notification settings require NotificationSettingsProvider");
  return [useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot), store] as const;
}
