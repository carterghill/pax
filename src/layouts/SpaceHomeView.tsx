import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Hash, Volume2, Users, LogIn, Check, Mail, RefreshCw, Plus, X, Loader2 } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { Room } from "../types/matrix";
import type { RoomsChangedPayload } from "../types/roomsChanged";
import { VOICE_ROOM_TYPE } from "../utils/matrix";
import {
  spaceInitialAvatarBackground,
  userInitialAvatarBackground,
} from "../utils/userAvatarColor";
import CreateRoomDialog from "../components/CreateRoomDialog";
import type { SpaceChildInfo, SpaceInfo } from "../utils/spaceHomeCache";
import { getCachedSpaceInfo, setCachedSpaceInfo } from "../utils/spaceHomeCache";

interface SpaceHomeViewProps {
  space: Room;
  onSelectRoom: (roomId: string) => void;
  onRoomsChanged: (payload?: RoomsChangedPayload) => void | Promise<void>;
}

function mergeCreatedChildIntoSpaceInfo(
  prev: SpaceInfo,
  room: Room,
  topic: string | null
): SpaceInfo {
  const child: SpaceChildInfo = {
    id: room.id,
    name: room.name,
    topic,
    avatarUrl: room.avatarUrl,
    membership: "joined",
    joinRule: null,
    roomType: room.roomType,
    numJoinedMembers: 1,
  };
  const others = prev.children.filter((c) => c.id !== child.id);
  return { ...prev, children: [child, ...others] };
}

function mergeJoinedChildIntoSpaceInfo(prev: SpaceInfo, roomId: string): SpaceInfo {
  return {
    ...prev,
    children: prev.children.map((c) =>
      c.id === roomId ? { ...c, membership: "joined" as const } : c
    ),
  };
}

type FetchSpaceInfoOptions = {
  /** If true, keep showing existing UI and refresh in the background (no full-page loading state). */
  background?: boolean;
};

interface KnockMember {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  reason: string | null;
}

interface KnockData {
  members: KnockMember[];
  canInvite: boolean;
  canKick: boolean;
}

export default function SpaceHomeView({ space, onSelectRoom, onRoomsChanged }: SpaceHomeViewProps) {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();
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

  // ── Knock requests ──
  const [knockData, setKnockData] = useState<KnockData | null>(null);
  const [knockActionId, setKnockActionId] = useState<string | null>(null);

  const fetchInfo = useCallback((options?: FetchSpaceInfoOptions) => {
    const requestedId = space.id;
    const background = options?.background ?? false;

    if (!background) {
      setLoading(true);
      setError(null);
    }

    invoke<SpaceInfo>("get_space_info", { spaceId: requestedId })
      .then((data) => {
        setCachedSpaceInfo(requestedId, data);
        if (activeSpaceIdRef.current !== requestedId) return;
        setInfo(data);
        if (!background) setError(null);
      })
      .catch((e) => {
        if (activeSpaceIdRef.current !== requestedId) return;
        if (background) {
          console.error("Background space home refresh failed:", e);
          return;
        }
        console.error("Failed to fetch space info:", e);
        setError(String(e));
      })
      .finally(() => {
        if (activeSpaceIdRef.current !== requestedId) return;
        if (!background) setLoading(false);
      });
  }, [space.id]);

  useEffect(() => {
    setJoiningRoomId(null);
    setShowCreateRoom(false);

    const cached = getCachedSpaceInfo(space.id);
    if (cached) {
      setInfo(cached);
      setError(null);
      setLoading(false);
      fetchInfo({ background: true });
    } else {
      setInfo(null);
      setError(null);
      setLoading(true);
      fetchInfo();
    }
  }, [space.id, fetchInfo]);

  // Check whether the user can add rooms to this space
  useEffect(() => {
    if (permCheckedRef.current === space.id) return;
    permCheckedRef.current = space.id;
    invoke<boolean>("can_manage_space_children", { spaceId: space.id })
      .then(setCanManageChildren)
      .catch(() => setCanManageChildren(false));
  }, [space.id]);

  // ── Fetch knock requests for this space ──
  const fetchKnocks = useCallback(() => {
    const target = space.id;
    invoke<KnockData>("get_knock_members", { roomId: target })
      .then((result) => {
        if (activeSpaceIdRef.current === target) setKnockData(result);
      })
      .catch(() => {
        if (activeSpaceIdRef.current === target) {
          setKnockData({ members: [], canInvite: false, canKick: false });
        }
      });
  }, [space.id]);

  useEffect(() => {
    setKnockData(null);
    fetchKnocks();
  }, [space.id, fetchKnocks]);

  // Refetch knocks on membership changes
  useEffect(() => {
    const unlisten = listen("rooms-changed", () => { fetchKnocks(); });
    return () => { unlisten.then((fn) => fn()); };
  }, [fetchKnocks]);

  const handleAcceptKnock = useCallback(async (knockUserId: string) => {
    setKnockActionId(knockUserId);
    try {
      await invoke("invite_user", { roomId: space.id, userId: knockUserId });
      setKnockData((prev) =>
        prev ? { ...prev, members: prev.members.filter((m) => m.userId !== knockUserId) } : prev
      );
    } catch (e) {
      console.error("Failed to accept knock:", e);
    } finally {
      setKnockActionId(null);
    }
  }, [space.id]);

  const handleDenyKnock = useCallback(async (knockUserId: string) => {
    setKnockActionId(knockUserId);
    try {
      await invoke("kick_user", { roomId: space.id, userId: knockUserId, reason: "Join request denied" });
      setKnockData((prev) =>
        prev ? { ...prev, members: prev.members.filter((m) => m.userId !== knockUserId) } : prev
      );
    } catch (e) {
      console.error("Failed to deny knock:", e);
    } finally {
      setKnockActionId(null);
    }
  }, [space.id]);

  // When `get_rooms` includes `topic` (after sync / space settings), merge into space home state.
  // Skip if `topic` is absent on `Room` so we don't clear data from `get_space_info`.
  useEffect(() => {
    if (space.topic === undefined) return;
    const t = (space.topic ?? "").trim() || null;
    setInfo((prev) => {
      if (!prev) return prev;
      const prevT = prev.topic?.trim() || null;
      if (prevT === t) return prev;
      const next = { ...prev, topic: t };
      setCachedSpaceInfo(space.id, next);
      return next;
    });
  }, [space.id, space.topic]);

  async function handleJoinRoom(roomId: string) {
    setJoiningRoomId(roomId);
    const childMeta = info?.children.find((c) => c.id === roomId);
    try {
      await invoke("join_room", { roomId });
      const optimisticRoom: Room = {
        id: roomId,
        name: childMeta?.name ?? roomId,
        avatarUrl: childMeta?.avatarUrl ?? null,
        isSpace: false,
        parentSpaceIds: [space.id],
        roomType: childMeta?.roomType ?? null,
        membership: "joined",
      };
      await onRoomsChanged({ optimisticRoom });
      setInfo((prev) => {
        if (!prev) return prev;
        const next = mergeJoinedChildIntoSpaceInfo(prev, roomId);
        setCachedSpaceInfo(space.id, next);
        return next;
      });
      fetchInfo({ background: true });
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
          onClick={() => fetchInfo()}
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
  const spaceDescription = (info.topic ?? "").trim();

  return (
    <div style={{
      flex: 1,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    }}>
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
              backgroundColor: spaceInitialAvatarBackground(space.id, resolvedColorScheme),
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
          {spaceDescription ? (
            <div style={{
              fontSize: typography.fontSizeBase,
              color: palette.textSecondary,
              textAlign: "center",
              maxWidth: 500,
              lineHeight: typography.lineHeight,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}>
              {spaceDescription}
            </div>
          ) : null}
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

        {/* ── Join Requests ── */}
        {knockData && knockData.members.length > 0 && (knockData.canInvite || knockData.canKick) && (
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
              Join Requests — {knockData.members.length}
            </div>
            <div style={{
              display: "flex",
              flexDirection: "column",
              gap: spacing.unit,
            }}>
              {knockData.members.map((knock) => {
                const isActing = knockActionId === knock.userId;
                return (
                  <KnockRow
                    key={knock.userId}
                    knock={knock}
                    isActing={isActing}
                    canInvite={knockData.canInvite}
                    canKick={knockData.canKick}
                    onAccept={() => handleAcceptKnock(knock.userId)}
                    onDeny={() => handleDenyKnock(knock.userId)}
                    palette={palette}
                    typography={typography}
                    spacing={spacing}
                    resolvedColorScheme={resolvedColorScheme}
                  />
                );
              })}
            </div>
          </div>
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
          onCreated={async (payload) => {
            await onRoomsChanged(payload);
            if (payload?.optimisticRoom) {
              setInfo((prev) => {
                if (!prev) return prev;
                const next = mergeCreatedChildIntoSpaceInfo(
                  prev,
                  payload.optimisticRoom!,
                  payload.newSpaceChildTopic ?? null
                );
                setCachedSpaceInfo(space.id, next);
                return next;
              });
            }
            fetchInfo({ background: true });
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

function KnockRow({
  knock,
  isActing,
  canInvite,
  canKick,
  onAccept,
  onDeny,
  palette,
  typography,
  spacing,
  resolvedColorScheme,
}: {
  knock: { userId: string; displayName: string | null; avatarUrl: string | null; reason: string | null };
  isActing: boolean;
  canInvite: boolean;
  canKick: boolean;
  onAccept: () => void;
  onDeny: () => void;
  palette: ReturnType<typeof useTheme>["palette"];
  typography: ReturnType<typeof useTheme>["typography"];
  spacing: ReturnType<typeof useTheme>["spacing"];
  resolvedColorScheme: ReturnType<typeof useTheme>["resolvedColorScheme"];
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: spacing.unit * 3,
        padding: `${spacing.unit * 2.5}px ${spacing.unit * 3}px`,
        borderRadius: spacing.unit * 1.5,
        backgroundColor: hovered ? palette.bgHover : "transparent",
        transition: "background-color 0.1s",
      }}
    >
      {/* Avatar */}
      {knock.avatarUrl ? (
        <img
          src={knock.avatarUrl}
          alt={knock.displayName ?? knock.userId}
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
          backgroundColor: userInitialAvatarBackground(knock.userId, resolvedColorScheme),
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          fontSize: typography.fontSizeSmall,
          fontWeight: typography.fontWeightBold,
        }}>
          {(knock.displayName ?? knock.userId).charAt(0).toUpperCase()}
        </div>
      )}

      {/* Name + reason */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{
          fontSize: typography.fontSizeBase,
          fontWeight: typography.fontWeightMedium,
          color: palette.textHeading,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {knock.displayName ?? knock.userId}
        </span>
        {knock.reason && (
          <div style={{
            fontSize: typography.fontSizeSmall,
            color: palette.textSecondary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {knock.reason}
          </div>
        )}
      </div>

      {/* Accept / Deny */}
      <div style={{ display: "flex", gap: spacing.unit, flexShrink: 0 }}>
        {canInvite && (
          <button
            onClick={onAccept}
            disabled={isActing}
            title="Accept"
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.unit,
              padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
              borderRadius: spacing.unit * 1.5,
              border: "none",
              backgroundColor: "#23a55a",
              color: "#fff",
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightBold,
              cursor: isActing ? "default" : "pointer",
              opacity: isActing ? 0.7 : 1,
            }}
          >
            {isActing ? (
              <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
            ) : (
              <Check size={13} />
            )}
            Accept
          </button>
        )}
        {canKick && (
          <button
            onClick={onDeny}
            disabled={isActing}
            title="Deny"
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.unit,
              padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
              borderRadius: spacing.unit * 1.5,
              border: "none",
              backgroundColor: "#ed4245",
              color: "#fff",
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightBold,
              cursor: isActing ? "default" : "pointer",
              opacity: isActing ? 0.7 : 1,
            }}
          >
            <X size={13} />
            Deny
          </button>
        )}
      </div>
    </div>
  );
}