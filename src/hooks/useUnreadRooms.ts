import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Backend-surfaced unread state for one room.
 *
 * `messages` is what we use for the sidebar's "primary-colour when unread"
 * treatment — it's the client-side-computed count from matrix-sdk and is more
 * accurate than the server's `unread_notifications` for encrypted rooms.
 *
 * `mentions` drives the red pill badge (highlights only: explicit mentions,
 * `@room`, configured keywords).
 *
 * `markedUnread` is the MSC2867 user-marked-unread flag and is OR'd into the
 * `isUnread` predicate so manually-marked rooms stay highlighted.
 */
export interface RoomUnreadState {
  messages: number;
  notifications: number;
  mentions: number;
  markedUnread: boolean;
}

const EMPTY: RoomUnreadState = {
  messages: 0,
  notifications: 0,
  mentions: 0,
  markedUnread: false,
};

interface RoomUnreadChangedPayload extends RoomUnreadState {
  roomId: string;
}

export interface UnreadRoomsApi {
  /**
   * True when the room has unread messages OR has been explicitly marked unread.
   * Uses `messages` (not `notifications`) so a chatty-but-unmuted room still
   * lights up when there's activity even if no push rule fired.  If we later
   * want muted rooms to stay grey, switch this to `notifications`.
   */
  isUnread: (roomId: string) => boolean;
  /** Subset of unread that would notify per push rules; drives tray red dot in split mode. */
  notificationCount: (roomId: string) => number;
  /** Count for the red pill.  0 means no pill. */
  mentionCount: (roomId: string) => number;
  /** For a potential "you have 3 new messages" tooltip / aria-label. */
  messageCount: (roomId: string) => number;
}

/**
 * Subscribes to backend unread updates and exposes a stable API for the sidebar.
 *
 * Uses an internal ref + a version counter rather than re-setting a Map in state
 * on every event, to avoid re-rendering the entire sidebar on every keystroke in
 * a chatty room.  The predicate functions close over the ref, so they always see
 * fresh data, and components opt in to re-rendering by depending on `version`.
 *
 * Seed load:
 *   - We call `get_all_unread_states` once after `sync-ready` so the map reflects
 *     real state before the first paint of the sidebar.  Calling it before
 *     sync-ready would race with the first `sync_once` and could return stale
 *     zeroes for E2EE rooms.
 *
 * Live updates:
 *   - `room-unread-changed` is emitted by the sync loop's diff walker in
 *     `commands::unread::emit_unread_snapshot_if_changed`.  Only rooms whose
 *     state actually moved show up.
 */
export function useUnreadRooms(userId: string | null): UnreadRoomsApi {
  const mapRef = useRef<Map<string, RoomUnreadState>>(new Map());
  const [version, setVersion] = useState(0);
  const bumpRafRef = useRef<number | null>(null);

  /** Coalesce bursts (e.g. initial seed over dozens of rooms) into one render. */
  const scheduleBump = useCallback(() => {
    if (bumpRafRef.current !== null) return;
    bumpRafRef.current = requestAnimationFrame(() => {
      bumpRafRef.current = null;
      setVersion((v) => v + 1);
    });
  }, []);

  useEffect(() => {
    if (!userId) {
      mapRef.current.clear();
      scheduleBump();
      return;
    }

    let cancelled = false;
    let unlistenChanged: UnlistenFn | null = null;
    let unlistenSyncReady: UnlistenFn | null = null;

    async function seed() {
      try {
        const all = await invoke<Record<string, RoomUnreadState>>(
          "get_all_unread_states"
        );
        if (cancelled) return;
        mapRef.current = new Map(Object.entries(all));
        scheduleBump();
      } catch (e) {
        // Non-fatal: a future room-unread-changed event will populate entries
        // lazily.  Log so regressions don't hide.
        console.warn("[useUnreadRooms] seed failed:", e);
      }
    }

    async function wire() {
      unlistenChanged = await listen<RoomUnreadChangedPayload>(
        "room-unread-changed",
        (event) => {
          if (cancelled) return;
          const { roomId, ...state } = event.payload;
          mapRef.current.set(roomId, state);
          scheduleBump();
        }
      );

      unlistenSyncReady = await listen("sync-ready", () => {
        // sync-ready can fire again after a reconnection; re-seeding is cheap.
        void seed();
      });

      // Kick off an initial seed right away — if sync isn't ready yet the call
      // will just return an empty map, and the sync-ready listener above will
      // re-seed when the first iteration completes.
      void seed();
    }

    void wire();

    return () => {
      cancelled = true;
      unlistenChanged?.();
      unlistenSyncReady?.();
      if (bumpRafRef.current !== null) {
        cancelAnimationFrame(bumpRafRef.current);
        bumpRafRef.current = null;
      }
    };
  }, [userId, scheduleBump]);

  // The predicate functions deliberately depend on `version` via the closure
  // captured at render time — any consumer that reads them inside a render will
  // re-read when we bump the version and the component re-renders.
  //
  // Using `useCallback` with `[version]` forces the function identity to change
  // on each update, which ensures React sees a fresh reference and recomputes
  // memoised children that take this as a prop.
  const isUnread = useCallback(
    (roomId: string) => {
      const s = mapRef.current.get(roomId);
      if (!s) return false;
      return s.messages > 0 || s.markedUnread;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );

  const notificationCount = useCallback(
    (roomId: string) => mapRef.current.get(roomId)?.notifications ?? 0,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );

  const mentionCount = useCallback(
    (roomId: string) => mapRef.current.get(roomId)?.mentions ?? 0,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );

  const messageCount = useCallback(
    (roomId: string) => mapRef.current.get(roomId)?.messages ?? 0,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version]
  );

  return { isUnread, notificationCount, mentionCount, messageCount };
}

/** Hint type for callers that want to store the latest snapshot outside React. */
export const EMPTY_UNREAD_STATE: Readonly<RoomUnreadState> = EMPTY;

/** Minimal room shape the space rollup needs — decoupled from the full Room type
 *  so the hook can be tested / reused without dragging in Matrix-specific fields. */
export interface RoomForRollup {
  id: string;
  isSpace: boolean;
  parentSpaceIds: string[];
  /**
   * True for 1:1 DMs as reported by matrix-sdk.  Used by the rollup's
   * "effective" counters to promote unread DM messages into the red
   * mention-badge bucket (they don't produce server-side highlights so
   * they'd otherwise be invisible on the icons).
   */
  isDirect?: boolean;
}

export interface SpaceUnreadRollupApi {
  /** True when the space (or any descendant space/room) has unread activity. */
  isSpaceUnread: (spaceId: string) => boolean;
  /** True when any descendant room has notification-worthy unread (`notifications` > 0). */
  isSpaceNotified: (spaceId: string) => boolean;
  /** Sum of raw mentions across descendant rooms.  Use `effectiveSpaceMentionCount`
   *  for the sidebar badge — it also counts unread DM messages. */
  spaceMentionCount: (spaceId: string) => number;
  /** True when any room outside every joined space has unread activity (Home indicator). */
  isHomeUnread: () => boolean;
  /** Home rollup for notification-worthy unread. */
  isHomeNotified: () => boolean;
  /** Sum of raw mentions across rooms outside every joined space. */
  homeMentionCount: () => number;
  /**
   * Per-room badge count.  Equals `mentionCount(roomId)` for group rooms,
   * but for DMs (where the server never raises `highlight_count` for plain
   * messages) it falls back to the unread message count when the room's
   * effective notification level is anything other than `none`.  A muted
   * DM keeps its badge at 0, same as a muted group room would.
   */
  effectiveMentionCount: (roomId: string) => number;
  /** Sum of `effectiveMentionCount` across the space's descendant rooms.
   *  Use this for the space-icon badge. */
  effectiveSpaceMentionCount: (spaceId: string) => number;
  /** Sum of `effectiveMentionCount` across home rooms.  Use for the Home icon. */
  effectiveHomeMentionCount: () => number;
}

/**
 * Aggregate unread state across a space's full descendant tree.
 *
 * Matrix spaces don't have unread state of their own — they're state-only rooms
 * with `m.space.child` pointers at members.  To light up a space icon we have
 * to walk its tree and OR/sum over children.  Nested spaces recurse.
 *
 * The walker is top-down from a space root through `roomsBySpace(spaceId)`,
 * matching how the sidebar already organises rooms — we do NOT maintain a
 * separate parent→child index here because Pax's `useRooms` already has one
 * and exposes it via `roomsBySpace`.
 *
 * Cycles: Matrix allows a room to declare multiple parent spaces, but `m.space`
 * hierarchies should be acyclic per the spec.  We still guard against cycles
 * with a visited set because a misbehaving server or historical state can
 * produce them, and an infinite loop inside a render is not a great outcome.
 *
 * "Home" aggregates every joined room whose parent-space chain does not
 * intersect any joined space the user is in — i.e. the same set of rooms that
 * appear under the Home pseudo-space in the sidebar.  This keeps DMs and
 * orphaned rooms visible on the Home button when they go unread.
 *
 * The returned functions are recomputed via `useCallback` whenever the inputs
 * change — mainly when the underlying `isUnread`/`mentionCount` functions from
 * `useUnreadRooms` re-fire on new sync data, or when the rooms list changes
 * shape (room joined, left, etc.).
 */
export function useSpaceUnreadRollup(
  spaces: readonly RoomForRollup[],
  roomsBySpace: (spaceId: string | null) => readonly RoomForRollup[],
  roomUnread: UnreadRoomsApi,
  /**
   * Which rooms are effectively muted.  Called per-room during rollup;
   * if a room returns `true`, it's excluded from `effectiveMentionCount`
   * (i.e. unread DM messages don't bump the red badge for muted DMs).
   * Callers that don't care about DM promotion can pass `() => false`.
   */
  isRoomEffectivelyMuted: (roomId: string) => boolean,
): SpaceUnreadRollupApi {
  const { isUnread, notificationCount, mentionCount, messageCount } = roomUnread;

  const joinedSpaceIdSet = useMemo(() => {
    const s = new Set<string>();
    for (const sp of spaces) s.add(sp.id);
    return s;
  }, [spaces]);

  // Direct-room lookup table.  Built from every room we've seen in
  // `spaces` + `roomsBySpace` rather than a separate `getRoom` prop so
  // the hook can stay narrow-waist.  Rebuilt whenever the inputs change.
  const dmIdSet = useMemo(() => {
    const s = new Set<string>();
    const visit = (list: readonly RoomForRollup[]) => {
      for (const r of list) {
        if (!r.isSpace && r.isDirect) s.add(r.id);
      }
    };
    // Home-scoped rooms.
    visit(roomsBySpace(null));
    // Space-scoped rooms.
    for (const sp of spaces) visit(roomsBySpace(sp.id));
    return s;
  }, [spaces, roomsBySpace]);

  const isSpaceUnread = useCallback(
    (spaceId: string): boolean => {
      const visited = new Set<string>();
      const walk = (sid: string): boolean => {
        if (visited.has(sid)) return false;
        visited.add(sid);
        for (const child of roomsBySpace(sid)) {
          if (child.isSpace) {
            if (walk(child.id)) return true;
          } else {
            if (isUnread(child.id)) return true;
          }
        }
        return false;
      };
      return walk(spaceId);
    },
    [roomsBySpace, isUnread],
  );

  const isSpaceNotified = useCallback(
    (spaceId: string): boolean => {
      const visited = new Set<string>();
      const walk = (sid: string): boolean => {
        if (visited.has(sid)) return false;
        visited.add(sid);
        for (const child of roomsBySpace(sid)) {
          if (child.isSpace) {
            if (walk(child.id)) return true;
          } else {
            if (notificationCount(child.id) > 0) return true;
          }
        }
        return false;
      };
      return walk(spaceId);
    },
    [roomsBySpace, notificationCount],
  );

  /**
   * Core per-room badge number.
   *
   * When the room is effectively muted (level `none`), return 0 — the server
   * still increments `highlight_count` for built-in override rules
   * (`contains_user_name`, `roomnotif`) even with a room-kind `dont_notify`
   * push rule installed, but the user's intent is "don't bother me."  This
   * is the same client-side suppression Element does for its "Off" preset.
   *
   * For non-muted rooms, the raw mention count is the lower bound — a
   * server-computed highlight (keyword, explicit ping) always counts.
   * For DMs, bump this up to the unread-message count: the server doesn't
   * produce highlights for plain DM messages, but the whole point of a DM
   * is that every message is addressed to you, so every unread message
   * should contribute to the badge.
   */
  const effectiveMentionCount = useCallback(
    (roomId: string): number => {
      if (isRoomEffectivelyMuted(roomId)) return 0;
      const base = mentionCount(roomId);
      if (!dmIdSet.has(roomId)) return base;
      return Math.max(base, messageCount(roomId));
    },
    [mentionCount, messageCount, dmIdSet, isRoomEffectivelyMuted],
  );

  const spaceMentionCount = useCallback(
    (spaceId: string): number => {
      const visited = new Set<string>();
      let total = 0;
      const walk = (sid: string) => {
        if (visited.has(sid)) return;
        visited.add(sid);
        for (const child of roomsBySpace(sid)) {
          if (child.isSpace) {
            walk(child.id);
          } else {
            total += mentionCount(child.id);
          }
        }
      };
      walk(spaceId);
      return total;
    },
    [roomsBySpace, mentionCount],
  );

  const effectiveSpaceMentionCount = useCallback(
    (spaceId: string): number => {
      const visited = new Set<string>();
      let total = 0;
      const walk = (sid: string) => {
        if (visited.has(sid)) return;
        visited.add(sid);
        for (const child of roomsBySpace(sid)) {
          if (child.isSpace) {
            walk(child.id);
          } else {
            total += effectiveMentionCount(child.id);
          }
        }
      };
      walk(spaceId);
      return total;
    },
    [roomsBySpace, effectiveMentionCount],
  );

  // "Home rooms" are rooms with no joined-space parent.  `roomsBySpace(null)`
  // returns rooms with an empty `parentSpaceIds`; to catch rooms that have
  // parents pointing only at unjoined spaces, we also include rooms whose
  // every declared parent is outside our joined-space set.
  const homeRoomIds = useMemo(() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    const add = (r: RoomForRollup) => {
      if (r.isSpace) return;
      if (seen.has(r.id)) return;
      seen.add(r.id);
      ids.push(r.id);
    };
    for (const r of roomsBySpace(null)) add(r);
    // Catch rooms orphaned from the user's joined spaces (parents point at
    // spaces the user isn't in).  These wouldn't be reachable by walking
    // `joinedSpaceIdSet`, so we surface them under Home instead.
    for (const sp of spaces) {
      for (const r of roomsBySpace(sp.id)) {
        if (r.isSpace) continue;
        const hasJoinedParent = r.parentSpaceIds.some((pid) =>
          joinedSpaceIdSet.has(pid),
        );
        if (!hasJoinedParent) add(r);
      }
    }
    return ids;
  }, [roomsBySpace, spaces, joinedSpaceIdSet]);

  const isHomeUnread = useCallback(() => {
    for (const id of homeRoomIds) if (isUnread(id)) return true;
    return false;
  }, [homeRoomIds, isUnread]);

  const isHomeNotified = useCallback(() => {
    for (const id of homeRoomIds) if (notificationCount(id) > 0) return true;
    return false;
  }, [homeRoomIds, notificationCount]);

  const homeMentionCount = useCallback(() => {
    let total = 0;
    for (const id of homeRoomIds) total += mentionCount(id);
    return total;
  }, [homeRoomIds, mentionCount]);

  const effectiveHomeMentionCount = useCallback(() => {
    let total = 0;
    for (const id of homeRoomIds) total += effectiveMentionCount(id);
    return total;
  }, [homeRoomIds, effectiveMentionCount]);

  return {
    isSpaceUnread,
    isSpaceNotified,
    spaceMentionCount,
    isHomeUnread,
    isHomeNotified,
    homeMentionCount,
    effectiveMentionCount,
    effectiveSpaceMentionCount,
    effectiveHomeMentionCount,
  };
}