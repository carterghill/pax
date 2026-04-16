import { useCallback, useEffect, useRef, useState } from "react";
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

  return { isUnread, mentionCount, messageCount };
}

/** Hint type for callers that want to store the latest snapshot outside React. */
export const EMPTY_UNREAD_STATE: Readonly<RoomUnreadState> = EMPTY;