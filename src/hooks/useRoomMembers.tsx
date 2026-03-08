import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RoomMember } from "../types/matrix";

interface PresencePayload {
  userId: string;
  presence: string;
}

export function useRoomMembers(roomId: string) {
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [loading, setLoading] = useState(true);
  const hasFetched = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchMembers = useCallback((showLoading: boolean) => {
    if (showLoading) setLoading(true);
    invoke<RoomMember[]>("get_room_members", { roomId })
      .then((result) => {
        setMembers(result);
        setLoading(false);
        hasFetched.current = true;
      })
      .catch((e) => {
        console.error("Failed to fetch room members:", e);
        setLoading(false);
      });
  }, [roomId]);

  // Initial fetch (with loading indicator) when room changes
  useEffect(() => {
    hasFetched.current = false;
    fetchMembers(true);
  }, [fetchMembers]);

  // Silently re-fetch on rooms-changed, debounced to avoid spam
  useEffect(() => {
    const unlisten = listen("rooms-changed", () => {
      if (!hasFetched.current) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        fetchMembers(false);
      }, 2000);
    });
    return () => {
      unlisten.then((fn) => fn());
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [fetchMembers]);

  // Live presence updates — patch in place, no re-fetch needed
  useEffect(() => {
    const unlisten = listen<PresencePayload>("presence", (event) => {
      const { userId, presence } = event.payload;
      setMembers((prev) =>
        prev.map((m) =>
          m.userId === userId ? { ...m, presence } : m
        )
      );
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Sort: online first, then unavailable, then offline; alphabetical within each group
  const sorted = [...members].sort((a, b) => {
    const order: Record<string, number> = { online: 0, unavailable: 1, offline: 2 };
    const aOrder = order[a.presence] ?? 2;
    const bOrder = order[b.presence] ?? 2;
    if (aOrder !== bOrder) return aOrder - bOrder;
    const aName = (a.displayName ?? a.userId).toLowerCase();
    const bName = (b.displayName ?? b.userId).toLowerCase();
    return aName.localeCompare(bName);
  });

  return { members: sorted, loading };
}