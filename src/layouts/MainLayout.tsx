import SpaceSidebar from "../components/SpaceSidebar";
import RoomSidebar from "../components/RoomSidebar";
import ChatView from "../layouts/ChatView";
import { useRooms } from "../hooks/useRooms";
import { useState, useCallback } from "react";
import { Volume2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import SettingsMenu from "../components/SettingsMenu";

const VOICE_ROOM_TYPE = "org.matrix.msc3417.call";

export default function MainLayout({ userId }: { userId: string }) {
  const { spaces, roomsBySpace, getRoom } = useRooms(userId);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  // Track active room per space — key is spaceId ("" for Home)
  const [activeRoomBySpace, setActiveRoomBySpace] = useState<Record<string, string | null>>({});

  const spaceKey = activeSpaceId ?? "";
  const activeRoomId = activeRoomBySpace[spaceKey] ?? null;

  const setActiveRoomId = useCallback((roomId: string | null) => {
    setActiveRoomBySpace((prev) => ({ ...prev, [spaceKey]: roomId }));
  }, [spaceKey]);

  const { palette } = useTheme();
  const activeSpace = activeSpaceId ? getRoom(activeSpaceId) : null;
  const visibleRooms = roomsBySpace(activeSpaceId);
  const activeRoom = activeRoomId ? getRoom(activeRoomId) : null;

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <SpaceSidebar
        spaces={spaces}
        activeSpaceId={activeSpaceId}
        onSelectSpace={setActiveSpaceId}
      />
      <RoomSidebar
        rooms={visibleRooms}
        activeRoomId={activeRoomId}
        onSelectRoom={setActiveRoomId}
        spaceName={activeSpace?.name ?? "Home"}
      />
      <main style={{
        flex: 1,
        backgroundColor: palette.bgPrimary,
        color: palette.textPrimary,
        display: "flex",
      }}>
        {activeRoomId === "settings" ? (
          <SettingsMenu />
        ) : activeRoom && activeRoom.roomType === VOICE_ROOM_TYPE ? (
          <div style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            height: "100vh",
          }}>
            <div style={{
              padding: `${16}px ${16}px`,
              borderBottom: `1px solid ${palette.border}`,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}>
              <Volume2 size={20} color={palette.textSecondary} />
              <span style={{
                fontWeight: 600,
                color: palette.textHeading,
              }}>
                {activeRoom.name}
              </span>
            </div>
            <div style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 16,
              color: palette.textSecondary,
            }}>
              <Volume2 size={64} color={palette.textSecondary} opacity={0.4} />
              <span style={{ fontSize: 18 }}>Voice Channel</span>
              <span style={{ fontSize: 14, opacity: 0.7 }}>Voice chat coming soon</span>
            </div>
          </div>
        ) : activeRoom ? (
          <ChatView room={activeRoom} />
        ) : (
          <div style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: palette.textSecondary,
          }}>
            Select a room
          </div>
        )}
      </main>
    </div>
  );
}