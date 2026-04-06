import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Hash, Volume2, Users, LogIn, Check, Mail, RefreshCw, Plus } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { Room } from "../types/matrix";
import { VOICE_ROOM_TYPE } from "../utils/matrix";
import CreateRoomDialog from "../components/CreateRoomDialog";

interface SpaceChildInfo {
  id: string;
  name: string;
  topic: string | null;
  avatarUrl: string | null;
  membership: string; // "joined" | "invited" | "none"
  joinRule: string | null;
  roomType: string | null;
  numJoinedMembers: number;
}

interface SpaceInfo {
  name: string;
  topic: string | null;
  avatarUrl: string | null;
  children: SpaceChildInfo[];
}

interface SpaceHomeViewProps {
  space: Room;
  onSelectRoom: (roomId: string) => void;
  onRoomsChanged: () => void;
}

export default function SpaceHomeView({ space, onSelectRoom, onRoomsChanged }: SpaceHomeViewProps) {
  const { palette, typography, spacing } = useTheme();
  const [info, setInfo] = useState<SpaceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);
  /** Always matches the latest `space.id` so in-flight fetches for an old space are ignored. */
  const activeSpaceIdRef = useRef(space.id);
  activeSpaceIdRef.current = space.id;

  const [canManageChildren, setCanManageChildren] = useState(false);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const permCheckedRef = useRef<string | null>(null);

  const fetchInfo = useCallback(() => {
    const requestedId = space.id;
    setLoading(true);
    setError(null);

    invoke<SpaceInfo>("get_space_info", { spaceId: requestedId })
      .then((data) => {
        if (activeSpaceIdRef.current !== requestedId) return;
        setInfo(data);
      })
      .catch((e) => {
        if (activeSpaceIdRef.current !== requestedId) return;
        console.error("Failed to fetch space info:", e);
        setError(String(e));
      })
      .finally(() => {
        if (activeSpaceIdRef.current !== requestedId) return;
        setLoading(false);
      });
  }, [space.id]);

  useEffect(() => {
    setInfo(null);
    setError(null);
    setLoading(true);
    setJoiningRoomId(null);
    setShowCreateRoom(false);
    fetchInfo();
  }, [fetchInfo]);

  // Check whether the user can add rooms to this space
  useEffect(() => {
    if (permCheckedRef.current === space.id) return;
    permCheckedRef.current = space.id;
    invoke<boolean>("can_manage_space_children", { spaceId: space.id })
      .then(setCanManageChildren)
      .catch(() => setCanManageChildren(false));
  }, [space.id]);

  async function handleJoinRoom(roomId: string) {
    setJoiningRoomId(roomId);
    try {
      await invoke("join_room", { roomId });
      onRoomsChanged();
      // Refresh space info to update membership states
      fetchInfo();
    } catch (e) {
      console.error("Failed to join room:", e);
    }
    setJoiningRoomId(null);
  }

  const initials = space.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  if (loading && !info) {
    return (
      <div style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: palette.textSecondary,
      }}>
        Loading space info...
      </div>
    );
  }

  if (error && !info) {
    return (
      <div style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: spacing.unit * 3,
      }}>
        <span style={{ color: "#f38ba8", fontSize: typography.fontSizeSmall }}>
          {error}
        </span>
        <button
          onClick={fetchInfo}
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit,
            padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
            borderRadius: spacing.unit * 1.5,
            border: "none",
            backgroundColor: palette.accent,
            color: "#fff",
            fontSize: typography.fontSizeSmall,
            fontWeight: typography.fontWeightBold,
            cursor: "pointer",
          }}
        >
          <RefreshCw size={13} />
          Retry
        </button>
      </div>
    );
  }

  if (!info) return null;

  const joinedRooms = info.children.filter((c) => c.membership === "joined");
  const invitedRooms = info.children.filter((c) => c.membership === "invited");
  const availableRooms = info.children.filter((c) => c.membership === "none");

  return (
    <div style={{
      flex: 1,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        padding: `0 ${spacing.unit * 4}px`,
        height: spacing.headerHeight,
        borderBottom: `1px solid ${palette.border}`,
        display: "flex",
        alignItems: "center",
        gap: spacing.unit * 3,
        boxSizing: "border-box",
        flexShrink: 0,
      }}>
        <span style={{
          fontWeight: typography.fontWeightBold,
          color: palette.textHeading,
          fontSize: typography.fontSizeBase,
        }}>
          {info.name}
        </span>
      </div>

      {/* Scrollable content */}
      <div style={{
        flex: 1,
        overflowY: "auto",
        padding: spacing.unit * 6,
      }}>
        {/* Space hero */}
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: spacing.unit * 3,
          marginBottom: spacing.unit * 8,
          paddingTop: spacing.unit * 4,
        }}>
          {info.avatarUrl ? (
            <img
              src={info.avatarUrl}
              alt={info.name}
              style={{
                width: 72,
                height: 72,
                borderRadius: 20,
                objectFit: "cover",
              }}
            />
          ) : (
            <div style={{
              width: 72,
              height: 72,
              borderRadius: 20,
              backgroundColor: palette.accent,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 24,
              fontWeight: typography.fontWeightBold,
            }}>
              {initials}
            </div>
          )}
          <div style={{
            fontSize: typography.fontSizeLarge + 4,
            fontWeight: typography.fontWeightBold,
            color: palette.textHeading,
            textAlign: "center",
          }}>
            {info.name}
          </div>
          {info.topic && (
            <div style={{
              fontSize: typography.fontSizeBase,
              color: palette.textSecondary,
              textAlign: "center",
              maxWidth: 500,
              lineHeight: typography.lineHeight,
            }}>
              {info.topic}
            </div>
          )}
        </div>

        {/* Create room button */}
        {canManageChildren && (
          <div style={{ marginBottom: spacing.unit * 4 }}>
            <button
              onClick={() => setShowCreateRoom(true)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: spacing.unit * 2,
                padding: `${spacing.unit * 2.5}px ${spacing.unit * 3}px`,
                borderRadius: spacing.unit * 1.5,
                border: `1px solid ${palette.border}`,
                backgroundColor: "transparent",
                color: palette.textPrimary,
                fontSize: typography.fontSizeBase,
                fontWeight: typography.fontWeightMedium,
                fontFamily: typography.fontFamily,
                cursor: "pointer",
                width: "100%",
                transition: "background-color 0.15s",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.backgroundColor = palette.bgHover)
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.backgroundColor = "transparent")
              }
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  backgroundColor: palette.bgActive,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Plus size={18} color={palette.accent} />
              </div>
              Create Room
            </button>
          </div>
        )}

        {/* Room sections */}
        {joinedRooms.length > 0 && (
          <RoomSection
            title="Your Rooms"
            rooms={joinedRooms}
            onClickRoom={onSelectRoom}
            joiningRoomId={joiningRoomId}
            onJoinRoom={handleJoinRoom}
            palette={palette}
            typography={typography}
            spacing={spacing}
          />
        )}

        {invitedRooms.length > 0 && (
          <RoomSection
            title="Pending Invitations"
            rooms={invitedRooms}
            onClickRoom={onSelectRoom}
            joiningRoomId={joiningRoomId}
            onJoinRoom={handleJoinRoom}
            palette={palette}
            typography={typography}
            spacing={spacing}
          />
        )}

        {availableRooms.length > 0 && (
          <RoomSection
            title="Available Rooms"
            rooms={availableRooms}
            onClickRoom={onSelectRoom}
            joiningRoomId={joiningRoomId}
            onJoinRoom={handleJoinRoom}
            palette={palette}
            typography={typography}
            spacing={spacing}
          />
        )}

        {info.children.length === 0 && (
          <div style={{
            color: palette.textSecondary,
            textAlign: "center",
            padding: spacing.unit * 6,
          }}>
            {canManageChildren
              ? "No rooms in this space yet. Create one to get started!"
              : "No rooms in this space yet"}
          </div>
        )}
      </div>

      {/* Create room dialog */}
      {showCreateRoom && (
        <CreateRoomDialog
          spaceId={space.id}
          onClose={() => setShowCreateRoom(false)}
          onCreated={() => {
            onRoomsChanged();
            fetchInfo();
          }}
        />
      )}
    </div>
  );
}

function RoomSection({
  title,
  rooms,
  onClickRoom,
  joiningRoomId,
  onJoinRoom,
  palette,
  typography,
  spacing,
}: {
  title: string;
  rooms: SpaceChildInfo[];
  onClickRoom: (id: string) => void;
  joiningRoomId: string | null;
  onJoinRoom: (id: string) => void;
  palette: ReturnType<typeof useTheme>["palette"];
  typography: ReturnType<typeof useTheme>["typography"];
  spacing: ReturnType<typeof useTheme>["spacing"];
}) {
  return (
    <div style={{ marginBottom: spacing.unit * 6 }}>
      <div style={{
        fontSize: typography.fontSizeSmall,
        fontWeight: typography.fontWeightBold,
        color: palette.textSecondary,
        textTransform: "uppercase" as const,
        letterSpacing: "0.02em",
        padding: `${spacing.unit * 2}px ${spacing.unit * 2}px`,
        marginBottom: spacing.unit,
      }}>
        {title} — {rooms.length}
      </div>
      <div style={{
        display: "flex",
        flexDirection: "column",
        gap: spacing.unit,
      }}>
        {rooms.map((room) => (
          <RoomRow
            key={room.id}
            room={room}
            isJoining={joiningRoomId === room.id}
            onClick={() => {
              if (room.membership === "joined") {
                onClickRoom(room.id);
              }
            }}
            onJoin={() => onJoinRoom(room.id)}
            palette={palette}
            typography={typography}
            spacing={spacing}
          />
        ))}
      </div>
    </div>
  );
}

function RoomRow({
  room,
  isJoining,
  onClick,
  onJoin,
  palette,
  typography,
  spacing,
}: {
  room: SpaceChildInfo;
  isJoining: boolean;
  onClick: () => void;
  onJoin: () => void;
  palette: ReturnType<typeof useTheme>["palette"];
  typography: ReturnType<typeof useTheme>["typography"];
  spacing: ReturnType<typeof useTheme>["spacing"];
}) {
  const [hovered, setHovered] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const isVoice = room.roomType === VOICE_ROOM_TYPE;
  const isJoined = room.membership === "joined";
  const isInvited = room.membership === "invited";
  const canJoin = !isJoined;

  // const initials = room.name
  //   .split(" ")
  //   .map((w) => w[0])
  //   .join("")
  //   .slice(0, 2)
  //   .toUpperCase();

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={isJoined ? onClick : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: spacing.unit * 3,
        padding: `${spacing.unit * 2.5}px ${spacing.unit * 3}px`,
        borderRadius: spacing.unit * 1.5,
        cursor: isJoined ? "pointer" : "default",
        backgroundColor: hovered ? palette.bgHover : "transparent",
        transition: "background-color 0.1s",
      }}
    >
      {/* Room icon or avatar */}
      {room.avatarUrl && !imageFailed ? (
        <img
          src={room.avatarUrl}
          alt={room.name}
          onError={() => setImageFailed(true)}
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            objectFit: "cover",
            flexShrink: 0,
          }}
        />
      ) : (
        <div style={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          backgroundColor: palette.bgActive,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}>
          {isVoice ? (
            <Volume2 size={18} color={palette.textSecondary} />
          ) : (
            <Hash size={18} color={palette.textSecondary} />
          )}
        </div>
      )}

      {/* Room info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: spacing.unit,
        }}>
          <span style={{
            fontSize: typography.fontSizeBase,
            fontWeight: typography.fontWeightMedium,
            color: palette.textHeading,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {room.name}
          </span>
        </div>
        {room.topic && (
          <div style={{
            fontSize: typography.fontSizeSmall,
            color: palette.textSecondary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {room.topic}
          </div>
        )}
        <div style={{
          fontSize: typography.fontSizeSmall,
          color: palette.textSecondary,
          display: "flex",
          alignItems: "center",
          gap: spacing.unit,
          marginTop: 1,
        }}>
          <Users size={11} color={palette.textSecondary} />
          <span>{room.numJoinedMembers} member{room.numJoinedMembers !== 1 ? "s" : ""}</span>
        </div>
      </div>

      {/* Status / action */}
      <div style={{ flexShrink: 0 }}>
        {isJoined ? (
          <span style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit,
            fontSize: typography.fontSizeSmall,
            color: "#23a55a",
          }}>
            <Check size={14} />
            Joined
          </span>
        ) : isInvited ? (
          <button
            onClick={(e) => { e.stopPropagation(); onJoin(); }}
            disabled={isJoining}
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.unit,
              padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
              borderRadius: spacing.unit * 1.5,
              border: "none",
              backgroundColor: palette.accent,
              color: "#fff",
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightBold,
              cursor: isJoining ? "default" : "pointer",
              opacity: isJoining ? 0.7 : 1,
            }}
          >
            <Mail size={13} />
            {isJoining ? "Joining..." : "Accept"}
          </button>
        ) : canJoin ? (
          <button
            onClick={(e) => { e.stopPropagation(); onJoin(); }}
            disabled={isJoining}
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.unit,
              padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
              borderRadius: spacing.unit * 1.5,
              border: "none",
              backgroundColor: palette.accent,
              color: "#fff",
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightBold,
              cursor: isJoining ? "default" : "pointer",
              opacity: isJoining ? 0.7 : 1,
            }}
          >
            <LogIn size={13} />
            {isJoining ? "Joining..." : "Join"}
          </button>
        ) : null}
      </div>
    </div>
  );
}