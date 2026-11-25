import { invoke } from "@tauri-apps/api/core";

interface AndroidAppBadge {
  setBadgeSessionActive(active: boolean): void;
  getFcmToken(): string;
}

function androidBadge(): AndroidAppBadge | undefined {
  return (window as Window & { PaxAndroid?: AndroidAppBadge }).PaxAndroid;
}

export function setAndroidBadgeSessionActive(active: boolean) {
  androidBadge()?.setBadgeSessionActive?.(active);
}

export function getAndroidPushKey(): string | null {
  return androidBadge()?.getFcmToken?.() || null;
}

export function setAppNotificationCount(count: number, showOnDesktop: boolean) {
  if (androidBadge()) return;
  void invoke("set_app_notification_count", { count, showOnDesktop }).catch(() => {
    /* web / early startup */
  });
}
