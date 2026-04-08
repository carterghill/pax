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

function cacheKey(roomId: string) {
  return `room-members-${roomId}`;
}

export function useRoomMembers(roomId: string) {
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [loading, setLoading] = useState(true);
  const hasFetched = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Ignore late responses when the user has switched to another room. */
  const activeRoomIdRef = useRef(roomId);
  activeRoomIdRef.current = roomId;

  const fetchMembers = useCallback((showLoading: boolean) => {
    const requestedRoomId = roomId;
    if (showLoading) setLoading(true);

    invoke<RoomMember[]>("get_room_members", { roomId: requestedRoomId })
      .then((result) => {
        if (activeRoomIdRef.current !== requestedRoomId) return;
        setMembers(result);
        // Cache without avatarUrl (base64 data URLs blow past sessionStorage quota)
        try {
          sessionStorage.setItem(
            cacheKey(requestedRoomId),
            JSON.stringify(result.map(({ avatarUrl, ...rest }) => rest))
          );
        } catch { /* quota exceeded – non-fatal */ }
        setLoading(false);
        hasFetched.current = true;
      })
      .catch((e) => {
        if (activeRoomIdRef.current !== requestedRoomId) return;
        console.error("Failed to fetch room members:", e);
        setMembers([]);
        setLoading(false);
      });
  }, [roomId]);

  // Drop previous room's members before paint so we never flash or persist wrong data.
  useLayoutEffect(() => {
    setMembers([]);
    setLoading(true);
    hasFetched.current = false;
  }, [roomId]);

  // Initial load (prefer cache)
  useEffect(() => {
    const cached = sessionStorage.getItem(cacheKey(roomId));

    if (cached) {
      try {
        const parsed = JSON.parse(cached) as RoomMember[];
        setMembers(parsed);
        setLoading(false);
        hasFetched.current = true;
      } catch {
        fetchMembers(true);
      }
    } else {
      fetchMembers(true);
    }
  }, [roomId, fetchMembers]);

  // Persist member list for this room only (debounced to avoid blocking main thread).
  useEffect(() => {
    if (members.length === 0) return;
    const timer = setTimeout(() => {
      try {
        sessionStorage.setItem(cacheKey(roomId), JSON.stringify(members.map(({ avatarUrl, ...rest }) => rest)));
      } catch { /* quota exceeded – non-fatal */ }
    }, 1000);
    return () => clearTimeout(timer);
  }, [members, roomId]);

  // Silently re-fetch on rooms-changed, debounced
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

  // Live presence updates — patch in place
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

  // Sort members
  const sorted = useMemo(() => [...members].sort((a, b) => {
    const order: Record<string, number> = { online: 0, unavailable: 1, offline: 2 };

    const aOrder = order[a.presence] ?? 2;
    const bOrder = order[b.presence] ?? 2;

    if (aOrder !== bOrder) return aOrder - bOrder;

    const aName = (a.displayName ?? a.userId).toLowerCase();
    const bName = (b.displayName ?? b.userId).toLowerCase();

    return aName.localeCompare(bName);
  }), [members]);

  return { members: sorted, loading };
}