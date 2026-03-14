import SpaceSidebar from "../components/SpaceSidebar";
import RoomSidebar from "../components/RoomSidebar";
import ChatView from "../layouts/ChatView";
import VoiceRoomView from "../components/VoiceRoomView";
import { useRooms } from "../hooks/useRooms";
import { usePresence } from "../hooks/usePresence";
import { useVoiceParticipants } from "../hooks/useVoiceParticipants";
import { useVoiceCall } from "../hooks/useVoiceCall";
import { PresenceContext } from "../hooks/PresenceContext";
import { useState, useCallback, useMemo } from "react";
import { useTheme } from "../theme/ThemeContext";
import SettingsMenu from "../components/SettingsMenu";
import { VOICE_ROOM_TYPE, localpartFromUserId, normalizeUserId } from "../utils/matrix";
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

  const { palette } = useTheme();
  const activeSpace = activeSpaceId ? getRoom(activeSpaceId) : null;
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

  return (
    <PresenceContext.Provider value={{ manualStatus, setManualStatus, effectivePresence }}>
      <div style={{ display: "flex", height: "100vh" }}>
        <SpaceSidebar
          spaces={spaces}
          activeSpaceId={activeSpaceId}
          onSelectSpace={setActiveSpaceId}
        />
        <RoomSidebar
          rooms={visibleRooms}
          activeRoomId={activeRoomId}
          onSelectRoom={handleSelectRoom}
          spaceName={activeSpace?.name ?? "Home"}
          userId={userId}
          voiceParticipants={voiceParticipants}
          connectedVoiceRoomId={voiceCall.connectedRoomId}
          isVoiceConnecting={voiceCall.isConnecting}
          screenSharingOwner={voiceCall.screenSharingOwner}
          voiceCallParticipantStates={voiceCallParticipantStates}
          onSetParticipantVolume={voiceCall.setParticipantVolume}
        />
        <main style={{
          flex: 1,
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
            <ChatView room={activeRoom} userId={userId} />
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