import { useState } from "react";
import { Hash, Volume2, PhoneOff, Monitor } from "lucide-react";
import { Room, VoiceParticipant } from "../types/matrix";
import { useTheme } from "../theme/ThemeContext";
import StatusDropdown from "./StatusDropdown";
import VolumeContextMenu from "./VolumeContextMenu";
import { useUserVolume } from "../hooks/useUserVolume";

const VOICE_ROOM_TYPE = "org.matrix.msc3417.call";

interface RoomSidebarProps {
  rooms: Room[];
  activeRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  spaceName: string;
  userId: string;
  voiceParticipants: Record<string, VoiceParticipant[]>;
  connectedVoiceRoomId: string | null;
  screenSharingOwner: string | null;
  onSetParticipantVolume: (identity: string, volume: number) => void;
}

function VoiceParticipantRow({
  participant,
  isLocalUser,
  isSharingScreen,
  onContextMenu,
}: {
  participant: VoiceParticipant;
  isLocalUser: boolean;
  isSharingScreen: boolean;
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
            width: 20,
            height: 20,
            borderRadius: "50%",
            objectFit: "cover",
            flexShrink: 0,
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
        gap: spacing.unit,
      }}>
        {isSharingScreen && <Monitor size={12} color="#23a55a" />}
        {name}
      </span>
    </div>
  );
}

export default function RoomSidebar({
  rooms,
  activeRoomId,
  onSelectRoom,
  spaceName,
  userId,
  voiceParticipants,
  connectedVoiceRoomId,
  screenSharingOwner,
  onSetParticipantVolume,
}: RoomSidebarProps) {
  const { palette, spacing, typography } = useTheme();
  const { getVolume, setVolume } = useUserVolume();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    identity: string;
    displayName: string;
  } | null>(null);

  // Extract local part of userId for display (e.g. @carter:matrix.org → carter)
  const displayName = userId.startsWith("@")
    ? userId.slice(1).split(":")[0]
    : userId;

  return (
    <div style={{
      width: spacing.sidebarWidth,
      backgroundColor: palette.bgSecondary,
      display: "flex",
      flexDirection: "column",
      height: "100vh",
    }}>
      <h2 style={{
        padding: `${spacing.unit * 4}px ${spacing.unit * 4}px`,
        fontSize: typography.fontSizeLarge,
        fontWeight: typography.fontWeightBold,
        height: spacing.headerHeight,
        color: palette.textHeading,
        borderBottom: `1px solid ${palette.border}`,
        margin: 0,
      }}>
        {spaceName}
      </h2>
      { spaceName === "Home" &&
        <div 
          onClick={() => onSelectRoom("settings")}
          style={{
            padding: `${spacing.unit * 4}px ${spacing.unit * 4}px ${spacing.unit * 3}px`,
            cursor: "pointer",
            fontWeight: typography.fontWeightBold,
            color: activeRoomId==="settings" ? palette.textHeading : palette.textSecondary,
            backgroundColor: activeRoomId==="settings" ? palette.bgActive : palette.bgSecondary,
            borderBottom: `1px solid ${palette.border}`,
            margin: 0,
          }}
        >
          Settings 
        </div>
      }
      <div style={{ flex: 1, overflowY: "auto", padding: spacing.unit * 2 }}>
        {rooms.map((room) => {
          const isVoice = room.roomType === VOICE_ROOM_TYPE;
          const participants = isVoice ? (voiceParticipants[room.id] ?? []) : [];
          const isConnectedHere = connectedVoiceRoomId === room.id;

          return (
            <div key={room.id}>
              {/* Room row */}
              <div
                onClick={() => onSelectRoom(room.id)}
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
                  {participants.map((p) => (
                    <VoiceParticipantRow
                      key={p.userId}
                      participant={p}
                      isLocalUser={p.userId === userId}
                      isSharingScreen={screenSharingOwner === p.userId}
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
                  ))}
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

      {/* User status at bottom */}
      <StatusDropdown displayName={displayName} avatarUrl={null} />

      {/* Volume context menu */}
      {contextMenu && (
        <VolumeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          displayName={contextMenu.displayName}
          volume={getVolume(contextMenu.identity)}
          onVolumeChange={(vol) => {
            setVolume(contextMenu.identity, vol);
            onSetParticipantVolume(contextMenu.identity, vol);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}