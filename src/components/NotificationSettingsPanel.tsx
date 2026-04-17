import { useEffect, useState } from "react";
import { useTheme } from "../theme/ThemeContext";
import {
  useNotificationSettings,
  type NotificationLevel,
  NOTIFICATION_LEVEL_LABELS,
} from "../hooks/useNotificationSettings";

type Scope = "global" | "space" | "room";

interface NotificationSettingsPanelProps {
  scope: Scope;
  /** Required for `space` and `room` scopes; ignored for `global`. */
  scopeId?: string;
}

interface LevelOption {
  level: NotificationLevel;
  label: string;
  description: string;
}

/**
 * Five levels as the user sees them.  Order is significant — it's the
 * radio list order from "loudest" to "quietest" so muscle-memory aligns with
 * Element users.
 *
 * `userMentions` and `roomPings` are exposed here even though mobile push
 * notifications can't distinguish them from `allMentions` — the finer
 * distinction kicks in once the desktop notification handler ships (Pass
 * 3.3).  Users who just want the simple picks can safely treat the three
 * "Mentions" variants as a group.
 */
const LEVEL_OPTIONS: readonly LevelOption[] = [
  {
    level: "all",
    label: NOTIFICATION_LEVEL_LABELS.all,
    description: "Notify for every message.",
  },
  {
    level: "allMentions",
    label: NOTIFICATION_LEVEL_LABELS.allMentions,
    description: "Notify when you're mentioned or @room is used.",
  },
  {
    level: "userMentions",
    label: NOTIFICATION_LEVEL_LABELS.userMentions,
    description: "Notify only when you're personally @-mentioned.",
  },
  {
    level: "roomPings",
    label: NOTIFICATION_LEVEL_LABELS.roomPings,
    description: "Notify only for @room broadcasts.",
  },
  {
    level: "none",
    label: NOTIFICATION_LEVEL_LABELS.none,
    description: "Mute this room entirely.",
  },
] as const;

export default function NotificationSettingsPanel({
  scope,
  scopeId,
}: NotificationSettingsPanelProps) {
  const { palette, typography, spacing } = useTheme();
  const {
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
  } = useNotificationSettings();

  // ----- Current explicit level at this scope ------------------------------

  const explicitLevel: NotificationLevel | null =
    scope === "global"
      ? notificationSettings.globalDefault
      : scope === "space" && scopeId
        ? (notificationSettings.spaces[scopeId] ?? null)
        : scope === "room" && scopeId
          ? (notificationSettings.rooms[scopeId] ?? null)
          : null;

  // Effective level (what would apply after walking the override chain).
  // Used for the "Use default (currently: X)" hint on room scope.  We only
  // query for room scope because space scope doesn't inherit from anywhere
  // concrete (there's no "resolve this space's effective level" concept —
  // a space's level either exists or doesn't), and global always uses its
  // own stored value.
  const [roomEffective, setRoomEffective] =
    useState<NotificationLevel | null>(null);
  useEffect(() => {
    if (scope !== "room" || !scopeId) {
      setRoomEffective(null);
      return;
    }
    let cancelled = false;
    getRoomEffectiveLevel(scopeId)
      .then((level) => {
        if (!cancelled) setRoomEffective(level);
      })
      .catch(() => {
        /* non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, [scope, scopeId, notificationSettings, getRoomEffectiveLevel]);

  // ----- Level setter ------------------------------------------------------

  async function handleLevelChange(next: NotificationLevel | null) {
    if (scope === "global") {
      await setGlobalDefault(next);
    } else if (scope === "space" && scopeId) {
      await setSpaceLevel(scopeId, next);
    } else if (scope === "room" && scopeId) {
      if (next === null) {
        await clearRoomLevel(scopeId);
      } else {
        await setRoomLevel(scopeId, next);
      }
    }
  }

  // ----- Unread-indicator state -------------------------------------------

  const unreadExplicit: boolean | null =
    scope === "global"
      ? unreadSettings.global
      : scope === "space" && scopeId
        ? (unreadSettings.spaces[scopeId] ?? null)
        : scope === "room" && scopeId
          ? (unreadSettings.rooms[scopeId] ?? null)
          : null;

  async function handleUnreadChange(next: boolean | null) {
    if (scope === "global") {
      // Global is a boolean toggle — `null` never makes sense here.
      await setGlobalUnreadIndicator(next ?? true);
    } else if (scope === "space" && scopeId) {
      await setSpaceUnreadIndicator(scopeId, next);
    } else if (scope === "room" && scopeId) {
      await setRoomUnreadIndicator(scopeId, next);
    }
  }

  // ----- Styles ------------------------------------------------------------

  const sectionHeading = {
    margin: 0,
    marginBottom: spacing.unit,
    fontSize: typography.fontSizeLarge,
    fontWeight: typography.fontWeightBold,
    color: palette.textHeading,
  };
  const sectionDescription = {
    margin: 0,
    color: palette.textSecondary,
    fontSize: typography.fontSizeBase,
    lineHeight: 1.55,
    marginBottom: spacing.unit * 3,
  };
  const radioRowBase = {
    display: "flex",
    alignItems: "flex-start",
    gap: spacing.unit * 2,
    padding: `${spacing.unit * 2.5}px ${spacing.unit * 3}px`,
    borderRadius: 8,
    cursor: "pointer",
    border: `1px solid ${palette.border}`,
    backgroundColor: palette.bgTertiary,
    transition: "border-color 120ms ease",
  } as const;
  const radioRowSelected = {
    ...radioRowBase,
    borderColor: palette.accent,
  } as const;

  const showInheritRow = scope !== "global";
  const canUseDefaults = scope === "global";

  // ----- Render -----------------------------------------------------------

  if (loading && !scopeId && scope !== "global") {
    return null; // space/room scopes without an id shouldn't even mount
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.unit * 5 }}>
      {/* ============ Notification level ============ */}
      <div>
        <h3 style={sectionHeading}>Notification level</h3>
        <p style={sectionDescription}>
          {scope === "global" &&
            "Default notification level for rooms that don't have their own setting."}
          {scope === "space" &&
            "Applies to rooms directly inside this space that don't have their own setting."}
          {scope === "room" &&
            "Controls when new messages in this room produce a notification."}
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: spacing.unit * 1.5 }}>
          {/* "Inherit" / "Defaults" row — always first */}
          <label
            style={explicitLevel === null ? radioRowSelected : radioRowBase}
          >
            <input
              type="radio"
              name={`notif-level-${scope}-${scopeId ?? "global"}`}
              checked={explicitLevel === null}
              onChange={() => handleLevelChange(null)}
              style={{ accentColor: palette.accent, marginTop: 2 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: typography.fontSizeBase,
                  fontWeight: typography.fontWeightMedium,
                  color: palette.textHeading,
                }}
              >
                {canUseDefaults ? "Use Element defaults" : "Inherit"}
              </div>
              <div
                style={{
                  fontSize: typography.fontSizeSmall,
                  color: palette.textSecondary,
                  marginTop: spacing.unit / 2,
                  lineHeight: 1.4,
                }}
              >
                {canUseDefaults &&
                  "All messages for DMs, mentions only for group rooms."}
                {showInheritRow && scope === "space" &&
                  "Follow the account-wide default for rooms in this space."}
                {showInheritRow &&
                  scope === "room" &&
                  (roomEffective
                    ? `Follows this room's space (or account defaults). Currently: ${NOTIFICATION_LEVEL_LABELS[roomEffective]}.`
                    : "Follows this room's space (or account defaults).")}
              </div>
            </div>
          </label>

          {LEVEL_OPTIONS.map((opt) => {
            const selected = explicitLevel === opt.level;
            return (
              <label
                key={opt.level}
                style={selected ? radioRowSelected : radioRowBase}
              >
                <input
                  type="radio"
                  name={`notif-level-${scope}-${scopeId ?? "global"}`}
                  checked={selected}
                  onChange={() => handleLevelChange(opt.level)}
                  style={{ accentColor: palette.accent, marginTop: 2 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: typography.fontSizeBase,
                      fontWeight: typography.fontWeightMedium,
                      color: palette.textHeading,
                    }}
                  >
                    {opt.label}
                  </div>
                  <div
                    style={{
                      fontSize: typography.fontSizeSmall,
                      color: palette.textSecondary,
                      marginTop: spacing.unit / 2,
                      lineHeight: 1.4,
                    }}
                  >
                    {opt.description}
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        {/* Footnote: desktop-only fine-grained levels */}
        {(scope === "global" || scope === "room") && (
          <div
            style={{
              marginTop: spacing.unit * 2,
              fontSize: typography.fontSizeSmall,
              color: palette.textSecondary,
              lineHeight: 1.5,
            }}
          >
            Distinctions between the three mention modes apply to desktop
            notifications; mobile push treats them all as "mentions only".
          </div>
        )}
      </div>

      {/* ============ Unread indicators ============ */}
      <div>
        <h3 style={sectionHeading}>Unread indicators</h3>
        <p style={sectionDescription}>
          {scope === "global" &&
            "Show the yellow dot next to rooms with unread messages."}
          {scope === "space" &&
            "Whether to show unread indicators for rooms inside this space."}
          {scope === "room" &&
            "Whether to show the unread indicator for this room specifically."}
        </p>

        {scope === "global" ? (
          <label style={radioRowBase}>
            <input
              type="checkbox"
              checked={unreadSettings.global}
              onChange={(e) => handleUnreadChange(e.target.checked)}
              style={{ accentColor: palette.accent, marginTop: 2 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: typography.fontSizeBase,
                  fontWeight: typography.fontWeightMedium,
                  color: palette.textHeading,
                }}
              >
                Show unread indicators
              </div>
              <div
                style={{
                  fontSize: typography.fontSizeSmall,
                  color: palette.textSecondary,
                  marginTop: spacing.unit / 2,
                  lineHeight: 1.4,
                }}
              >
                Turn off to hide all unread dots globally; individual
                spaces and rooms can still re-enable.
              </div>
            </div>
          </label>
        ) : (
          <div
            style={{ display: "flex", flexDirection: "column", gap: spacing.unit * 1.5 }}
          >
            {[
              { value: null as boolean | null, label: "Inherit", desc: "Follow the parent setting." },
              { value: true, label: "Show", desc: "Always show unread indicators here." },
              { value: false, label: "Hide", desc: "Never show unread indicators here." },
            ].map((opt) => {
              const selected = unreadExplicit === opt.value;
              return (
                <label
                  key={String(opt.value)}
                  style={selected ? radioRowSelected : radioRowBase}
                >
                  <input
                    type="radio"
                    name={`notif-unread-${scope}-${scopeId ?? ""}`}
                    checked={selected}
                    onChange={() => handleUnreadChange(opt.value)}
                    style={{ accentColor: palette.accent, marginTop: 2 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: typography.fontSizeBase,
                        fontWeight: typography.fontWeightMedium,
                        color: palette.textHeading,
                      }}
                    >
                      {opt.label}
                    </div>
                    <div
                      style={{
                        fontSize: typography.fontSizeSmall,
                        color: palette.textSecondary,
                        marginTop: spacing.unit / 2,
                        lineHeight: 1.4,
                      }}
                    >
                      {opt.desc}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}