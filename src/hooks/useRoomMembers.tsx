import {
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
  startTransition,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RoomMember } from "../types/matrix";
import {
  dedupeMembersByUserId,
  sortMembersForDisplay,
  countPresenceForGroups,
  processRoomMembersRaw,
  type MemberPresenceCounts,
} from "../utils/roomMembersProcess";
import { processRoomMembersForFetch } from "../utils/roomMembersWorkerClient";

interface PresencePayload {
  userId: string;
  presence: string;
}

export type { MemberPresenceCounts };

/** Keep at most this many members when the user leaves a room (reduces lag when returning). */
const MAX_MEMBER_CACHE_OFFLINE = 20;

interface MemberCacheEntry {
  members: RoomMember[];
  /** True when we only retained a small slice for performance after navigating away. */
  partial: boolean;
  /** Joined member count from the last full member list (kept when partial). */
  totalJoinedCount?: number;
  /** Presence distribution from the last full list (used for headers while partial). */
  presenceCounts?: MemberPresenceCounts;
}

/** In-memory cache — trimmed when switching rooms so huge rooms don't freeze navigation. */
const memberCache = new Map<string, MemberCacheEntry>();

function shrinkMemberCacheForRoom(roomId: string) {
  const entry = memberCache.get(roomId);
  if (!entry || entry.partial) return;
  const deduped = dedupeMembersByUserId(entry.members);
  if (deduped.length <= MAX_MEMBER_CACHE_OFFLINE) return;
  const sorted = sortMembersForDisplay(deduped);
  const presenceCounts = countPresenceForGroups(deduped);
  memberCache.set(roomId, {
    members: sorted.slice(0, MAX_MEMBER_CACHE_OFFLINE),
    partial: true,
    totalJoinedCount: deduped.length,
    presenceCounts,
  });
}

export function useRoomMembers(roomId: string) {
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [loading, setLoading] = useState(true);
  /** True while we only have a capped slice; headers use cached totals. */
  const [listPartial, setListPartial] = useState(false);
  /** Snapshot from cache for section labels when listPartial (React state; Map is not reactive). */
  const [cachedPresenceForHeader, setCachedPresenceForHeader] =
    useState<MemberPresenceCounts | null>(null);
  const [cachedTotalJoined, setCachedTotalJoined] = useState<number | null>(null);

  const hasFetched = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Ignore late responses when the user has switched to another room. */
  const activeRoomIdRef = useRef(roomId);
  activeRoomIdRef.current = roomId;

  const fetchMembers = useCallback((showLoading: boolean) => {
    const requestedRoomId = roomId;
    if (showLoading) setLoading(true);

    invoke<RoomMember[]>("get_room_members", { roomId: requestedRoomId })
      .then(async (result) => {
        if (activeRoomIdRef.current !== requestedRoomId) return;

        let processed: ReturnType<typeof processRoomMembersRaw>;
        try {
          processed = await processRoomMembersForFetch(result);
        } catch {
          processed = processRoomMembersRaw(result);
        }

        if (activeRoomIdRef.current !== requestedRoomId) return;

        memberCache.set(requestedRoomId, {
          members: processed.members,
          partial: false,
          totalJoinedCount: processed.totalJoinedCount,
          presenceCounts: processed.presenceCounts,
        });

        setLoading(false);
        hasFetched.current = true;

        startTransition(() => {
          setMembers(processed.members);
          setListPartial(false);
          setCachedPresenceForHeader(null);
          setCachedTotalJoined(null);
        });
      })
      .catch((e) => {
        if (activeRoomIdRef.current !== requestedRoomId) return;
        console.error("Failed to fetch room members:", e);
        setMembers([]);
        setListPartial(false);
        setCachedPresenceForHeader(null);
        setCachedTotalJoined(null);
        setLoading(false);
      });
  }, [roomId]);

  // When leaving a room (switch room or unmount), cap cached members so returning doesn't lag.
  useEffect(() => {
    return () => {
      shrinkMemberCacheForRoom(roomId);
    };
  }, [roomId]);

  // Drop previous room's members before paint so we never flash or persist wrong data.
  useLayoutEffect(() => {
    setMembers([]);
    setLoading(true);
    setListPartial(false);
    setCachedPresenceForHeader(null);
    setCachedTotalJoined(null);
    hasFetched.current = false;
  }, [roomId]);

  // Initial load (prefer cache; partial cache triggers a background full fetch)
  useEffect(() => {
    const entry = memberCache.get(roomId);

    if (entry) {
      const deduped = dedupeMembersByUserId(entry.members);
      const sorted = sortMembersForDisplay(deduped);
      startTransition(() => {
        setMembers(sorted);
      });
      if (entry.partial) {
        setListPartial(true);
        setCachedPresenceForHeader(entry.presenceCounts ?? null);
        setCachedTotalJoined(entry.totalJoinedCount ?? deduped.length);
        setLoading(false);
        hasFetched.current = true;
        fetchMembers(false);
      } else {
        setListPartial(false);
        setCachedPresenceForHeader(null);
        setCachedTotalJoined(null);
        setLoading(false);
        hasFetched.current = true;
      }
    } else {
      fetchMembers(true);
    }
  }, [roomId, fetchMembers]);

  // Keep cache aligned with in-memory list (presence patches, etc.)
  useEffect(() => {
    if (members.length === 0) return;
    const cached = memberCache.get(roomId);
    const partial =
      cached?.partial === true && members.length <= MAX_MEMBER_CACHE_OFFLINE;

    if (partial) {
      memberCache.set(roomId, {
        members,
        partial: true,
        totalJoinedCount: cached?.totalJoinedCount,
        presenceCounts: cached?.presenceCounts,
      });
      return;
    }

    const deduped = dedupeMembersByUserId(members);
    if (deduped.length !== members.length) {
      startTransition(() => {
        setMembers(sortMembersForDisplay(deduped));
      });
      return;
    }

    memberCache.set(roomId, {
      members: deduped,
      partial: false,
      totalJoinedCount: deduped.length,
      presenceCounts: countPresenceForGroups(deduped),
    });
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

  // Live presence updates — patch in place; useMemo below re-sorts for display order
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

  const sorted = useMemo(() => sortMembersForDisplay(members), [members]);

  const totalJoinedCount =
    listPartial && cachedTotalJoined != null ? cachedTotalJoined : sorted.length;

  return {
    members: sorted,
    loading,
    /** True while only a capped slice is shown; full fetch is in flight or pending. */
    listPartial,
    /** For section headers when listPartial — distribution from last full list. */
    cachedPresenceForHeader,
    /** Total joined members (room size), including people not in the current slice. */
    totalJoinedCount,
  };
}
