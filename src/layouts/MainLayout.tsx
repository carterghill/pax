import SpaceSidebar from "../components/SpaceSidebar";
import RoomSidebar from "../components/RoomSidebar";
import ChatView from "../layouts/ChatView";
import VoiceRoomView from "../components/VoiceRoomView";
import InvitationView from "../layouts/InvitationView";
import SpaceHomeView from "../layouts/SpaceHomeView";
import type { RoomsForLayout } from "../hooks/useRooms";
import { usePresence } from "../hooks/usePresence";
import { useVoiceParticipants } from "../hooks/useVoiceParticipants";
import { useVoiceCall } from "../hooks/useVoiceCall";
import { PresenceContext } from "../hooks/PresenceContext";
import { useState, useCallback, useMemo, useEffect } from "react";
import { useTheme } from "../theme/ThemeContext";
import SettingsMenu from "../components/SettingsMenu";
import {
  VOICE_ROOM_TYPE,
  voiceStateLookupKeysForLiveKitIdentity,
} from "../utils/matrix";
import { useLivekitVoiceSnapshots } from "../hooks/useLivekitVoiceSnapshots";
import { useUserAvatar } from "../hooks/useUserAvatar";
import { useResizeHandle } from "../hooks/useResizeHandle";

const ROOM_SIDEBAR_WIDTH_KEY = "pax-room-sidebar-width";
const USER_MENU_WIDTH_KEY = "pax-user-menu-width";
const MIN_ROOM_SIDEBAR_WIDTH = 180;
const MAX_ROOM_SIDEBAR_WIDTH = 400;
const MIN_USER_MENU_WIDTH = 180;
const MAX_USER_MENU_WIDTH = 400;
const MIN_CHAT_VIEW_WIDTH = 200;
const SPACE_SIDEBAR_WIDTH = 72;
const ROOM_SIDEBAR_RESIZE_HANDLE = 6;

function getStoredUserMenuWidth(defaultWidth: number): number {
  try {
    const raw = localStorage.getItem(USER_MENU_WIDTH_KEY);
    if (raw !== null) {
      const val = parseInt(raw, 10);
      if (!isNaN(val) && val >= 180 && val <= 400) return val;
    }
  } catch {
    /* localStorage may be unavailable */
  }
  return defaultWidth;
}

function getStoredRoomSidebarWidth(defaultWidth: number): number {
  try {
    const raw = localStorage.getItem(ROOM_SIDEBAR_WIDTH_KEY);
    if (raw !== null) {
      const val = parseInt(raw, 10);
      if (!isNaN(val) && val >= MIN_ROOM_SIDEBAR_WIDTH && val <= MAX_ROOM_SIDEBAR_WIDTH) return val;
    }
  } catch {
    /* localStorage may be unavailable */
  }
  return defaultWidth;
}

function storeRoomSidebarWidth(width: number) {
  try {
    localStorage.setItem(ROOM_SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    /* ignore */
  }
}

function storeUserMenuWidth(width: number) {
  try {
    localStorage.setItem(USER_MENU_WIDTH_KEY, String(width));
  } catch {
    /* ignore */
  }
}

interface MainLayoutProps {
  userId: string;
  onSignOut: () => void;
  rooms: RoomsForLayout;
}

export default function MainLayout({ userId, onSignOut, rooms: { spaces, roomsBySpace, getRoom, fetchRooms } }: MainLayoutProps) {
  const { manualStatus, setManualStatus, effectivePresence } = usePresence();
  const voiceCall = useVoiceCall();
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [activeRoomBySpace, setActiveRoomBySpace] = useState<Record<string, string | null>>({});

  const spaceKey = activeSpaceId ?? "";
  const activeRoomId = activeRoomBySpace[spaceKey] ?? null;

  const setActiveRoomId = useCallback((roomId: string | null) => {
    setActiveRoomBySpace((prev) => ({ ...prev, [spaceKey]: roomId }));
  }, [spaceKey]);

  // Clicking the already-active space clears room selection to show the space home
  const handleSelectSpace = useCallback((spaceId: string) => {
    const id = spaceId || null;
    if (id === activeSpaceId) {
      // Re-clicking same space: clear room selection
      setActiveRoomBySpace((prev) => ({ ...prev, [spaceId || ""]: null }));
    }
    setActiveSpaceId(id);
  }, [activeSpaceId]);

  const { palette, spacing } = useTheme();
  const activeSpace = activeSpaceId ? getRoom(activeSpaceId) : null;
  const fetchedAvatarUrl = useUserAvatar();
  const [avatarOverride, setAvatarOverride] = useState<string | null | undefined>(undefined);
  const userAvatarUrl = avatarOverride !== undefined ? avatarOverride : fetchedAvatarUrl;

  // Resizable room sidebar width, persisted to localStorage
  const [roomSidebarWidth, setRoomSidebarWidth] = useState(() =>
    getStoredRoomSidebarWidth(spacing.sidebarWidth)
  );
  const [userMenuWidth, setUserMenuWidth] = useState(() => getStoredUserMenuWidth(240));

  const sidebarResize = useResizeHandle({
    width: roomSidebarWidth,
    onWidthChange: setRoomSidebarWidth,
    min: MIN_ROOM_SIDEBAR_WIDTH,
    max: () => Math.min(
      MAX_ROOM_SIDEBAR_WIDTH,
      window.innerWidth - SPACE_SIDEBAR_WIDTH - MIN_CHAT_VIEW_WIDTH - userMenuWidth
    ),
  });

  useEffect(() => {
    storeRoomSidebarWidth(roomSidebarWidth);
  }, [roomSidebarWidth]);
  useEffect(() => {
    storeUserMenuWidth(userMenuWidth);
  }, [userMenuWidth]);

  const visibleRooms = roomsBySpace(activeSpaceId);
  const activeRoom = activeRoomId ? getRoom(activeRoomId) : null;

  // Collect voice room IDs in the current space for participant tracking
  const voiceRoomIds = useMemo(
    () => visibleRooms.filter((r) => r.roomType === VOICE_ROOM_TYPE).map((r) => r.id),
    [visibleRooms]
  );
  const voiceParticipants = useVoiceParticipants(voiceRoomIds);
  const livekitByRoom = useLivekitVoiceSnapshots(voiceRoomIds);
  const voiceParticipantStatesByRoom = useMemo(() => {
    type VoiceRowState = {
      isMuted: boolean;
      isDeafened: boolean;
      isSpeaking: boolean;
    };
    const byRoom: Record<string, Record<string, VoiceRowState>> = {};
    for (const rid of voiceRoomIds) {
      byRoom[rid] = {};
      for (const lp of livekitByRoom[rid] ?? []) {
        const st: VoiceRowState = {
          isMuted: lp.isMuted,
          isDeafened: lp.isDeafened,
          isSpeaking: lp.isSpeaking,
        };
        for (const key of voiceStateLookupKeysForLiveKitIdentity(lp.identity)) {
          byRoom[rid][key] = st;
        }
      }
    }
    const cr = voiceCall.connectedRoomId;
    if (cr) {
      if (!byRoom[cr]) {
        byRoom[cr] = {};
      }
      for (const p of voiceCall.participants) {
        const st: VoiceRowState = {
          isMuted: p.isMuted,
          isDeafened: p.isDeafened,
          isSpeaking: p.isSpeaking,
        };
        for (const key of voiceStateLookupKeysForLiveKitIdentity(p.identity)) {
          byRoom[cr][key] = st;
        }
      }
    }
    return byRoom;
  }, [
    voiceRoomIds,
    livekitByRoom,
    voiceCall.participants,
    voiceCall.connectedRoomId,
  ]);

  const { connect: connectVoiceCall, connectedRoomId: connectedVoiceRoomId } = voiceCall;

  // Handle room selection — clicking a voice room joins the call (only if already joined/member)
  const handleSelectRoom = useCallback((roomId: string) => {
    setActiveRoomId(roomId);

    const room = getRoom(roomId);
    if (room && room.roomType === VOICE_ROOM_TYPE && room.membership === "joined" && connectedVoiceRoomId !== roomId) {
      // Join voice room on click (only if not already connected to this room)
      connectVoiceCall(roomId);
    }
  }, [setActiveRoomId, getRoom, connectedVoiceRoomId, connectVoiceCall]);

  return (
    <PresenceContext.Provider value={{ manualStatus, setManualStatus, effectivePresence }}>
      <div style={{
        display: "flex",
        height: "100vh",
        width: "100%",
        minWidth: 0,
        maxWidth: "100vw",
        overflow: "hidden",
      }}>
        <SpaceSidebar
          spaces={spaces}
          activeSpaceId={activeSpaceId}
          onSelectSpace={handleSelectSpace}
          onSpacesChanged={fetchRooms}
        />
        <div style={{ position: "relative", flexShrink: 0, zIndex: 1 }}>
          <RoomSidebar
            width={roomSidebarWidth}
            rooms={visibleRooms}
            activeRoomId={activeRoomId}
            onSelectRoom={handleSelectRoom}
            onSelectSpaceHome={() => setActiveRoomId(null)}
            isSpaceHomeActive={
              activeRoomId === null &&
              !!activeSpace &&
              activeSpace.membership === "joined"
            }
            showSpaceHomeNav={!!activeSpace && activeSpace.membership === "joined"}
            spaceName={activeSpace?.name ?? "Home"}
            userId={userId}
            userAvatarUrl={userAvatarUrl}
            voiceParticipants={voiceParticipants}
            connectedVoiceRoomId={voiceCall.connectedRoomId}
            isVoiceConnecting={voiceCall.isConnecting}
            disconnectingFromRoomId={voiceCall.disconnectingFromRoomId}
            screenSharingOwners={voiceCall.screenSharingOwners}
            voiceParticipantStatesByRoom={voiceParticipantStatesByRoom}
            onSetParticipantVolume={voiceCall.setParticipantVolume}
          />
          <div
            onMouseDown={sidebarResize.onMouseDown}
            onDoubleClick={() => setRoomSidebarWidth(spacing.sidebarWidth)}
            onMouseEnter={() => sidebarResize.setIsHovered(true)}
            onMouseLeave={() => sidebarResize.setIsHovered(false)}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              right: -(ROOM_SIDEBAR_RESIZE_HANDLE / 2),
              width: ROOM_SIDEBAR_RESIZE_HANDLE,
              cursor: "col-resize",
              backgroundColor: sidebarResize.isHovered ? palette.border : "transparent",
              transition: "background-color 0.15s",
              zIndex: 2,
            }}
            title="Drag to resize, double-click to reset"
          />
        </div>
        <main style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          backgroundColor: palette.bgPrimary,
          color: palette.textPrimary,
          display: "flex",
        }}>
          {activeRoomId === "settings" ? (
            <SettingsMenu
              onSignOut={onSignOut}
              userAvatarUrl={userAvatarUrl}
              onAvatarChanged={setAvatarOverride}
              voiceCall={voiceCall}
            />
          ) : activeRoom && activeRoom.membership === "invited" ? (
            <InvitationView room={activeRoom} onJoined={fetchRooms} />
          ) : activeRoom && activeRoom.roomType === VOICE_ROOM_TYPE ? (
            <VoiceRoomView
              room={activeRoom}
              voiceCall={voiceCall}
              voiceParticipants={voiceParticipants[activeRoom.id] ?? []}
              livekitInRoom={livekitByRoom[activeRoom.id] ?? []}
              userId={userId}
            />
          ) : activeRoom ? (
            <ChatView
              room={activeRoom}
              userId={userId}
              userMenuWidth={userMenuWidth}
              onUserMenuWidthChange={(next: number) => {
                const clamped = Math.max(MIN_USER_MENU_WIDTH, Math.min(MAX_USER_MENU_WIDTH, next));
                setUserMenuWidth(clamped);
              }}
            />
          ) : activeSpace && activeSpace.membership === "invited" ? (
            <InvitationView room={activeSpace} onJoined={fetchRooms} />
          ) : activeSpace && activeSpace.membership === "joined" ? (
            <SpaceHomeView
              space={activeSpace}
              onSelectRoom={handleSelectRoom}
              onRoomsChanged={fetchRooms}
            />
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
    </PresenceContext.Provider>
  );
}