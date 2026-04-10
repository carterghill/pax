import {
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RoomMember } from "../types/matrix";

interface PresencePayload {
  userId: string;
  presence: string;
}

interface AvatarPayload {
  roomId: string;
  userId: string;
  avatarUrl: string;
}

function sortMembersForDisplay(members: RoomMember[]): RoomMember[] {
  const order: Record<string, number> = { online: 0, dnd: 0, unavailable: 1, offline: 2 };
  return [...members].sort((a, b) => {
    const ao = order[a.presence] ?? 2;
    const bo = order[b.presence] ?? 2;
    if (ao !== bo) return ao - bo;
    const an = (a.displayName ?? a.userId).toLowerCase();
    const bn = (b.displayName ?? b.userId).toLowerCase();
    return an.localeCompare(bn);
  });
}

export function useRoomMembers(roomId: string) {
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [loading, setLoading] = useState(true);

  const hasFetched = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRoomIdRef = useRef(roomId);
  activeRoomIdRef.current = roomId;

  const fetchMembers = useCallback(
    (showLoading: boolean) => {
      const requestedRoomId = roomId;
      if (showLoading) setLoading(true);

      invoke<RoomMember[]>("get_room_members", { roomId: requestedRoomId })
        .then((result) => {
          if (activeRoomIdRef.current !== requestedRoomId) return;
          // Dedupe by userId (last wins)
          const byId = new Map<string, RoomMember>();
          for (const m of result) byId.set(m.userId, m);
          setMembers([...byId.values()]);
          setLoading(false);
          hasFetched.current = true;
        })
        .catch((e) => {
          if (activeRoomIdRef.current !== requestedRoomId) return;
          console.error("Failed to fetch room members:", e);
          setMembers([]);
          setLoading(false);
        });
    },
    [roomId]
  );

  // Clear stale data before paint on room switch
  useLayoutEffect(() => {
    setMembers([]);
    setLoading(true);
    hasFetched.current = false;
  }, [roomId]);

  // Initial fetch
  useEffect(() => {
    fetchMembers(true);
  }, [roomId, fetchMembers]);

  // Background re-fetch on rooms-changed, debounced
  useEffect(() => {
    const unlisten = listen("rooms-changed", () => {
      if (!hasFetched.current) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => fetchMembers(false), 2000);
    });
    return () => {
      unlisten.then((fn) => fn());
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [fetchMembers]);

  // Live presence updates
  useEffect(() => {
    const unlisten = listen<PresencePayload>("presence", (event) => {
      const { userId, presence } = event.payload;
      setMembers((prev) =>
        prev.map((m) => (m.userId === userId ? { ...m, presence } : m))
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Background avatar backfill from Rust
  useEffect(() => {
    const unlisten = listen<AvatarPayload>("member-avatar-updated", (event) => {
      const { roomId: rid, userId, avatarUrl } = event.payload;
      if (rid !== activeRoomIdRef.current) return;
      setMembers((prev) =>
        prev.map((m) => (m.userId === userId ? { ...m, avatarUrl } : m))
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const sorted = useMemo(() => sortMembersForDisplay(members), [members]);

  return { members: sorted, loading };
}