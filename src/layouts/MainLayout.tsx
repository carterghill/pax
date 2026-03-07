import SpaceSidebar from "../components/SpaceSidebar";
import RoomSidebar from "../components/RoomSidebar";
import { useRooms } from "../hooks/useRooms";
import { useState } from "react";

export default function MainLayout({ userId }: { userId: string }) {
  const { spaces, roomsBySpace, getRoom } = useRooms(userId);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);

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
        backgroundColor: "#313338",
        color: "#dbdee1",
        padding: 20,
      }}>
        {activeRoomId
          ? <div>Messages for {getRoom(activeRoomId)?.name} go here</div>
          : <div>Select a room</div>
        }
      </main>
    </div>
  );
}