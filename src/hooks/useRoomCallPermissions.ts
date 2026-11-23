import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface CallPermissions { member: boolean; group: boolean; join: boolean }

export function useRoomCallPermissions(roomId?: string, peerUserId?: string | null, checkGroup = false) {
  const key = JSON.stringify([roomId, peerUserId, checkGroup]);
  const [result, setResult] = useState<{ key: string; permissions: CallPermissions }>();
  useEffect(() => {
    if (!roomId) return;
    let active = true;
    let revision = 0;
    async function refresh() {
      if (!active) return;
      const request = ++revision;
      const permissions = await invoke<CallPermissions>("get_room_call_permissions", { roomId, peerUserId, checkGroup })
        .catch(() => ({ member: false, group: false, join: false }));
      if (active && revision === request) setResult({ key, permissions });
    }
    const subscriptions = [
      listen<string>("room-call-permissions-changed", ({ payload }) => { if (payload === roomId) void refresh(); }),
      listen<{ roomId: string; membershipChanged: boolean }>("room-members-changed", ({ payload }) => {
        if (payload.roomId === roomId && payload.membershipChanged) void refresh();
      }),
      listen("ignored-users-changed", refresh),
      listen("sync-ready", refresh),
    ];
    void Promise.allSettled(subscriptions).then(refresh);
    return () => {
      active = false;
      for (const subscription of subscriptions) void subscription.then(unlisten => unlisten()).catch(() => {});
    };
  }, [roomId, peerUserId, checkGroup, key]);
  return result?.key === key ? result?.permissions : undefined;
}
