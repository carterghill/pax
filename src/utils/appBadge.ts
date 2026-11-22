import { invoke } from "@tauri-apps/api/core";

interface AndroidAppBadge {
  setBadgeCount(count: number): void;
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
  const android = androidBadge();
  if (android?.setBadgeCount) {
    android.setBadgeCount(Math.min(count, 2_147_483_647));
    return;
  }
  void invoke("set_app_notification_count", { count, showOnDesktop }).catch(() => {
    /* web / early startup */
  });
}
