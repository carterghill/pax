import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSound } from "react-sounds";
import type { Message, Room } from "../types/matrix";
import type { NotificationLevel } from "./useNotificationSettings";

/* ------------------------------------------------------------------ */
/*  Payload types                                                      */
/* ------------------------------------------------------------------ */

interface RoomMessagePayload {
  roomId: string;
  message: Message;
  /** Structured `m.mentions`: the sender's `user_ids` list includes our MXID. */
  mentionsMe: boolean;
  /** Structured `m.mentions`: the sender set `room: true` (@room ping). */
  roomPing: boolean;
  /** `matrix-sdk is_direct()` — true for 1:1 DMs. */
  isDm: boolean;
}

/* ------------------------------------------------------------------ */
/*  Level cache                                                        */
/* ------------------------------------------------------------------ */

/**
 * TTL cache for per-room effective notification level.  `get_room_notification_level`
 * walks account data + space children + m.direct every call, which is a non-trivial
 * amount of backend work per message — caching for a minute cuts the typical
 * chat-of-active-users case from "one resolve per message" to "one resolve per
 * minute per room", and invalidation on `pax-notification-settings-changed`
 * means explicit user changes are reflected immediately.
 */
const LEVEL_TTL_MS = 60_000;

interface LevelCacheEntry {
  level: NotificationLevel;
  expiresAt: number;
}

/* ------------------------------------------------------------------ */
/*  Notification decision                                              */
/* ------------------------------------------------------------------ */

/**
 * Given an effective level and the structured mention data from the Rust
 * payload, decide whether to notify.
 *
 * This mirrors the badge's logic so the two stay in sync:
 *
 *   - `mentionsMe` / `roomPing` are derived from the event's `m.mentions`
 *     content on the Rust side — the same structured data the server uses
 *     for push-rule highlight evaluation (which feeds `highlight_count` /
 *     `num_unread_mentions` on the badge side).
 *
 *   - For DMs, the badge uses `effectiveMentionCount` which promotes every
 *     unread DM message to the red badge (unless muted).  We mirror that
 *     here: in a DM, any level that cares about mentions also notifies on
 *     every message, because the whole point of a DM is that every message
 *     is addressed to you.  Muted DMs (level `none`) are handled before
 *     this function is reached — the level resolves to `none` and we
 *     return `false` immediately.
 *
 * Level semantics (unchanged from the user's perspective):
 *   - all          → always
 *   - allMentions  → @room ping, user mention, or any DM message
 *   - userMentions → user mention or any DM message
 *   - roomPings    → @room ping only (DMs don't produce @room pings)
 *   - none         → never
 */
function shouldNotifyForLevel(
  level: NotificationLevel,
  mentionsMe: boolean,
  roomPing: boolean,
  isDm: boolean,
): boolean {
  switch (level) {
    case "all":
      return true;
    case "allMentions":
      // DM promotion: every DM message is notification-worthy, matching
      // the badge's effectiveMentionCount behaviour.
      if (isDm) return true;
      return roomPing || mentionsMe;
    case "userMentions":
      // DM promotion: same reasoning — every DM message is "to you".
      if (isDm) return true;
      return mentionsMe;
    case "roomPings":
      return roomPing;
    case "none":
      return false;
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Title/body formatting                                              */
/* ------------------------------------------------------------------ */

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // Preserve the start; middle-truncate doesn't add much for chat text.
  return s.slice(0, max - 1) + "…";
}

/**
 * Notification title.  DMs show the sender's name; group rooms show
 * "<sender> (<room>)" so the room identity is visible at a glance.
 */
function formatTitle(room: Room | null, senderName: string): string {
  const sender = senderName || "Someone";
  if (!room) return sender;
  if (room.isDirect) return sender;
  const roomName = room.name || "a room";
  return `${sender} (${roomName})`;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                                */
/* ------------------------------------------------------------------ */

export interface DesktopNotificationsOptions {
  /** Current user's MXID (`@localpart:server`).  Null disables notifications. */
  userId: string | null;
  /** The room the UI is showing right now.  Messages in this room are
   *  suppressed while the window is focused. */
  activeRoomId: string | null;
  /** Synchronous lookup from `useRooms()`. */
  getRoom: (roomId: string) => Room | null;
}

/**
 * Subscribes to `room-message` events and dispatches desktop notifications
 * according to the user's configured notification level.
 *
 * Mention detection uses the structured `m.mentions` data from the event
 * (piped through the `room-message` payload as `mentionsMe` / `roomPing`),
 * which is the same data the server uses for push-rule highlight evaluation.
 * This keeps desktop notifications aligned with the red-badge mention count
 * that uses `highlight_count` / `num_unread_mentions`.
 *
 * DM promotion mirrors `effectiveMentionCount`: in a non-muted DM, every
 * incoming message is treated as notification-worthy for levels that care
 * about mentions (`allMentions`, `userMentions`), because the server doesn't
 * set highlights for plain DM text but the whole point of a DM is that
 * every message is addressed to you.
 *
 * Suppression logic:
 *   - Own messages never notify.
 *   - If the message is in the currently-active room AND the window is
 *     focused, don't notify — the user is looking right at it.
 *   - Otherwise, consult the room's effective level and structured mention
 *     data via `shouldNotifyForLevel`.
 *
 * The hook also handles the plugin's click action (`notification`), which
 * focuses the main window and emits `pax-notification-clicked` with the
 * room id.  MainLayout listens for that event and switches the active
 * room — kept here (emit) + there (consume) so this hook doesn't reach
 * into MainLayout's state directly.
 */
export function useDesktopNotifications({
  userId,
  activeRoomId,
  getRoom,
}: DesktopNotificationsOptions): void {
  // `useSound().play()` resumes Howler's AudioContext before playing;
  // standalone `playSound()` does not, so the first inbound notifications
  // (before / without a matching user gesture) can be silent while voice
  // UI sounds still work after the user has clicked around.
  const { play: playNotificationSound } = useSound("/sounds/notification.mp3");
  const playNotificationRef = useRef(playNotificationSound);
  playNotificationRef.current = playNotificationSound;

  // Refs so the main effect body reads live values without re-subscribing
  // on every change.  Without this the `room-message` listener would tear
  // down and re-bind on every keystroke-driven render of MainLayout.
  const activeRoomRef = useRef<string | null>(activeRoomId);
  const getRoomRef = useRef(getRoom);
  const userIdRef = useRef<string | null>(userId);
  useEffect(() => {
    activeRoomRef.current = activeRoomId;
  }, [activeRoomId]);
  useEffect(() => {
    getRoomRef.current = getRoom;
  }, [getRoom]);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  // Window focus.  `visibilitychange` alone isn't enough on desktop —
  // alt-tabbing away doesn't always hide the window — so focus/blur cover
  // the gap.  Mirrors `useReadReceiptSender`'s approach exactly.
  const isFocusedRef = useRef<boolean>(
    typeof document === "undefined" ? true : document.hasFocus(),
  );
  useEffect(() => {
    const onVis = () => {
      isFocusedRef.current = document.visibilityState === "visible";
    };
    const onFocus = () => {
      isFocusedRef.current = true;
    };
    const onBlur = () => {
      isFocusedRef.current = false;
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Level cache — Map keyed by roomId.  Lives outside the effect so
  // StrictMode double-mount doesn't lose entries.
  const levelCacheRef = useRef<Map<string, LevelCacheEntry>>(new Map());

  // Permission check + message subscription.
  useEffect(() => {
    if (!userId) return;

    let cancelled = false;
    let permissionGranted = false;
    const unlisteners: UnlistenFn[] = [];

    // Best-effort "which room did the user just click to open?" — the
    // plugin's click event doesn't round-trip custom data well, so we
    // stash the last-shown notification's roomId here when `notify_send`
    // succeeds and read it back when the click event fires.
    const lastClickRoomIdRef = { current: null as string | null };

    async function resolveLevel(roomId: string): Promise<NotificationLevel> {
      const cached = levelCacheRef.current.get(roomId);
      const now = Date.now();
      if (cached && cached.expiresAt > now) return cached.level;
      try {
        const level = await invoke<NotificationLevel>(
          "get_room_notification_level",
          { roomId },
        );
        levelCacheRef.current.set(roomId, {
          level,
          expiresAt: now + LEVEL_TTL_MS,
        });
        return level;
      } catch (e) {
        console.warn(
          "[useDesktopNotifications] get_room_notification_level failed:",
          e,
        );
        // Fall back to "all" rather than swallow — a settings-backend
        // outage shouldn't silently mute the app.
        return "all";
      }
    }

    async function handleMessage(payload: RoomMessagePayload) {
      const { roomId, message, mentionsMe, roomPing, isDm } = payload;

      // Own message — ignore.
      if (message.sender === userIdRef.current) return;

      // Active-room + focused: user can see it, don't interrupt.
      if (
        roomId === activeRoomRef.current &&
        isFocusedRef.current
      ) {
        return;
      }

      const level = await resolveLevel(roomId);
      if (!shouldNotifyForLevel(level, mentionsMe, roomPing, isDm)) {
        return;
      }

      // Permission gate.  Checked per-message-to-be-shown rather than once
      // at startup so a user who grants permission mid-session starts
      // getting notifications without a restart.
      if (!permissionGranted) {
        try {
          permissionGranted = await invoke<boolean>("notify_supported");
        } catch {
          permissionGranted = false;
        }
        if (!permissionGranted) return;
      }

      const room = getRoomRef.current(roomId);
      const title = formatTitle(room, message.senderName || "");
      // Attach a payload that can be fished out by the click handler.
      // The plugin's click event doesn't round-trip custom data well,
      // so we stash the most-recent-notification's roomId for the click
      // handler to use.
      lastClickRoomIdRef.current = roomId;

      try {
        await invoke("notify_send", {
          title: truncate(title, 80),
          body: truncate(message.body ?? "", 200),
          iconPath: null,
        });
        void playNotificationRef.current()
          .catch((err) =>
            console.warn(
              "[useDesktopNotifications] notification sound failed:",
              err,
            ),
          );
      } catch (e) {
        console.warn("[useDesktopNotifications] notify_send failed:", e);
      }
    }

    (async () => {
      try {
        permissionGranted = await invoke<boolean>("notify_supported");
      } catch {
        permissionGranted = false;
      }
      if (cancelled) return;

      const offMsg = await listen<RoomMessagePayload>(
        "room-message",
        (e) => {
          if (cancelled) return;
          handleMessage(e.payload);
        },
      );
      unlisteners.push(offMsg);

      // Settings changed → drop the level cache so the next message
      // resolves freshly.  We don't pre-warm — lazy resolve on the next
      // incoming message is fine and avoids a fan-out query.
      const offSettings = await listen(
        "pax-notification-settings-changed",
        () => {
          levelCacheRef.current.clear();
        },
      );
      unlisteners.push(offSettings);

      // Plugin click action → focus window + let MainLayout know which
      // room to jump to.  The plugin's `notification` event fires on
      // click; payload isn't reliably round-tripped, so we use
      // `lastClickRoomIdRef` as a best-effort hint (last notification
      // shown — good enough for "I clicked the toast that just popped").
      const offClick = await listen("notification", () => {
        if (cancelled) return;
        invoke("focus_main_window").catch(() => {
          /* best effort */
        });
        const roomId = lastClickRoomIdRef.current;
        if (roomId) {
          window.dispatchEvent(
            new CustomEvent("pax-notification-clicked", { detail: { roomId } }),
          );
        }
      });
      unlisteners.push(offClick);
    })();

    return () => {
      cancelled = true;
      for (const off of unlisteners) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
    };
  }, [userId]);
}