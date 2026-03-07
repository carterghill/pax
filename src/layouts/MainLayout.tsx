import SpaceSidebar from "../components/SpaceSidebar";
import RoomSidebar from "../components/RoomSidebar";
import { useRooms } from "../hooks/useRooms";
import { useState } from "react";
import { useTheme } from "../theme/ThemeContext";

export default function MainLayout({ userId }: { userId: string }) {
  const { spaces, roomsBySpace, getRoom } = useRooms(userId);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  
  const { palette, spacing, typography } = useTheme();

  const activeSpace = activeSpaceId ? getRoom(activeSpaceId) : null;
  const visibleRooms = roomsBySpace(activeSpaceId);

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
        padding: 20,
      }}>
        {activeRoomId
          ? activeRoomId === "settings" ? <div>Settings</div> 
          : <div>Messages for {getRoom(activeRoomId)?.name} go here</div>
          : <div>Select a room</div>
        }
      </main>
    </div>
  );
}