import { Room } from "../types/matrix";
import { useTheme } from "../theme/ThemeContext";

interface RoomSidebarProps {
  rooms: Room[];
  activeRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  spaceName: string;
}

export default function RoomSidebar({
  rooms,
  activeRoomId,
  onSelectRoom,
  spaceName,
}: RoomSidebarProps) {
  const { palette, spacing, typography } = useTheme();

  return (
    <div style={{
      width: spacing.sidebarWidth,
      backgroundColor: palette.bgSecondary,
      display: "flex",
      flexDirection: "column",
      height: "100vh",
    }}>
      <h2 style={{
        padding: `${spacing.unit * 4}px ${spacing.unit * 4}px`,
        fontSize: typography.fontSizeLarge,
        fontWeight: typography.fontWeightBold,
        color: palette.textHeading,
        borderBottom: `1px solid ${palette.border}`,
        margin: 0,
      }}>
        {spaceName}
      </h2>
      { spaceName === "Home" &&
        <div 
          onClick={() => onSelectRoom("settings")}
          style={{
            padding: `${spacing.unit * 4}px ${spacing.unit * 4}px ${spacing.unit * 3}px`,
            cursor: "pointer",
            fontWeight: typography.fontWeightBold,
            color: activeRoomId==="settings" ? palette.textHeading : palette.textSecondary,
            backgroundColor: activeRoomId==="settings" ? palette.bgActive : palette.bgSecondary,
            borderBottom: `1px solid ${palette.border}`,
            margin: 0,
          }}
        >
          Settings 
        </div>
      }
      <div style={{ flex: 1, overflowY: "auto", padding: spacing.unit * 2 }}>
        {rooms.map((room) => (
          <div
            key={room.id}
            onClick={() => onSelectRoom(room.id)}
            style={{
              padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
              borderRadius: spacing.unit,
              cursor: "pointer",
              color: activeRoomId === room.id ? palette.textHeading : palette.textSecondary,
              backgroundColor: activeRoomId === room.id ? palette.bgActive : "transparent",
              fontSize: typography.fontSizeBase,
              fontWeight: activeRoomId === room.id
                ? typography.fontWeightMedium
                : typography.fontWeightNormal,
            }}
          >
            # {room.name}
          </div>
        ))}
        {rooms.length === 0 && (
          <div style={{
            color: palette.textSecondary,
            padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
            fontSize: typography.fontSizeSmall,
          }}>
            No rooms in this space
          </div>
        )}
      </div>
    </div>
  );
}