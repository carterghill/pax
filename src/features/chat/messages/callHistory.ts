import type { Message } from "../../../types/matrix";

interface CallHistory {
  anchor: Message;
  signals: Message[];
}

type CallOutcome = "placed" | "answered" | "completed" | "missed" | "declined" | "canceled" | "failed" | "dropped" | "ended" | "unknown";

export interface CallSummary {
  caller?: Message;
  invitee?: string;
  callee?: Message;
  outcome: CallOutcome;
  endedAt?: number;
  durationMs?: number;
  estimatedDuration?: boolean;
  expiresAt?: number;
}

export function getCallDuration(startedAt?: number, endedAt = Date.now()): number | undefined {
  if (startedAt === undefined) return;
  const duration = Math.floor(endedAt - startedAt);
  return Number.isSafeInteger(duration) && duration >= 0 ? duration : undefined;
}

function summarizeCall({ anchor, signals }: CallHistory, now: number): CallSummary {
  const caller = anchor.directCallNotice?.kind === "ring" ? anchor : undefined;
  if (!caller) {
    const end = signals.find((event) => event.directCallNotice?.kind === "end");
    return { outcome: end ? "ended" : "unknown", endedAt: end?.timestamp };
  }

  const { invitee, expiresAt } = caller.directCallNotice!;
  const callee = signals.find((event) => event.sender !== caller.sender && (!invitee || event.sender === invitee));
  const selection = signals.find((event) => event.sender === caller.sender && event.directCallNotice?.kind === "connect");
  const selectedParty = selection?.directCallNotice?.selectedPartyId;
  const responses = signals.filter((event) => {
    const notice = event.directCallNotice!;
    return event.sender !== caller.sender && (!invitee || event.sender === invitee)
      && (notice.kind === "answer" || (notice.kind === "end"
        && (notice.endReason === "declined" || notice.endReason === "legacyHangup")));
  });
  const response = selectedParty
    ? responses.find((event) => event.directCallNotice?.partyId === selectedParty)
    : responses[0];
  const base = { caller, invitee, callee };
  if (response?.directCallNotice?.kind === "end" && (!selection || selectedParty)) {
    return { ...base, outcome: "declined", endedAt: response.timestamp };
  }
  const connected = selectedParty ? (response?.directCallNotice?.kind === "answer" ? selection : undefined) : selection;
  const accepted = connected ?? (response?.directCallNotice?.kind === "answer" ? response : undefined);
  const end = signals.find((event) => {
    const notice = event.directCallNotice!;
    return notice.kind === "end" && notice.endReason !== "declined"
      && (event.sender === caller.sender || ((!invitee || event.sender === invitee)
        && (!selectedParty || notice.partyId === selectedParty)));
  });

  if (!end) {
    if (accepted) return { ...base, outcome: "answered" };
    if (!selection && expiresAt !== undefined && expiresAt <= now) return { ...base, outcome: "missed", endedAt: expiresAt };
    return { ...base, outcome: "placed", expiresAt: selection ? undefined : expiresAt };
  }

  const { endReason, durationMs } = end.directCallNotice!;
  const finished = { ...base, endedAt: end.timestamp };
  if (endReason === "failed" && durationMs === undefined) return { ...finished, outcome: "failed" };
  if (endReason === "missed") return { ...finished, outcome: "missed" };
  if (accepted || durationMs !== undefined || endReason === "dropped") {
    const measured = durationMs ?? getCallDuration(accepted?.timestamp, end.timestamp);
    const outcome = endReason === "dropped" || endReason === "failed" ? "dropped" : "completed";
    return { ...finished, outcome, durationMs: measured, estimatedDuration: durationMs === undefined };
  }
  if (!selection && expiresAt !== undefined && end.timestamp >= expiresAt && end.sender === caller.sender) {
    return { ...finished, outcome: "missed" };
  }
  return { ...finished, outcome: !selection && end.sender === caller.sender ? "canceled" : "ended" };
}

export function describeCall(call: CallSummary, userId: string, peerName?: string): string {
  if (!call.caller) return call.outcome === "ended" ? "Voice call ended" : "Voice call";
  const outgoing = call.caller.sender === userId;
  const peer = peerName || "the other person";
  const subject = peerName || "The other person";
  const direction = outgoing ? `Your call to ${peer}` : `${subject}’s call to you`;
  switch (call.outcome) {
    case "missed": return outgoing ? `${subject} missed your call` : `You missed a call from ${peer}`;
    case "declined": return outgoing ? `${subject} declined your call` : `You declined ${peer}’s call`;
    case "answered": return outgoing ? `${subject} answered your call` : `You answered a call from ${peer}`;
    case "completed":
    case "ended": return `${direction} ended`;
    case "failed": return `${direction} couldn’t connect`;
    case "dropped": return `${direction} dropped`;
    case "canceled": return outgoing ? `You canceled your call to ${peer}` : `${subject} canceled their call to you`;
    default: return outgoing ? `You called ${peer}` : `${subject} called you`;
  }
}

export function formatCallDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds % 60 || !parts.length) parts.push(`${seconds % 60}s`);
  return seconds === 0 ? "<1s" : parts.join(" ");
}

function callKey(message: Message, callId: string): string {
  return `${message.historyRoomId ?? ""}\0${callId}`;
}

export function projectCallHistory(timeline: Message[], latestEventId?: string | null, now = Date.now(), userId?: string) {
  const calls = new Map<string, CallHistory>();
  let lastEvent: Message | undefined;
  let timelineHead: Message | undefined;

  for (const message of timeline) {
    if (!message.eventId.startsWith("local:")) lastEvent = message;
    if (message.eventId === latestEventId) timelineHead = message;
    const notice = message.directCallNotice;
    if (!notice) continue;

    const key = callKey(message, notice.callId);
    const call = calls.get(key) ?? { anchor: message, signals: [] };
    if (notice.kind === "ring" && call.anchor.directCallNotice?.kind !== "ring") {
      call.anchor = message;
    }
    call.signals.push(message);
    calls.set(key, call);
  }

  const anchors = new Map<string, string>();
  const callSummaries = new Map<string, CallSummary>();
  let nextCallExpiry: number | undefined;
  for (const call of calls.values()) {
    const summary = summarizeCall(call, now);
    callSummaries.set(call.anchor.eventId, summary);
    if (summary.expiresAt !== undefined && (nextCallExpiry === undefined || summary.expiresAt < nextCallExpiry)) {
      nextCallExpiry = summary.expiresAt;
    }
  }
  const messages = calls.size === 0 ? timeline : timeline.filter((message) => {
    const notice = message.directCallNotice;
    if (!notice) return true;
    const anchor = calls.get(callKey(message, notice.callId))!.anchor.eventId;
    anchors.set(message.eventId, anchor);
    const summary = callSummaries.get(anchor);
    if (userId && summary?.invitee && summary.caller?.sender !== userId && summary.invitee !== userId) return false;
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
    callSummaries,
    nextCallExpiry,
    readThroughEventId: readThrough?.historyRoomId ? null : readThrough?.eventId ?? null,
  };
}

/** Bound visible rows while retaining every signal needed to render each call. */
export function trimTimelineWindow(
  timeline: Message[],
  maxRows: number,
  keep: "oldest" | "latest",
): Message[] {
  const { messages, anchors } = projectCallHistory(timeline);
  if (messages.length <= maxRows) return timeline;

  const rows = keep === "oldest" ? messages.slice(0, maxRows) : messages.slice(-maxRows);
  const retained = new Set(rows.map((message) => message.eventId));
  return timeline.filter((message) => retained.has(anchors.get(message.eventId) ?? message.eventId));
}
