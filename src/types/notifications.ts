/**
 * Notification level enum — mirrors `commands::pax_settings::NotificationLevel`.
 *
 * Serialised by the backend with `serde(rename_all = "camelCase")`, so the
 * wire values are these lowercase-camelCase strings.  At the push-rule layer
 * only `all` vs everything-else is distinguishable; the finer-grained levels
 * are stored in account data and applied client-side by the desktop
 * notification handler.
 */
export type NotificationLevel =
  | "all"
  | "userMentions"
  | "roomPings"
  | "allMentions"
  | "none";

/** Mirrors `commands::pax_settings::TrayUnreadIndicatorMode`. */
export type TrayUnreadIndicatorMode =
  | "allRed"
  | "split"
  | "notifyOnly"
  | "never";

export interface NotificationSettings {
  version: number;
  trayUnreadIndicator?: TrayUnreadIndicatorMode;
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

export const defaultNotificationSettings: NotificationSettings = {
  version: 1,
  trayUnreadIndicator: "split",
  globalDefault: null,
  spaces: {},
  rooms: {},
};

export const defaultUnreadSettings: UnreadSettings = {
  version: 1,
  global: true,
  spaces: {},
  rooms: {},
};

