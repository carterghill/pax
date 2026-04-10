import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Hash, House, Volume2, Monitor, MicOff, Headphones, Slash, Loader2, UserPlus } from "lucide-react";
import { Room, VoiceParticipant } from "../types/matrix";
import { useTheme } from "../theme/ThemeContext";
import StatusDropdown from "./StatusDropdown";
import VolumeContextMenu from "./VolumeContextMenu";
import RoomContextMenu from "./RoomContextMenu";
import RoomSettingsModal from "./RoomSettingsModal";
import InviteDialog from "./InviteDialog";
import LeaveConfirmDialog from "./LeaveConfirmDialog";
import { useUserVolume } from "../hooks/useUserVolume";
import {
  VOICE_ROOM_TYPE,
  voiceStateLookupKeysForParticipant,
} from "../utils/matrix";

function resolveVoiceStateForRoom(
  participant: VoiceParticipant,
  roomStateMap: Record<
    string,
    { isMuted: boolean; isDeafened: boolean; isSpeaking: boolean }
  >
) {
  for (const key of voiceStateLookupKeysForParticipant(participant)) {
    const state = roomStateMap[key];
    if (state) return state;
  }
  return undefined;
}

interface RoomSidebarProps {
  width: number;
  rooms: Room[];
  activeRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  /** Clears room selection so the joined space home is shown (same as re-clicking the space). */
  onSelectSpaceHome: () => void;
  isSpaceHomeActive: boolean;
  showSpaceHomeNav: boolean;
  spaceName: string;
  /** When set, show an invite button in the header for this space (Matrix room id). */
  spaceInviteId?: string | null;
  userId: string;
  userAvatarUrl: string | null;
  voiceParticipants: Record<string, VoiceParticipant[]>;
  connectedVoiceRoomId: string | null;
  isVoiceConnecting: boolean;
  disconnectingFromRoomId: string | null;
  screenSharingOwners: string[];
  /** Per Matrix voice room id: lookup keys → mute/deafen/speaking (LiveKit snapshot + in-call overlay). */
  voiceParticipantStatesByRoom: Record<
    string,
    Record<string, { isMuted: boolean; isDeafened: boolean; isSpeaking: boolean }>
  >;
  onSetParticipantVolume: (identity: string, volume: number, source: string) => void;
  /** Called after successfully leaving a room from the context menu */
  onLeftRoom?: (roomId: string) => void;
}

function VoiceParticipantRow({
  participant,
  isLocalUser,
  isSharingScreen,
  isMuted,
  isDeafened,
  isSpeaking,
  isConnecting,
  onContextMenu,
}: {
  participant: VoiceParticipant;
  isLocalUser: boolean;
  isSharingScreen: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
  isConnecting: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { palette, spacing, typography } = useTheme();
  const name = participant.displayName ?? participant.userId;

  return (
    <div
      onContextMenu={(e) => {
        if (!isLocalUser) {
          e.preventDefault();
          onContextMenu(e);
        }
      }}
      style={{
      display: "flex",
      alignItems: "center",
      gap: spacing.unit * 2,
      padding: `${spacing.unit}px ${spacing.unit * 3}px ${spacing.unit}px ${spacing.unit * 8}px`,
      fontSize: typography.fontSizeSmall,
      color: palette.textSecondary,
      cursor: isLocalUser ? "default" : "context-menu",
    }}>
      {participant.avatarUrl ? (
        <img
          src={participant.avatarUrl}
          alt={name}
          style={{
            display: "block",
            width: 20,
            height: 20,
            borderRadius: "50%",
            objectFit: "cover",
            flexShrink: 0,
            boxSizing: "border-box",
            boxShadow: isSpeaking ? "0 0 0 2px #23a55a" : "none",
            transition: "box-shadow 0.15s ease",
          }}
        />
      ) : (
        <div style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          backgroundColor: palette.accent,
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10,
          fontWeight: typography.fontWeightBold,
          flexShrink: 0,
          boxSizing: "border-box",
          boxShadow: isSpeaking ? "0 0 0 2px #23a55a" : "none",
          transition: "box-shadow 0.15s ease",
        }}>
          {name.charAt(0).toUpperCase()}
        </div>
      )}
      <span style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "flex",
        alignItems: "center",
        minWidth: 0,
        flex: 1,
      }}>
        {name}
      </span>
      <span style={{
        marginLeft: "auto",
        display: "flex",
        alignItems: "center",
        gap: spacing.unit,
        flexShrink: 0,
      }}>
        {isConnecting && (
          <Loader2
            size={12}
            color={palette.textSecondary}
            style={{ animation: "spin 1s linear infinite" }}
          />
        )}
        {isSharingScreen && <Monitor size={12} color="#23a55a" />}
        {isMuted && <MicOff size={12} color={palette.textSecondary} />}
        {isDeafened && (
          <span style={{ position: "relative", width: 12, height: 12, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            <Headphones size={12} color={palette.textSecondary} />
            <Slash size={10} color={palette.textSecondary} style={{ position: "absolute" }} />
          </span>
        )}
      </span>
    </div>
  );
}

export default function RoomSidebar({
  width,
  rooms,
  activeRoomId,
  onSelectRoom,
  onSelectSpaceHome,
  isSpaceHomeActive,
  showSpaceHomeNav,
  spaceName,
  spaceInviteId,
  userId,
  userAvatarUrl,
  voiceParticipants,
  connectedVoiceRoomId,
  isVoiceConnecting,
  disconnectingFromRoomId,
  screenSharingOwners,
  voiceParticipantStatesByRoom,
  onSetParticipantVolume,
  onLeftRoom,
}: RoomSidebarProps) {
  const { palette, spacing, typography } = useTheme();
  const { getVolume, setVolume } = useUserVolume();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    identity: string;
    displayName: string;
  } | null>(null);
  const [roomContextMenu, setRoomContextMenu] = useState<{
    x: number;
    y: number;
    roomId: string;
    roomName: string;
  } | null>(null);
  const [settingsRoomId, setSettingsRoomId] = useState<string | null>(null);
  const [inviteRoom, setInviteRoom] = useState<{ id: string; name: string } | null>(null);
  const [inviteSpaceFromHeader, setInviteSpaceFromHeader] = useState<{ id: string; name: string } | null>(
    null
  );
  const [leaveRoom, setLeaveRoom] = useState<{ id: string; name: string } | null>(null);
  const [leaveRoomError, setLeaveRoomError] = useState<string | null>(null);
  const [leaveRoomSubmitting, setLeaveRoomSubmitting] = useState(false);
  const settingsRoom = settingsRoomId
    ? rooms.find((r) => r.id === settingsRoomId)
    : null;

  // Extract local part of userId for display (e.g. @carter:matrix.org → carter)
  const displayName = userId.startsWith("@")
    ? userId.slice(1).split(":")[0]
    : userId;

  const handleConfirmLeaveRoom = useCallback(async () => {
    if (!leaveRoom) return;
    setLeaveRoomError(null);
    setLeaveRoomSubmitting(true);
    try {
      await invoke("leave_room", { roomId: leaveRoom.id });
      onLeftRoom?.(leaveRoom.id);
      setLeaveRoom(null);
    } catch (e) {
      setLeaveRoomError(String(e));
    } finally {
      setLeaveRoomSubmitting(false);
    }
  }, [leaveRoom, onLeftRoom]);

  return (
    <div style={{
      width,
      minWidth: width,
      backgroundColor: palette.bgSecondary,
      borderRight: `1px solid ${palette.border}`,
      display: "flex",
      flexDirection: "column",
      height: "100vh",
    }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: spacing.unit * 2,
          paddingTop: spacing.unit * 4,
          paddingBottom: spacing.unit * 4,
          paddingLeft: spacing.unit * 4,
          paddingRight: spacing.unit * 2,
          height: spacing.headerHeight,
          borderBottom: `1px solid ${palette.border}`,
          boxSizing: "border-box",
          minHeight: spacing.headerHeight,
        }}
      >
        <h2
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: typography.fontSizeLarge,
            fontWeight: typography.fontWeightBold,
            color: palette.textHeading,
            margin: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {spaceName}
        </h2>
        {spaceInviteId ? (
          <button
            type="button"
            title="Invite people to this space"
            aria-label="Invite people to this space"
            onClick={() =>
              setInviteSpaceFromHeader({ id: spaceInviteId, name: spaceName })
            }
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: 0,
              padding: spacing.unit * 1.5,
              border: "none",
              borderRadius: 6,
              backgroundColor: "transparent",
              color: palette.textSecondary,
              cursor: "pointer",
              lineHeight: 0,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = palette.bgActive;
              (e.currentTarget as HTMLButtonElement).style.color = palette.textPrimary;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = palette.textSecondary;
            }}
          >
            <UserPlus size={20} strokeWidth={2} aria-hidden />
          </button>
        ) : null}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: spacing.unit * 2 }}>
        {showSpaceHomeNav && (
          <div style={{ marginBottom: spacing.unit }}>
            <div
              onClick={() => onSelectSpaceHome()}
              style={{
                padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
                borderRadius: spacing.unit,
                cursor: "pointer",
                color: isSpaceHomeActive ? palette.textHeading : palette.textSecondary,
                backgroundColor: isSpaceHomeActive ? palette.bgActive : "transparent",
                fontSize: typography.fontSizeBase,
                fontWeight: isSpaceHomeActive
                  ? typography.fontWeightMedium
                  : typography.fontWeightNormal,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: spacing.unit }}>
                <House
                  size={16}
                  color="currentColor"
                  fill={isSpaceHomeActive ? "currentColor" : "none"}
                  strokeWidth={isSpaceHomeActive ? 0 : 2}
                />
                <div style={{ marginLeft: spacing.unit }}>Home</div>
              </span>
            </div>
          </div>
        )}
        {rooms.map((room) => {
          const isVoice = room.roomType === VOICE_ROOM_TYPE;
          const participants = isVoice ? (voiceParticipants[room.id] ?? []) : [];
          const isConnectedHere = connectedVoiceRoomId === room.id;

          return (
            <div key={room.id}>
              {/* Room row */}
              <div
                onClick={() => onSelectRoom(room.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setRoomContextMenu({
                    x: e.clientX,
                    y: e.clientY,
                    roomId: room.id,
                    roomName: room.name,
                  });
                }}
                style={{
                  padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
                  borderRadius: spacing.unit,
                  cursor: "pointer",
                  color: activeRoomId === room.id ? palette.textHeading : palette.textSecondary,
                  backgroundColor: activeRoomId === room.id ? palette.bgActive : "transparent",
                  fontSize: typography.fontSizeBase,
                  fontWeight: activeRoomId === room.id
                    ? typography.fontWeightMedium
                    : typography.fontWeightNormal,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: spacing.unit }}>
                  {isVoice ? (
                    <Volume2
                      size={16}
                      color={isConnectedHere ? "#23a55a" : (activeRoomId === room.id ? palette.textHeading : palette.textSecondary)}
                    />
                  ) : (
                    <Hash size={16} color={activeRoomId === room.id ? palette.textHeading : palette.textSecondary} />
                  )}
                  <div style={{
                    marginLeft: spacing.unit,
                    color: isConnectedHere ? "#23a55a" : undefined,
                  }}>
                    {room.name}
                  </div>
                </span>
              </div>

              {/* Voice participants listed under the voice room */}
              {isVoice && participants.length > 0 && (
                <div style={{ paddingBottom: spacing.unit }}>
                  <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
                  {participants.map((p) => {
                    const state = resolveVoiceStateForRoom(
                      p,
                      voiceParticipantStatesByRoom[room.id] ?? {}
                    );
                    // Local user: connecting (joining) or disconnecting (left LiveKit but still in Matrix list)
                    const isLocalConnecting = isConnectedHere && p.userId === userId && isVoiceConnecting;
                    const isLocalDisconnecting = room.id === disconnectingFromRoomId && p.userId === userId;
                    const isRemoteConnecting = isConnectedHere && !isVoiceConnecting && p.userId !== userId && !state;
                    const isParticipantConnecting = isLocalConnecting || isLocalDisconnecting || isRemoteConnecting;
                    return (
                    <VoiceParticipantRow
                      key={p.userId}
                      participant={p}
                      isLocalUser={p.userId === userId}
                      isSharingScreen={screenSharingOwners.includes(p.userId)}
                      isMuted={!!state?.isMuted}
                      isDeafened={!!state?.isDeafened}
                      isSpeaking={!!state?.isSpeaking}
                      isConnecting={isParticipantConnecting}
                      onContextMenu={(e) => {
                        // Map userId to the identity format used by LiveKit
                        setContextMenu({
                          x: e.clientX,
                          y: e.clientY,
                          identity: p.userId,
                          displayName: p.displayName ?? p.userId,
                        });
                      }}
                    />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {rooms.length === 0 && (
          <div style={{
            color: palette.textSecondary,
            padding: `${spacing.unit * 2}px ${spacing.unit * 3}px`,
            fontSize: typography.fontSizeSmall,
          }}>
            No rooms in this space
          </div>
        )}
      </div>

      {/* User status at bottom — flexShrink: 0 so it stays full width */}
      <div style={{ flexShrink: 0 }}>
        <StatusDropdown displayName={displayName} avatarUrl={userAvatarUrl} />
      </div>

      {/* Volume context menu */}
      {contextMenu && (
        <VolumeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          displayName={contextMenu.displayName}
          volume={getVolume(contextMenu.identity, "microphone")}
          onVolumeChange={(vol) => {
            setVolume(contextMenu.identity, vol, "microphone");
            onSetParticipantVolume(contextMenu.identity, vol, "microphone");
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Room context menu */}
      {roomContextMenu && (
        <RoomContextMenu
          x={roomContextMenu.x}
          y={roomContextMenu.y}
          roomName={roomContextMenu.roomName}
          onInvite={() => {
            const t = roomContextMenu;
            setInviteRoom({ id: t.roomId, name: t.roomName });
          }}
          onOpenSettings={() => setSettingsRoomId(roomContextMenu.roomId)}
          onLeave={() => {
            const t = roomContextMenu;
            setLeaveRoomError(null);
            setLeaveRoom({ id: t.roomId, name: t.roomName });
          }}
          onClose={() => setRoomContextMenu(null)}
        />
      )}

      {/* Room settings modal */}
      {settingsRoom && (
        <RoomSettingsModal
          roomId={settingsRoom.id}
          roomName={settingsRoom.name}
          onClose={() => setSettingsRoomId(null)}
        />
      )}

      {inviteRoom && (
        <InviteDialog
          roomId={inviteRoom.id}
          targetName={inviteRoom.name}
          kind="room"
          currentUserId={userId}
          onClose={() => setInviteRoom(null)}
        />
      )}

      {inviteSpaceFromHeader && (
        <InviteDialog
          roomId={inviteSpaceFromHeader.id}
          targetName={inviteSpaceFromHeader.name}
          kind="space"
          currentUserId={userId}
          onClose={() => setInviteSpaceFromHeader(null)}
        />
      )}

      {leaveRoom && (
        <LeaveConfirmDialog
          kind="room"
          targetName={leaveRoom.name}
          onlyAdminWarning={false}
          leaving={leaveRoomSubmitting}
          error={leaveRoomError}
          onConfirm={handleConfirmLeaveRoom}
          onClose={() => {
            if (!leaveRoomSubmitting) {
              setLeaveRoom(null);
              setLeaveRoomError(null);
            }
          }}
        />
      )}
    </div>
  );
}