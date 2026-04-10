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

function dedupeMembers(members: RoomMember[]): RoomMember[] {
  const byId = new Map<string, RoomMember>();
  for (const m of members) byId.set(m.userId, m);
  return [...byId.values()];
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

/** Simple cache — last fetched member list per room. Written only on fetch, not on every event. */
const memberCache = new Map<string, RoomMember[]>();

export function useRoomMembers(roomId: string) {
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [loading, setLoading] = useState(true);

  const hasFetched = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRoomIdRef = useRef(roomId);
  activeRoomIdRef.current = roomId;

  /** Set of userIds in the current member list — for fast "is this user relevant?" checks. */
  const memberIdsRef = useRef<Set<string>>(new Set());

  const fetchMembers = useCallback(
    (showLoading: boolean) => {
      const requestedRoomId = roomId;
      if (showLoading) setLoading(true);

      invoke<RoomMember[]>("get_room_members", { roomId: requestedRoomId })
        .then((result) => {
          if (activeRoomIdRef.current !== requestedRoomId) return;
          const deduped = dedupeMembers(result);
          memberCache.set(requestedRoomId, deduped);
          memberIdsRef.current = new Set(deduped.map((m) => m.userId));
          setMembers(deduped);
          setLoading(false);
          hasFetched.current = true;
        })
        .catch((e) => {
          if (activeRoomIdRef.current !== requestedRoomId) return;
          console.error("Failed to fetch room members:", e);
          setLoading(false);
        });
    },
    [roomId]
  );

  // On room switch: always clear synchronously to prevent wrong-room flash.
  // Cache is restored in the useEffect below (after paint, non-blocking).
  useLayoutEffect(() => {
    setMembers([]);
    setLoading(true);
    hasFetched.current = false;
    memberIdsRef.current = new Set();
  }, [roomId]);

  // Restore from cache (after paint) or fetch
  useEffect(() => {
    const cached = memberCache.get(roomId);
    if (cached) {
      memberIdsRef.current = new Set(cached.map((m) => m.userId));
      setMembers(cached);
      setLoading(false);
      // Still refresh in the background
      fetchMembers(false);
    } else {
      fetchMembers(true);
    }
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

  // ── Batched event patches (once per frame, skip non-members) ──
  const pendingPresence = useRef<Map<string, string>>(new Map());
  const pendingAvatars = useRef<Map<string, string>>(new Map());
  const flushRaf = useRef<number | null>(null);

  const scheduleFlush = useCallback(() => {
    if (flushRaf.current != null) return;
    flushRaf.current = requestAnimationFrame(() => {
      flushRaf.current = null;
      const pres = pendingPresence.current;
      const av = pendingAvatars.current;
      if (pres.size === 0 && av.size === 0) return;
      const presSnap = new Map(pres);
      const avSnap = new Map(av);
      pres.clear();
      av.clear();

      setMembers((prev) => {
        let changed = false;
        const next = prev.map((m) => {
          const newPres = presSnap.get(m.userId);
          const newAv = avSnap.get(m.userId);
          if (!newPres && !newAv) return m;
          if (newPres && m.presence === newPres && !newAv) return m;
          changed = true;
          return {
            ...m,
            ...(newPres ? { presence: newPres } : undefined),
            ...(newAv ? { avatarUrl: newAv } : undefined),
          };
        });
        return changed ? next : prev;
      });
    });
  }, []);

  useEffect(() => {
    const unlisten = listen<PresencePayload>("presence", (event) => {
      const { userId, presence } = event.payload;
      // Skip if this user isn't in the current room's member list
      if (!memberIdsRef.current.has(userId)) return;
      pendingPresence.current.set(userId, presence);
      scheduleFlush();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [scheduleFlush]);

  useEffect(() => {
    const unlisten = listen<AvatarPayload>("member-avatar-updated", (event) => {
      const { roomId: rid, userId, avatarUrl } = event.payload;
      if (rid !== activeRoomIdRef.current) return;
      pendingAvatars.current.set(userId, avatarUrl);
      scheduleFlush();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [scheduleFlush]);

  // Cleanup on room switch and unmount
  useEffect(() => {
    return () => {
      pendingPresence.current.clear();
      pendingAvatars.current.clear();
      if (flushRaf.current != null) {
        cancelAnimationFrame(flushRaf.current);
        flushRaf.current = null;
      }
    };
  }, [roomId]);

  useEffect(() => {
    return () => {
      if (flushRaf.current != null) cancelAnimationFrame(flushRaf.current);
    };
  }, []);

  const sorted = useMemo(() => sortMembersForDisplay(members), [members]);

  return { members: sorted, loading };
}