import type { Element, ElementContent, Root } from "hast";

/** Recognizes room and space links. Native Matrix parsing validates IDs and routing hints. */
export function roomLinkTarget(href: string): string | null {
  if (href.length > 4096) return null;
  try {
    const url = new URL(href);
    let target: string | null = null;
    if (url.protocol === "pax:" && url.host === "room" && (!url.pathname || url.pathname === "/")) {
      target = url.searchParams.get("id");
    } else if (url.origin === "https://matrix.to" && url.pathname === "/" && url.hash.startsWith("#/")) {
      const encoded = url.hash.slice(2).split("?")[0];
      if (encoded.includes("/")) return null;
      target = decodeURIComponent(encoded);
    } else if (url.protocol === "matrix:") {
      const match = /^(r|room|roomid)\/([^/]+)$/.exec(url.pathname);
      if (!match || (url.searchParams.has("action") && url.searchParams.get("action") !== "join")) return null;
      target = (match[1] === "roomid" ? "!" : "#") + decodeURIComponent(match[2]);
    }
    return target && /^[!#][^\s]+$/.test(target) ? target : null;
  } catch {
    return null;
  }
}

/** Keeps the recipient on the chat timeline and renders each distinct room link once per message. */
export function appendRoomLinkPreviews(tree: Root): void {
  const links = new Map<string, string>();
  const addLink = (href: string) => {
    const target = roomLinkTarget(href);
    if (target && links.size < 3 && !links.has(target)) links.set(target, href);
  };

  function linkifyRoomUris(value: string): ElementContent[] | null {
    const parts: ElementContent[] = [];
    let offset = 0;
    // Remark recognizes ordinary https links, but leaves bare app and Matrix URIs as text.
    for (const match of value.matchAll(/\b(?:pax:\/\/room\?|matrix:(?:r|room|roomid)\/)[^\s<>"'\])}]+/g)) {
      const href = match[0].replace(/[.,;]+$/, "");
      if (!roomLinkTarget(href)) continue;
      const index = match.index ?? 0;
      if (index > offset) parts.push({ type: "text", value: value.slice(offset, index) });
      parts.push({
        type: "element", tagName: "a", properties: { href }, children: [{ type: "text", value: href }],
      });
      offset = index + href.length;
      addLink(href);
    }
    if (!parts.length) return null;
    if (offset < value.length) parts.push({ type: "text", value: value.slice(offset) });
    return parts;
  }

  function visit(parent: Root | Element): void {
    for (let index = 0; index < parent.children.length; index++) {
      const child = parent.children[index];
      if (child.type === "text") {
        const parts = linkifyRoomUris(child.value);
        if (parts) {
          parent.children.splice(index, 1, ...parts);
          index += parts.length - 1;
        }
      }
      if (child.type === "element") {
        if (child.tagName === "a") {
          const href = child.properties.href;
          if (typeof href === "string") addLink(href);
        } else if (!["code", "pre", "blockquote", "details"].includes(child.tagName)
          && typeof child.properties.dataMxSpoiler !== "string") {
          visit(child);
        }
      }
    }
  }

  visit(tree);
  for (const href of links.values()) {
    tree.children.push({
      type: "element", tagName: "div", properties: { dataRoomLinkPreview: href }, children: [],
    });
  }
}

export type RoomLinkAction = "open" | "accept" | "join" | "knock";
export type RoomPreviewFailure = "invalidLink" | "roomNotFound";
type RoomLabel = "room" | "space";

type UnavailableReason = RoomPreviewFailure | "inviteRequired" | "restricted" | "expired" | "usedUp" | "denied";

function unavailable(reason: UnavailableReason, label: RoomLabel) {
  const copy = {
    invalidLink: ["Invalid link", "Ask the sender for a new link."],
    roomNotFound: [label === "space" ? "Space unavailable" : "Room unavailable", `Your homeserver couldn’t find this ${label}.`],
    inviteRequired: ["Invite required", `Ask a member to invite you to this ${label}.`],
    restricted: ["Invite required", "Join a required room or space first, or ask a member for an invite."],
    expired: ["Invite expired", "Ask the sender for a new invite."],
    usedUp: ["Invite used up", "Ask the sender for a new invite."],
    denied: ["Access denied", `Your homeserver denied access to this ${label}.`],
  }[reason];
  return { action: null, buttonLabel: copy[0], status: copy[1] };
}

export function roomLinkPresentation(membership: string | null | undefined, joinRule: string | null | undefined, {
  label, requested, loading, allowUnknownJoin, meetsRestriction, previewFailure,
}: {
  label: RoomLabel;
  requested: boolean;
  loading: boolean;
  allowUnknownJoin: boolean;
  meetsRestriction?: boolean;
  previewFailure?: RoomPreviewFailure;
}): { action: RoomLinkAction | null; buttonLabel: string; status: string } {
  if (previewFailure === "invalidLink") return unavailable(previewFailure, label);
  if (membership === "joined") return { action: "open", buttonLabel: `Go to ${label}`, status: `You’re in this ${label}` };
  if (membership === "invited") return { action: "accept", buttonLabel: "Accept invite", status: "You’ve been invited" };
  if (membership === "banned") return { action: null, buttonLabel: "Access denied", status: `You’re banned from this ${label}.` };
  if (membership === "knocked" || requested) return { action: null, buttonLabel: "Request sent", status: "Waiting for approval." };
  if (previewFailure) return unavailable(previewFailure, label);
  switch (joinRule) {
    case "knock":
    case "knock_restricted":
      if (joinRule === "knock_restricted" && meetsRestriction) {
        return { action: "join", buttonLabel: "Join", status: `Restricted ${label}` };
      }
      return { action: "knock", buttonLabel: "Request to join", status: "Approval required" };
    case "public":
      return { action: "join", buttonLabel: "Join", status: `Public ${label}` };
    case "restricted":
      if (meetsRestriction === false) return unavailable("restricted", label);
      return { action: "join", buttonLabel: "Join", status: `Restricted ${label}` };
    case "invite":
    case "private":
      return unavailable("inviteRequired", label);
    default:
      return {
        action: allowUnknownJoin && !loading ? "join" : null,
        buttonLabel: loading ? "Checking access…" : allowUnknownJoin ? "Join" : "Preview unavailable",
        status: loading ? `Loading ${label} preview…` : "Your homeserver couldn’t confirm access.",
      };
  }
}

export function roomLinkActionFailure(reason: unknown, action: RoomLinkAction, label: RoomLabel): {
  status: string;
  buttonLabel?: string;
  offerKnock?: boolean;
} {
  // join_room returns an SDK error chain; knock_room includes the Matrix JSON response.
  const detail = String(reason);
  if (/\bM_LIMIT_EXCEEDED\b/.test(detail)) {
    return { status: "Too many requests. Wait a moment and try again." };
  }
  if (/\binvit(?:e|ation)(?: link)? (?:has |is )?expired\b/i.test(detail)) {
    return unavailable("expired", label);
  }
  if (/\binvit(?:e|ation)(?: link)? (?:has no (?:remaining )?uses|is out of uses|has already been used)\b/i.test(detail)) {
    return unavailable("usedUp", label);
  }
  if (/\binvalid invit(?:e|ation)(?: link)?\b|\binvit(?:e|ation) (?:link )?is invalid\b/i.test(detail)) {
    return unavailable("invalidLink", label);
  }
  if (/\bM_NOT_FOUND\b/.test(detail)) {
    return unavailable("roomNotFound", label);
  }
  if (/\bM_FORBIDDEN\b/.test(detail)) {
    if (/do not belong to any of the required rooms\/spaces/i.test(detail)) {
      return unavailable("restricted", label);
    }
    if (/\bnot invited\b|\binvite[- ]only\b|\binvit(?:e|ation) (?:is )?required\b/i.test(detail)) {
      return { ...unavailable("inviteRequired", label), offerKnock: action === "join" };
    }
    return { ...unavailable("denied", label), offerKnock: action === "join" };
  }
  return { status: action === "knock" ? "Couldn’t send your request. Try again." : `Couldn’t join this ${label}. Try again.` };
}
