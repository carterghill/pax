import type { RoomManagementMember } from "../types/matrix";
import { userInitialAvatarBackground } from "../utils/userAvatarColor";
import type { ThemePalette, ThemeTypography, ThemeSpacing } from "../theme/types";
import { avatarSrc } from "../utils/avatarSrc";

export default function SettingsMemberCategory({
  title,
  members,
  searchTerm,
  palette,
  typography,
  spacing,
  emptyMessage,
  alwaysShow = false,
  onKick,
  onBan,
  onPrimaryAction,
  primaryActionLabel,
  onSecondaryAction,
  secondaryActionLabel,
  actionBusyUserId,
  resolvedColorScheme,
}: {
  title: string;
  members: RoomManagementMember[];
  searchTerm: string;
  palette: ThemePalette;
  typography: ThemeTypography;
  spacing: ThemeSpacing;
  emptyMessage?: string;
  alwaysShow?: boolean;
  onKick?: (userId: string) => void;
  onBan?: (userId: string) => void;
  onPrimaryAction?: (userId: string) => void;
  primaryActionLabel?: string;
  onSecondaryAction?: (userId: string) => void;
  secondaryActionLabel?: string;
  actionBusyUserId?: string | null;
  resolvedColorScheme: "light" | "dark";
}) {
  const q = searchTerm.trim().toLowerCase();
  const filtered = members.filter((m) => {
    if (!q) return true;
    const label = (m.displayName ?? m.userId).toLowerCase();
    return label.includes(q);
  });

  if (!alwaysShow && filtered.length === 0) return null;

  return (
    <div style={{ marginBottom: spacing.unit * 4 }}>
      <div
        style={{
          fontSize: typography.fontSizeSmall,
          fontWeight: typography.fontWeightBold,
          color: palette.textSecondary,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: spacing.unit * 2,
        }}
      >
        {title} — {filtered.length}
      </div>
      {filtered.length === 0 ? (
        <div
          style={{
            padding: `${spacing.unit * 3}px ${spacing.unit * 3}px`,
            borderRadius: 8,
            border: `1px solid ${palette.border}`,
            backgroundColor: palette.bgTertiary,
            color: palette.textSecondary,
            fontSize: typography.fontSizeSmall,
          }}
        >
          {emptyMessage ?? `No ${title.toLowerCase()} found.`}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: spacing.unit * 1.5 }}>
          {filtered.map((member) => {
            const displayName = member.displayName ?? member.userId;
            const isBusy = actionBusyUserId === member.userId;
            const canKick = member.canKick ?? false;
            const canBan = member.canBan ?? false;
            return (
              <div
                key={member.userId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: spacing.unit * 3,
                  padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
                  backgroundColor: palette.bgTertiary,
                  borderRadius: 8,
                  border: `1px solid ${palette.border}`,
                  minWidth: 0,
                  maxWidth: "100%",
                }}
              >
                <div style={{ flexShrink: 0 }}>
                  {member.avatarUrl ? (
                    <img
                      src={avatarSrc(member.avatarUrl)}
                      alt=""
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: "50%",
                        objectFit: "cover",
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: "50%",
                        backgroundColor: userInitialAvatarBackground(
                          member.userId,
                          resolvedColorScheme,
                        ),
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#fff",
                        fontSize: typography.fontSizeSmall,
                        fontWeight: typography.fontWeightBold,
                      }}
                    >
                      {(displayName || "?").charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                  <div
                    title={displayName}
                    style={{
                      fontWeight: typography.fontWeightMedium,
                      color: palette.textPrimary,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {displayName}
                  </div>
                  <div
                    title={member.userId}
                    style={{
                      fontSize: typography.fontSizeSmall - 1,
                      color: palette.textSecondary,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {member.userId}
                  </div>
                </div>
                {(onKick || onBan) && (canKick || canBan) && (
                  <div
                    style={{
                      display: "flex",
                      gap: spacing.unit * 1.5,
                      flexShrink: 0,
                      flexWrap: "wrap",
                      justifyContent: "flex-end",
                    }}
                  >
                    {onKick && canKick && (
                      <button
                        type="button"
                        onClick={() => onKick(member.userId)}
                        style={{
                          padding: `${spacing.unit}px ${spacing.unit * 2.5}px`,
                          backgroundColor: palette.bgTertiary,
                          color: palette.textPrimary,
                          border: `1px solid ${palette.border}`,
                          borderRadius: 6,
                          cursor: "pointer",
                          fontSize: typography.fontSizeSmall,
                          fontWeight: typography.fontWeightMedium,
                        }}
                      >
                        Kick
                      </button>
                    )}
                    {onBan && canBan && (
                      <button
                        type="button"
                        onClick={() => onBan(member.userId)}
                        style={{
                          padding: `${spacing.unit}px ${spacing.unit * 2.5}px`,
                          backgroundColor: "rgba(237,66,69,0.15)",
                          color: "#ed4245",
                          border: "1px solid rgba(237,66,69,0.35)",
                          borderRadius: 6,
                          cursor: "pointer",
                          fontSize: typography.fontSizeSmall,
                          fontWeight: typography.fontWeightMedium,
                        }}
                      >
                        Ban
                      </button>
                    )}
                  </div>
                )}
                {(onPrimaryAction || onSecondaryAction) && (
                  <div
                    style={{
                      display: "flex",
                      gap: spacing.unit * 1.5,
                      flexShrink: 0,
                    }}
                  >
                    {onSecondaryAction && secondaryActionLabel && (
                      <button
                        type="button"
                        onClick={() => onSecondaryAction(member.userId)}
                        disabled={isBusy}
                        style={{
                          padding: `${spacing.unit}px ${spacing.unit * 2.5}px`,
                          backgroundColor: palette.bgActive,
                          color: palette.textPrimary,
                          border: `1px solid ${palette.border}`,
                          borderRadius: 6,
                          cursor: isBusy ? "not-allowed" : "pointer",
                          opacity: isBusy ? 0.6 : 1,
                          fontSize: typography.fontSizeSmall,
                          fontWeight: typography.fontWeightMedium,
                        }}
                      >
                        {secondaryActionLabel}
                      </button>
                    )}
                    {onPrimaryAction && primaryActionLabel && (
                      <button
                        type="button"
                        onClick={() => onPrimaryAction(member.userId)}
                        disabled={isBusy}
                        style={{
                          padding: `${spacing.unit}px ${spacing.unit * 3}px`,
                          backgroundColor: "#23a55a",
                          color: "#fff",
                          border: "none",
                          borderRadius: 6,
                          cursor: isBusy ? "not-allowed" : "pointer",
                          opacity: isBusy ? 0.6 : 1,
                          fontSize: typography.fontSizeSmall,
                          fontWeight: typography.fontWeightMedium,
                        }}
                      >
                        {isBusy ? "Working..." : primaryActionLabel}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}