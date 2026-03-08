import { useTheme } from "../theme/ThemeContext";
import { useRoomMembers } from "../hooks/useRoomMembers";

interface UserMenuProps {
  roomId: string;
}

const presenceColor: Record<string, string> = {
  online: "#23a55a",
  unavailable: "#f0b232",
  offline: "#80848e",
};

export default function UserMenu({ roomId }: UserMenuProps) {
  const { palette, typography, spacing } = useTheme();
  const { members, loading } = useRoomMembers(roomId);

  // Group members by presence
  const online = members.filter((m) => m.presence === "online");
  const unavailable = members.filter((m) => m.presence === "unavailable");
  const offline = members.filter((m) => m.presence !== "online" && m.presence !== "unavailable");

  const groups = [
    { label: `Online — ${online.length}`, members: online },
    ...(unavailable.length > 0 ? [{ label: `Away — ${unavailable.length}`, members: unavailable }] : []),
    { label: `Offline — ${offline.length}`, members: offline },
  ];

  return (
    <div style={{
      width: 240,
      flexShrink: 0,
      backgroundColor: palette.bgSecondary,
      borderLeft: `1px solid ${palette.border}`,
      overflowY: "auto",
      padding: `${spacing.unit * 4}px 0`,
    }}>
      {loading ? (
        <div style={{
          color: palette.textSecondary,
          fontSize: typography.fontSizeSmall,
          padding: `${spacing.unit * 2}px ${spacing.unit * 4}px`,
        }}>
          Loading members...
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.label}>
            <div style={{
              padding: `${spacing.unit * 4}px ${spacing.unit * 4}px ${spacing.unit * 2}px`,
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightBold,
              color: palette.textSecondary,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}>
              {group.label}
            </div>

            {group.members.map((member) => (
              <div
                key={member.userId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: spacing.unit * 3,
                  padding: `${spacing.unit * 1.5}px ${spacing.unit * 4}px`,
                  cursor: "pointer",
                  borderRadius: spacing.unit,
                  margin: `0 ${spacing.unit * 2}px`,
                  opacity: member.presence === "offline" ? 0.5 : 1,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.backgroundColor = palette.bgHover;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.backgroundColor = "transparent";
                }}
              >
                <div style={{ position: "relative", flexShrink: 0 }}>
                  {member.avatarUrl ? (
                    <img
                      src={member.avatarUrl}
                      alt={member.displayName ?? member.userId}
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: "50%",
                        objectFit: "cover",
                      }}
                    />
                  ) : (
                    <div style={{
                      width: 32,
                      height: 32,
                      borderRadius: "50%",
                      backgroundColor: palette.accent,
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: typography.fontSizeSmall,
                      fontWeight: typography.fontWeightBold,
                    }}>
                      {(member.displayName ?? member.userId).charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div style={{
                    position: "absolute",
                    bottom: -1,
                    right: -1,
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    backgroundColor: presenceColor[member.presence] ?? presenceColor.offline,
                    border: `2px solid ${palette.bgSecondary}`,
                  }} />
                </div>

                <span style={{
                  fontSize: typography.fontSizeBase,
                  fontWeight: typography.fontWeightMedium,
                  color: member.presence === "offline" ? palette.textSecondary : palette.textPrimary,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {member.displayName ?? member.userId}
                </span>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}