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
import { resolvePresenceWithDnd } from "../utils/statusMessage";

interface PresencePayload {
  userId: string;
  presence: string;
  statusMsg: string | null;
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
    const ao = order[resolvePresenceWithDnd(a.presence, a.statusMsg)] ?? 2;
    const bo = order[resolvePresenceWithDnd(b.presence, b.statusMsg)] ?? 2;
    if (ao !== bo) return ao - bo;
    const an = (a.displayName ?? a.userId).toLowerCase();
    const bn = (b.displayName ?? b.userId).toLowerCase();
    return an.localeCompare(bn);
  });
}

/** Simple cache — last fetched member list per room. */
const memberCache = new Map<string, RoomMember[]>();

export function useRoomMembers(roomId: string) {
  // ── Members state (triggers sort/filter pipeline — only changes on fetch or presence) ──
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Avatar overrides (cheap to update — does NOT trigger sort/filter) ──
  const [avatarOverrides, setAvatarOverrides] = useState<Map<string, string>>(new Map());

  const hasFetched = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRoomIdRef = useRef(roomId);
  activeRoomIdRef.current = roomId;

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

  // Room switch: restore from cache immediately (sync, before paint) or clear.
  // This prevents both wrong-room flash AND the offline-flicker when cached
  // presence is available.
  useLayoutEffect(() => {
    const cached = memberCache.get(roomId);
    if (cached) {
      memberIdsRef.current = new Set(cached.map((m) => m.userId));
      setMembers(cached);
      setLoading(false);
    } else {
      setMembers([]);
      setLoading(true);
      memberIdsRef.current = new Set();
    }
    setAvatarOverrides(new Map());
    hasFetched.current = false;
  }, [roomId]);

  // After paint: background fetch to pick up any membership changes.
  useEffect(() => {
    fetchMembers(false);
  }, [roomId, fetchMembers]);

  // Background re-fetch on rooms-changed
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

  // ── Presence updates (affect sort order → update members state) ──
  // Batched per frame, skip non-members.
  const pendingPresence = useRef<Map<string, { presence: string; statusMsg: string | null }>>(new Map());
  const presenceRaf = useRef<number | null>(null);

  useEffect(() => {
    const unlisten = listen<PresencePayload>("presence", (event) => {
      const { userId, presence, statusMsg } = event.payload;
      if (!memberIdsRef.current.has(userId)) return;
      pendingPresence.current.set(userId, { presence, statusMsg });

      if (presenceRaf.current == null) {
        presenceRaf.current = requestAnimationFrame(() => {
          presenceRaf.current = null;
          const patches = new Map(pendingPresence.current);
          pendingPresence.current.clear();
          if (patches.size === 0) return;

          setMembers((prev) => {
            let changed = false;
            const next = prev.map((m) => {
              const patch = patches.get(m.userId);
              if (!patch) return m;
              if (m.presence === patch.presence && m.statusMsg === patch.statusMsg) return m;
              changed = true;
              return { ...m, presence: patch.presence, statusMsg: patch.statusMsg };
            });
            if (!changed) return prev;
            memberCache.set(activeRoomIdRef.current, next);
            return next;
          });
        });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
      if (presenceRaf.current != null) cancelAnimationFrame(presenceRaf.current);
    };
  }, []);

  // ── Avatar backfill (does NOT affect sort → separate state, cheap updates) ──
  const pendingAvatars = useRef<Map<string, string>>(new Map());
  const avatarRaf = useRef<number | null>(null);

  useEffect(() => {
    const unlisten = listen<AvatarPayload>("member-avatar-updated", (event) => {
      const { roomId: rid, userId, avatarUrl } = event.payload;
      if (rid !== activeRoomIdRef.current) return;
      pendingAvatars.current.set(userId, avatarUrl);

      if (avatarRaf.current == null) {
        avatarRaf.current = requestAnimationFrame(() => {
          avatarRaf.current = null;
          const patches = new Map(pendingAvatars.current);
          pendingAvatars.current.clear();
          if (patches.size === 0) return;

          setAvatarOverrides((prev) => {
            const next = new Map(prev);
            for (const [uid, url] of patches) next.set(uid, url);
            return next;
          });
        });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
      if (avatarRaf.current != null) cancelAnimationFrame(avatarRaf.current);
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (presenceRaf.current != null) cancelAnimationFrame(presenceRaf.current);
      if (avatarRaf.current != null) cancelAnimationFrame(avatarRaf.current);
    };
  }, []);

  // Sort only re-runs when members change (fetch or presence), NOT on avatar updates.
  const sorted = useMemo(() => sortMembersForDisplay(members), [members]);

  return { members: sorted, loading, avatarOverrides };
}