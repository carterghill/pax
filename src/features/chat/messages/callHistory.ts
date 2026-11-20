import type { Message } from "../../../types/matrix";

interface CallHistory {
  anchor: Message;
  accepted: boolean;
  ended: boolean;
}

function callKey(message: Message, callId: string): string {
  return `${message.historyRoomId ?? ""}\0${callId}`;
}

export function projectCallHistory(timeline: Message[], latestEventId?: string | null) {
  const calls = new Map<string, CallHistory>();
  let lastEvent: Message | undefined;
  let timelineHead: Message | undefined;

  for (const message of timeline) {
    if (!message.eventId.startsWith("local:")) lastEvent = message;
    if (message.eventId === latestEventId) timelineHead = message;
    const notice = message.directCallNotice;
    if (!notice) continue;

    const key = callKey(message, notice.callId);
    const call = calls.get(key) ?? { anchor: message, accepted: false, ended: false };
    if (notice.kind === "ring" && call.anchor.directCallNotice?.kind !== "ring") {
      call.anchor = message;
    }
    call.accepted ||= notice.kind === "answer" || notice.kind === "connect";
    call.ended ||= notice.kind === "end";
    calls.set(key, call);
  }

  const anchors = new Map<string, string>();
  const missedCalls = new Set<string>();
  for (const { anchor, accepted, ended } of calls.values()) {
    if (anchor.directCallNotice?.kind === "ring" && ended && !accepted) {
      missedCalls.add(anchor.eventId);
    }
  }
  const messages = calls.size === 0 ? timeline : timeline.filter((message) => {
    const notice = message.directCallNotice;
    if (!notice) return true;
    const anchor = calls.get(callKey(message, notice.callId))!.anchor.eventId;
    anchors.set(message.eventId, anchor);
    return message.eventId === anchor;
  });

  // Receipts cover the underlying signals, including those folded into a row.
  // Prefer the server's order at the head when timestamps put a call out of order.
  const readThrough = timelineHead && (timelineHead.directCallNotice || lastEvent?.directCallNotice)
    ? timelineHead
    : lastEvent;
  return {
    messages,
    anchors,
    missedCalls,
    readThroughEventId: readThrough?.historyRoomId ? null : readThrough?.eventId ?? null,
  };
}
