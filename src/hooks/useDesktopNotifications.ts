import { useEffect, useRef } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useIgnoredUsers } from "../context/IgnoredUsersContext";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSound } from "react-sounds";
import type { Message, Room } from "../types/matrix";
import { isOneToOneChatUi } from "../utils/dmDisplay";
import { androidMessagePreviews } from "../utils/messageNotificationPreviews";
import { useNotificationSettings, type NotificationLevel } from "./useNotificationSettings";

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
  /** `matrix-sdk is_direct()` — true for rooms marked as direct chats. */
  isDm: boolean;
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
 * Notification title. One-to-one DMs show the sender's name. Other rooms show
 * "<sender> (<room>)" so the room identity is visible at a glance.
 */
function formatTitle(room: Room | null, senderName: string): string {
  const sender = senderName || "Someone";
  if (!room) return sender;
  if (isOneToOneChatUi(room)) return sender;
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

/** Play the desktop alert sound and handle local mobile alerts. */
export function useDesktopNotifications({
  userId,
  activeRoomId,
  getRoom,
}: DesktopNotificationsOptions): void {
  const { userIds: ignoredUsers } = useIgnoredUsers();
  const ignoredUsersRef = useRef(ignoredUsers);
  ignoredUsersRef.current = ignoredUsers;
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

  const { getRoomEffectiveLevel } = useNotificationSettings();
  const resolveLevelRef = useRef(getRoomEffectiveLevel);
  resolveLevelRef.current = getRoomEffectiveLevel;

  // Permission check + message subscription.
  useEffect(() => {
    if (!userId || !isTauri()) return;

    let cancelled = false;
    let permissionGranted = false;
    let unlisten: UnlistenFn | undefined;

    function playSound() {
      void playNotificationRef.current().catch((error) =>
        console.warn("[useDesktopNotifications] notification sound failed:", error),
      );
    }

    async function resolveLevel(roomId: string): Promise<NotificationLevel> {
      try {
        return await resolveLevelRef.current(roomId);
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
      if (message.sender === userIdRef.current || ignoredUsersRef.current.has(message.sender)) return;

      // Active-room + focused: user can see it, don't interrupt.
      if (
        roomId === activeRoomRef.current &&
        isFocusedRef.current
      ) {
        return;
      }

      const level = await resolveLevel(roomId);
      if (cancelled) return;
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

      if (cancelled || ignoredUsersRef.current.has(message.sender)) return;
      const room = getRoomRef.current(roomId);
      const previews = androidMessagePreviews();
      const title = previews
        ? message.senderName || message.sender
        : formatTitle(room, message.senderName || "");
      try {
        if (previews?.showMessageNotification) {
          previews.showMessageNotification(
            roomId, message.eventId, title, isDm ? null : room?.name.trim() || null,
            message.decryptionFailed ? null : message.body,
          );
        } else {
          const body = previews && (!previews.getShowMessagePreviews() || message.decryptionFailed || !message.body?.trim())
            ? "New message"
            : truncate(message.body ?? "", 200);
          await invoke("notify_send", { title: truncate(title, 80), body, iconPath: null });
        }
        // Android's notification channel handles sound and vibration in the current ringer mode.
        if (!previews) playSound();
      } catch (e) {
        console.warn("[useDesktopNotifications] notify_send failed:", e);
      }
    }

    (async () => {
      // A signed-in Android app needs permission even when Firebase handles delivery.
      const android = (window as Window & { PaxAndroid?: { requestNotificationPermission?(): void } }).PaxAndroid;
      android?.requestNotificationPermission?.();
      const delivery = await invoke<"desktop" | "mobilePush" | "mobileLocal">("message_notification_delivery");
      if (cancelled || delivery === "mobilePush") return;
      if (delivery === "desktop") {
        unlisten = await listen<string>("desktop-message-notified", ({ payload }) => {
          if (!cancelled && payload === userId) playSound();
        }, { target: "main" });
      } else {
        permissionGranted = await invoke<boolean>("notify_supported").catch(() => false);
        if (cancelled) return;
        unlisten = await listen<RoomMessagePayload>("room-message", ({ payload }) => {
          if (!cancelled) void handleMessage(payload);
        });
      }
      if (cancelled) unlisten();
    })().catch((error) => console.warn("[useDesktopNotifications] setup failed:", error));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [userId]);
}
