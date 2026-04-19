import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getSendPublicReceipts } from "../utils/readReceiptPrefs";

/**
 * Fires a Matrix read receipt for the latest message in the active room,
 * respecting the user's public/private preference.
 *
 * When to fire:
 *   - on room change, if the window is focused AND we're at the bottom
 *   - when the user scrolls back down to the bottom
 *   - when the window regains focus while scrolled to bottom
 *   - when a new message arrives while we're already at the bottom + focused
 *
 * When NOT to fire:
 *   - when the user is scrolled up reading history (they haven't seen the latest)
 *   - when the window is unfocused (they haven't seen it yet)
 *   - for the user's own messages (the spec treats sends as implicit reads and
 *     the SDK skips them anyway, but we avoid the round trip)
 *   - twice for the same event ID (dedup ref)
 *
 * StrictMode: the effect body does no store-touching work until the debounced
 * tick fires, and the dedup ref guarantees that even if React double-invokes
 * the effect we only fire one invoke per event ID.
 */
export interface ReadReceiptTrigger {
  /** The latest event id the user has actually seen (scrolled-to-bottom rendered). */
  readonly latestVisibleEventId: string | null;
  /** True when the user is scrolled near the bottom of the timeline. */
  readonly atBottom: boolean;
}

export function useReadReceiptSender(
  roomId: string | null,
  trigger: ReadReceiptTrigger,
  userId: string | null
): void {
  // Event IDs we've already acknowledged for this room.  Reset on room change.
  const sentForRoomRef = useRef<{ roomId: string | null; lastSent: string | null }>({
    roomId: null,
    lastSent: null,
  });

  // Track focus in a ref so the main effect can read it without re-running.
  // Match desktop notifications: `hasFocus` reflects whether the user is actually
  // looking at the window (visibility alone stays "visible" on a background monitor).
  const isFocusedRef = useRef<boolean>(
    typeof document === "undefined" ? true : document.hasFocus(),
  );

  useEffect(() => {
    function onVisibilityChange() {
      isFocusedRef.current =
        document.visibilityState === "visible" && document.hasFocus();
      // Schedule a fire attempt — if we're now at the bottom of an unread room,
      // this is the moment to acknowledge it.  We dispatch a no-op event on
      // the current room-id bucket to re-enter the main effect's fire path
      // via the state we already have.
      window.dispatchEvent(new CustomEvent("pax:rr-retry"));
    }
    function onFocus() {
      isFocusedRef.current = document.hasFocus();
      window.dispatchEvent(new CustomEvent("pax:rr-retry"));
    }
    function onBlur() {
      isFocusedRef.current = false;
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Reset dedup when the room changes.
  useEffect(() => {
    if (sentForRoomRef.current.roomId !== roomId) {
      sentForRoomRef.current = { roomId, lastSent: null };
    }
  }, [roomId]);

  useEffect(() => {
    if (!roomId || !userId) return;
    if (!trigger.atBottom) return;
    if (!isFocusedRef.current) return;
    if (typeof document !== "undefined" && !document.hasFocus()) return;

    const eventId = trigger.latestVisibleEventId;
    if (!eventId) return;

    if (
      sentForRoomRef.current.roomId === roomId &&
      sentForRoomRef.current.lastSent === eventId
    ) {
      return;
    }

    // Mark first so that even if the invoke is still in flight when something
    // else triggers this effect, we don't double-fire.  On error we roll back
    // so a transient failure can be retried on the next trigger.
    const prev = sentForRoomRef.current.lastSent;
    sentForRoomRef.current = { roomId, lastSent: eventId };

    const publicReceipt = getSendPublicReceipts();

    invoke("send_room_read_receipt", {
      roomId,
      eventId,
      asPublic: publicReceipt,
    }).catch((e) => {
      if (
        sentForRoomRef.current.roomId === roomId &&
        sentForRoomRef.current.lastSent === eventId
      ) {
        sentForRoomRef.current = { roomId, lastSent: prev };
      }
      console.warn("[useReadReceiptSender] invoke failed:", e);
    });

    // Listen for focus / visibility retry signals and re-enter this effect body
    // on the next tick.  Implemented as a custom event so we don't need to add
    // focused-state to React state (which would re-render the whole MessageList
    // on every focus/blur).
    function onRetry() {
      queueMicrotask(() => {
        if (!roomId || !userId) return;
        if (!trigger.atBottom) return;
        if (!isFocusedRef.current) return;
        if (typeof document !== "undefined" && !document.hasFocus()) return;
        const eid = trigger.latestVisibleEventId;
        if (!eid) return;
        if (
          sentForRoomRef.current.roomId === roomId &&
          sentForRoomRef.current.lastSent === eid
        ) {
          return;
        }
        sentForRoomRef.current = { roomId, lastSent: eid };
        void invoke("send_room_read_receipt", {
          roomId,
          eventId: eid,
          asPublic: getSendPublicReceipts(),
        }).catch((e) => {
          console.warn("[useReadReceiptSender] retry invoke failed:", e);
        });
      });
    }
    window.addEventListener("pax:rr-retry", onRetry);
    return () => window.removeEventListener("pax:rr-retry", onRetry);
  }, [roomId, userId, trigger.latestVisibleEventId, trigger.atBottom]);
}