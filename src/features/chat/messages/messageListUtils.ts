import type { Message, MessageReaction, RoomRedactionPolicy } from "../../../types/matrix";

/* ------------------------------------------------------------------ */
/*  DOM geometry helpers (popover positioning)                         */
/* ------------------------------------------------------------------ */

export function getMessageActionBarLeftEdge(anchor: HTMLElement | null): number | null {
  if (!anchor) return null;
  const bar = anchor.closest(".pax-message-actions");
  if (!bar) return null;
  const firstBtn = bar.querySelector("button");
  if (!firstBtn) return null;
  return firstBtn.getBoundingClientRect().left;
}

export function getMessageActionGroupRect(anchor: HTMLElement | null): DOMRect | null {
  if (!anchor) return null;
  const bar = anchor.closest(".pax-message-actions");
  if (!bar) return null;
  const group = bar.firstElementChild;
  if (!group || !(group instanceof HTMLElement)) return null;
  return group.getBoundingClientRect();
}

export function clampFixedPopoverToViewport(
  pop: DOMRect,
  margin: number,
): { top: number; right: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = pop.left;
  let top = pop.top;
  if (left < margin) left = margin;
  if (left + pop.width > vw - margin) {
    left = Math.max(margin, vw - margin - pop.width);
  }
  if (top < margin) top = margin;
  if (top + pop.height > vh - margin) {
    top = Math.max(margin, vh - margin - pop.height);
  }
  return {
    top,
    right: vw - left - pop.width,
  };
}

/* ------------------------------------------------------------------ */
/*  Message grouping & reply previews                                  */
/* ------------------------------------------------------------------ */

export function shouldShowHeader(msg: Message, prevMsg: Message | null): boolean {
  if (!prevMsg) return true;
  if (prevMsg.sender !== msg.sender) return true;
  if (msg.timestamp - prevMsg.timestamp > 5 * 60 * 1000) return true;
  return false;
}

export function replySnippetForMessage(m: Message): string {
  if (m.imageMediaRequest || m.localImagePreviewObjectUrl) return "Image";
  if (m.videoMediaRequest) return "Video";
  if (m.fileMediaRequest) return m.fileDisplayName?.trim() || "File";
  const ty = m.unsupportedMatrixMsgtype?.trim();
  if (ty) {
    const t = m.body.trim();
    const base = t || "Unsupported message";
    return `${base} · ${ty}`;
  }
  const t = m.body.trim();
  if (t.length > 120) return `${t.slice(0, 120)}…`;
  return t || "Message";
}

export function getReplyThreadPreview(
  msg: Message,
  byId: Map<string, Message>,
): { targetEventId: string; senderLabel: string; text: string } | null {
  const id = msg.replyTo?.eventId;
  if (!id) return null;
  const parent = byId.get(id);
  if (parent) {
    return {
      targetEventId: id,
      senderLabel: (parent.senderName?.trim() || parent.sender).trim(),
      text: replySnippetForMessage(parent),
    };
  }
  return {
    targetEventId: id,
    senderLabel: "…",
    text: "Original message not in view",
  };
}

/* ------------------------------------------------------------------ */
/*  Reactions                                                          */
/* ------------------------------------------------------------------ */

export function reactionHoverLines(
  r: MessageReaction,
  resolveLabel: (userId: string) => string,
  currentUserId: string,
): string[] {
  if (r.reactedBy && r.reactedBy.length > 0) {
    const labels = r.reactedBy.map((id) => resolveLabel(id));
    return [...labels].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  }
  if (r.count === 1 && r.reactedByMe) {
    return [resolveLabel(currentUserId)];
  }
  if (r.count > 0) {
    return [`${r.count} reaction${r.count === 1 ? "" : "s"}`];
  }
  return [];
}

/* ------------------------------------------------------------------ */
/*  Message permissions                                                */
/* ------------------------------------------------------------------ */

const NON_EDITABLE_BODIES = new Set([
  "[File]",
  "[Video]",
  "[Audio]",
  "[Unsupported message]",
]);

const NON_EDITABLE_BRACKET_PREFIXES = [
  "[Confetti]",
  "[Fireworks]",
  "[Rainfall]",
  "[Snowfall]",
  "[Space invaders]",
  "[Hearts]",
  "[Location]",
  "[Server notice]",
  "[Verification]",
] as const;

export function messageAllowsEdit(msg: Message, userId: string): boolean {
  if (msg.eventId.startsWith("local:")) return false;
  if (msg.sender !== userId) return false;
  if (msg.imageMediaRequest != null) return false;
  if (msg.videoMediaRequest != null) return false;
  if (msg.fileMediaRequest != null) return false;
  const t = msg.body.trim();
  if (NON_EDITABLE_BODIES.has(t)) return false;
  if (
    NON_EDITABLE_BRACKET_PREFIXES.some((p) => t === p || t.startsWith(`${p} `))
  )
    return false;
  return true;
}

export function messageAllowsDelete(
  msg: Message,
  userId: string,
  policy: RoomRedactionPolicy,
): boolean {
  if (msg.sender === userId) return policy.canRedactOwn;
  return policy.canRedactOther;
}
