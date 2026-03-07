import SpaceSidebar from "../components/SpaceSidebar";
import RoomSidebar from "../components/RoomSidebar";
import ChatView from "../layouts/ChatView";
import { useRooms } from "../hooks/useRooms";
import { useState } from "react";
import { useTheme } from "../theme/ThemeContext";
import SettingsMenu from "../components/SettingsMenu";

export default function MainLayout({ userId }: { userId: string }) {
  const { spaces, roomsBySpace, getRoom } = useRooms(userId);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);

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