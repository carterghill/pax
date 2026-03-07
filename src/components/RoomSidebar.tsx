import { Room } from "../types/matrix";

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
  return (
    <div style={{
      width: 240,
      backgroundColor: "#2b2d31",
      display: "flex",
      flexDirection: "column",
      height: "100vh",
    }}>
      <h2 style={{
        padding: "16px 16px 12px",
        fontSize: 15,
        fontWeight: 600,
        color: "#f2f3f5",
        borderBottom: "1px solid #1f2023",
        margin: 0,
      }}>
        {spaceName}
      </h2>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px" }}>
        {rooms.map((room) => (
          <div
            key={room.id}
            onClick={() => onSelectRoom(room.id)}
            style={{
              padding: "8px 12px",
              borderRadius: 4,
              cursor: "pointer",
              color: activeRoomId === room.id ? "#f2f3f5" : "#949ba4",
              backgroundColor: activeRoomId === room.id ? "#404249" : "transparent",
              fontSize: 14,
              fontWeight: activeRoomId === room.id ? 500 : 400,
            }}
          >
            # {room.name}
          </div>
        ))}
        {rooms.length === 0 && (
          <div style={{ color: "#949ba4", padding: "8px 12px", fontSize: 13 }}>
            No rooms in this space
          </div>
        )}
      </div>
    </div>
  );
}