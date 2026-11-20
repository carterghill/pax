import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getSendPublicReceipts } from "../utils/readReceiptPrefs";

export interface ReadReceiptTrigger {
  /** Latest event covered by the visible timeline, including grouped call signals. */
  readonly readThroughEventId: string | null;
  /** True when the user is scrolled near the bottom of the latest timeline page. */
  readonly atBottom: boolean;
  /** An unavailable message needs explicit acknowledgement before advancing. */
  readonly blocked?: boolean;
  /** Acknowledging a gap must never broadcast a public read receipt. */
  readonly privateOnly?: boolean;
  readonly alreadyAcknowledgedEventId?: string | null;
}

export function useReadReceiptSender(
  roomId: string | null,
  { readThroughEventId, atBottom, blocked, privateOnly, alreadyAcknowledgedEventId }: ReadReceiptTrigger,
  userId: string | null,
): void {
  const sentRef = useRef<{ roomId: string | null; eventId: string | null }>({
    roomId: null,
    eventId: null,
  });

  useEffect(() => {
    sentRef.current = { roomId, eventId: null };
  }, [roomId, userId]);

  useEffect(() => {
    if (!roomId || !userId || blocked || !atBottom || !readThroughEventId) return;
    if (readThroughEventId === alreadyAcknowledgedEventId) return;

    function sendReceipt() {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      const previous = sentRef.current;
      if (previous.roomId === roomId && previous.eventId === readThroughEventId) return;

      const next = { roomId, eventId: readThroughEventId };
      sentRef.current = next;
      void invoke("send_room_read_receipt", {
        roomId,
        eventId: readThroughEventId,
        asPublic: !privateOnly && getSendPublicReceipts(),
      }).catch((error) => {
        if (sentRef.current === next) sentRef.current = previous;
        console.warn("[useReadReceiptSender] invoke failed:", error);
      });
    }

    sendReceipt();
    window.addEventListener("focus", sendReceipt);
    document.addEventListener("visibilitychange", sendReceipt);
    return () => {
      window.removeEventListener("focus", sendReceipt);
      document.removeEventListener("visibilitychange", sendReceipt);
    };
  }, [roomId, userId, readThroughEventId, atBottom, blocked, privateOnly, alreadyAcknowledgedEventId]);
}
