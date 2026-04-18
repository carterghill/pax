import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Message, Room } from "../types/matrix";
import type { NotificationLevel } from "./useNotificationSettings";

/* ------------------------------------------------------------------ */
/*  Payload types                                                      */
/* ------------------------------------------------------------------ */

interface RoomMessagePayload {
  roomId: string;
  message: Message;
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
/*  Mention matching                                                   */
/* ------------------------------------------------------------------ */

/**
 * Does `body` mention the user?  Case-insensitive substring match on the
 * localpart.  Deliberately loose — false positives (e.g. "alice" matching
 * when the user is `@alice:foo` and someone says "palace") are acceptable
 * here because the push-rule layer is already doing the same loose match
 * for actual mobile pushes, so we'd see the same behaviour anyway.  Keeping
 * this cheap avoids a regex compile per incoming message.
 */
function bodyMentionsUser(body: string, mxidLocalpart: string): boolean {
  if (!mxidLocalpart) return false;
  return body.toLowerCase().includes(mxidLocalpart.toLowerCase());
}

function bodyHasRoomPing(body: string): boolean {
  return body.includes("@room");
}

/**
 * Given an effective level and the message body, decide whether to notify.
 * Mirrors the per-level semantics from the reconciler module docs:
 *
 *   - all          → always
 *   - allMentions  → @room or user mention
 *   - userMentions → user mention only
 *   - roomPings    → @room only
 *   - none         → never
 */
function shouldNotifyForLevel(
  level: NotificationLevel,
  body: string,
  mxidLocalpart: string,
): boolean {
  switch (level) {
    case "all":
      return true;
    case "allMentions":
      return bodyHasRoomPing(body) || bodyMentionsUser(body, mxidLocalpart);
    case "userMentions":
      return bodyMentionsUser(body, mxidLocalpart);
    case "roomPings":
      return bodyHasRoomPing(body);
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
 * Suppression logic:
 *   - Own messages never notify.
 *   - If the message is in the currently-active room AND the window is
 *     focused, don't notify — the user is looking right at it.
 *   - Otherwise, consult the room's effective level and body content via
 *     `shouldNotifyForLevel`.
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
    const mxidLocalpart = userId.startsWith("@")
      ? userId.slice(1).split(":")[0]
      : userId.split(":")[0];

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
      const { roomId, message } = payload;

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
      if (
        !shouldNotifyForLevel(level, message.body ?? "", mxidLocalpart)
      ) {
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