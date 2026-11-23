import { useRoomCallPermissions } from "../hooks/useRoomCallPermissions";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MemberModerationPermissions } from "../types/matrix";
import MemberContextMenu from "./MemberContextMenu";
import ModerationScopeDialog from "./ModerationScopeDialog";

export interface MemberMenuTarget {
  x: number;
  y: number;
  userId: string;
  displayName: string;
}

interface RoomMemberContextMenuProps {
  target: MemberMenuTarget | null;
  onCallMember?: (userId: string) => void;
  roomId: string;
  roomName: string;
  currentUserId: string;
  moderationSpaceTreeRoomIds: string[] | null;
  moderationSpaceName: string | null;
  onClose: () => void;
  onOpenProfile: (userId: string) => void;
  onStartDirectMessage: (userId: string, displayName: string) => void;
}

export default function RoomMemberContextMenu({
  target,
  roomId,
  roomName,
  currentUserId,
  moderationSpaceTreeRoomIds,
  moderationSpaceName,
  onClose,
  onOpenProfile,
  onStartDirectMessage,
  onCallMember,
}: RoomMemberContextMenuProps) {
  const [allowed, setAllowed] = useState<{
    target: MemberMenuTarget;
    permissions: MemberModerationPermissions;
  } | null>(null);
  const [moderation, setModeration] = useState<{
    kind: "kick" | "ban";
    target: MemberMenuTarget;
  } | null>(null);
  const [moderationBusy, setModerationBusy] = useState(false);
  const permissions = useRoomCallPermissions(target && onCallMember ? roomId : undefined, target?.userId);
  const isSelf = target?.userId === currentUserId;

  useEffect(() => {
    if (!target || isSelf) return;
    let cancelled = false;
    void invoke<MemberModerationPermissions>("get_member_moderation_permissions", {
      roomId,
      memberUserId: target.userId,
    }).then((permissions) => {
      if (!cancelled) setAllowed({ target, permissions });
    }, () => {});
    return () => { cancelled = true; };
  }, [isSelf, roomId, target]);

  const chooseModeration = (kind: "kick" | "ban") => {
    if (!target) return;
    setModeration({ kind, target });
    onClose();
  };

  const runModeration = async (roomIds: string[]) => {
    if (!moderation || moderationBusy) return;
    setModerationBusy(true);
    try {
      for (const id of roomIds) {
        try {
          await invoke(moderation.kind === "kick" ? "kick_user" : "ban_user", {
            roomId: id,
            userId: moderation.target.userId,
            reason: null,
          });
        } catch (error) {
          console.error(`Moderation failed for room ${id}:`, error);
        }
      }
    } finally {
      setModerationBusy(false);
      setModeration(null);
    }
  };

  return (
    <>
      {target && (
        <MemberContextMenu
          key={target.userId}
          {...target}
          currentUserId={currentUserId}
          onClose={onClose}
          onProfile={() => {
            onClose();
            onOpenProfile(target.userId);
          }}
          onSendMessage={isSelf ? undefined : () => {
            onClose();
            onStartDirectMessage(target.userId, target.displayName);
          }}
          onCall={!isSelf && permissions?.member && onCallMember ? () => {
            onClose();
            onCallMember(target.userId);
          } : undefined}
          moderation={allowed?.target === target ? allowed.permissions : undefined}
          onKick={() => chooseModeration("kick")}
          onBan={() => chooseModeration("ban")}
        />
      )}
      {moderation && (
        <ModerationScopeDialog
          kind={moderation.kind}
          targetDisplayName={moderation.target.displayName}
          currentRoomName={roomName}
          showSpaceScope={!!moderationSpaceTreeRoomIds?.length}
          spaceName={moderationSpaceName}
          busy={moderationBusy}
          onSpaceScope={() => void runModeration(moderationSpaceTreeRoomIds ?? [roomId])}
          onRoomOnly={() => void runModeration([roomId])}
          onCancel={() => { if (!moderationBusy) setModeration(null); }}
        />
      )}
    </>
  );
}
