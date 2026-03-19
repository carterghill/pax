import SpaceSidebar from "../components/SpaceSidebar";
import RoomSidebar from "../components/RoomSidebar";
import ChatView from "../layouts/ChatView";
import VoiceRoomView from "../components/VoiceRoomView";
import { useRooms } from "../hooks/useRooms";
import { usePresence } from "../hooks/usePresence";
import { useVoiceParticipants } from "../hooks/useVoiceParticipants";
import { useVoiceCall } from "../hooks/useVoiceCall";
import { PresenceContext } from "../hooks/PresenceContext";
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useTheme } from "../theme/ThemeContext";
import SettingsMenu from "../components/SettingsMenu";
import { VOICE_ROOM_TYPE, localpartFromUserId, normalizeUserId } from "../utils/matrix";

const ROOM_SIDEBAR_WIDTH_KEY = "pax-room-sidebar-width";
const USER_MENU_WIDTH_KEY = "pax-user-menu-width";
const MIN_ROOM_SIDEBAR_WIDTH = 180;
const MAX_ROOM_SIDEBAR_WIDTH = 400;
const MIN_USER_MENU_WIDTH = 180;
const MAX_USER_MENU_WIDTH = 400;
const MIN_CHAT_VIEW_WIDTH = 0; // chat can shrink; we reserve the user menu instead
const SPACE_SIDEBAR_WIDTH = 72;
const RESIZE_HANDLE = 6;
const USER_MENU_HANDLE = 6;

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

const extractMatrixUserId = (identity: string) => {
  const trimmed = identity.trim();
  if (!trimmed.startsWith("@")) return trimmed;
  // LiveKit identities can include transport/device suffixes (e.g. "|device"),
  // while the room sidebar list uses plain Matrix user IDs.
  const match = trimmed.match(/^@[^|/\s]+/);
  return match ? match[0] : trimmed;
};

interface MainLayoutProps {
  userId: string;
  onSignOut: () => void;
}

export default function MainLayout({ userId, onSignOut }: MainLayoutProps) {
  const { spaces, roomsBySpace, getRoom } = useRooms(userId);
  const { manualStatus, setManualStatus, effectivePresence } = usePresence();
  const voiceCall = useVoiceCall();
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [activeRoomBySpace, setActiveRoomBySpace] = useState<Record<string, string | null>>({});

  const spaceKey = activeSpaceId ?? "";
  const activeRoomId = activeRoomBySpace[spaceKey] ?? null;

  const setActiveRoomId = useCallback((roomId: string | null) => {
    setActiveRoomBySpace((prev) => ({ ...prev, [spaceKey]: roomId }));
  }, [spaceKey]);

  const { palette, spacing } = useTheme();
  const activeSpace = activeSpaceId ? getRoom(activeSpaceId) : null;

  // Resizable room sidebar width, persisted to localStorage
  const [roomSidebarWidth, setRoomSidebarWidth] = useState(() =>
    getStoredRoomSidebarWidth(spacing.sidebarWidth)
  );
  const [userMenuWidth, setUserMenuWidth] = useState(() => getStoredUserMenuWidth(240));
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const [isResizeHovered, setIsResizeHovered] = useState(false);

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
  const voiceCallParticipantStates = useMemo(
    () => {
      const stateMap: Record<string, { isMuted: boolean; isDeafened: boolean }> = {};
      for (const p of voiceCall.participants) {
        const state = { isMuted: p.isMuted, isDeafened: p.isDeafened };
        const mxid = extractMatrixUserId(p.identity);
        const keys = [
          p.identity,
          mxid,
          localpartFromUserId(mxid),
        ]
          .map(normalizeUserId)
          .filter(Boolean);
        for (const key of keys) {
          stateMap[key] = state;
        }
      }
      return stateMap;
    },
    [voiceCall.participants]
  );

  const { connect: connectVoiceCall, connectedRoomId: connectedVoiceRoomId } = voiceCall;

  // Handle room selection — clicking a voice room joins the call
  const handleSelectRoom = useCallback((roomId: string) => {
    setActiveRoomId(roomId);

    const room = getRoom(roomId);
    if (room && room.roomType === VOICE_ROOM_TYPE && connectedVoiceRoomId !== roomId) {
      // Join voice room on click (only if not already connected to this room)
      connectVoiceCall(roomId);
    }
  }, [setActiveRoomId, getRoom, connectedVoiceRoomId, connectVoiceCall]);

  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1200
  );
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const maxRoomSidebarWidth = Math.max(
    MIN_ROOM_SIDEBAR_WIDTH,
    viewportWidth - SPACE_SIDEBAR_WIDTH - RESIZE_HANDLE - MIN_CHAT_VIEW_WIDTH - USER_MENU_HANDLE - userMenuWidth
  );
  const effectiveRoomSidebarWidth = Math.min(roomSidebarWidth, maxRoomSidebarWidth);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = roomSidebarWidth;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startXRef.current;
      const next = Math.min(maxRoomSidebarWidth, Math.max(MIN_ROOM_SIDEBAR_WIDTH, startWidthRef.current + dx));
      setRoomSidebarWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [roomSidebarWidth, maxRoomSidebarWidth]);

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
          onSelectSpace={setActiveSpaceId}
        />
        <div style={{ display: "flex", flexShrink: 0 }}>
          <RoomSidebar
            width={effectiveRoomSidebarWidth}
            rooms={visibleRooms}
            activeRoomId={activeRoomId}
            onSelectRoom={handleSelectRoom}
            spaceName={activeSpace?.name ?? "Home"}
            userId={userId}
            voiceParticipants={voiceParticipants}
            connectedVoiceRoomId={voiceCall.connectedRoomId}
            isVoiceConnecting={voiceCall.isConnecting}
            disconnectingFromRoomId={voiceCall.disconnectingFromRoomId}
            screenSharingOwners={voiceCall.screenSharingOwners}
            voiceCallParticipantStates={voiceCallParticipantStates}
            onSetParticipantVolume={voiceCall.setParticipantVolume}
          />
          <div
            onMouseDown={handleResizeStart}
            onDoubleClick={() => setRoomSidebarWidth(spacing.sidebarWidth)}
            onMouseEnter={() => setIsResizeHovered(true)}
            onMouseLeave={() => setIsResizeHovered(false)}
            style={{
              width: 6,
              flexShrink: 0,
              cursor: "col-resize",
              backgroundColor: isResizeHovered ? palette.border : "transparent",
              transition: "background-color 0.15s",
            }}
            title="Drag to resize, double-click to reset"
          />
        </div>
        <main style={{
          flex: 1,
          minWidth: 0,
          backgroundColor: palette.bgPrimary,
          color: palette.textPrimary,
          display: "flex",
        }}>
          {activeRoomId === "settings" ? (
            <SettingsMenu onSignOut={onSignOut} />
          ) : activeRoom && activeRoom.roomType === VOICE_ROOM_TYPE ? (
            <VoiceRoomView
              room={activeRoom}
              callState={voiceCall}
              voiceParticipants={voiceParticipants[activeRoom.id] ?? []}
              userId={userId}
              onDisconnect={voiceCall.disconnect}
              onToggleMic={voiceCall.toggleMic}
              onToggleDeafen={voiceCall.toggleDeafen}
              onToggleNoiseSuppression={voiceCall.toggleNoiseSuppression}
              onStartScreenShare={voiceCall.startScreenShare}
              onEnumerateScreenShareWindows={voiceCall.enumerateScreenShareWindows}
              onStopScreenShare={voiceCall.stopScreenShare}
              onGetScreenSharePreset={voiceCall.getScreenSharePreset}
              onSetScreenSharePreset={voiceCall.setScreenSharePreset}
              onGetNoiseSuppressionConfig={voiceCall.getNoiseSuppressionConfig}
              onSetNoiseSuppressionConfig={voiceCall.setNoiseSuppressionConfig}
              onSetParticipantVolume={voiceCall.setParticipantVolume}
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