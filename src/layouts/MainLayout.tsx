// import Sidebar from "../components/Sidebar";
import SpaceSidebar from "../components/SpaceSidebar";
import { useRooms } from "../hooks/useRooms";
import { useState } from "react";

export default function MainLayout({ userId }: { userId: string }) {
  const { rooms, spaces, roomsBySpace } = useRooms(userId);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      {/* <Sidebar
        rooms={rooms}
        activeRoomId={activeRoomId}
        onSelectRoom={setActiveRoomId}
      /> */}
      <SpaceSidebar
        spaces={spaces}
        activeSpaceId={activeSpaceId}
        onSelectSpace={setActiveSpaceId}
      />
      <main style={{ flex: 1 }}>
        {activeRoomId
          ? <div>Messages for {activeRoomId} go here</div>
          : <div>Select a room</div>
        }
      </main>
    </div>
  );
}