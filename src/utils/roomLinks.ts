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

export function roomLinkPresentation(membership: string | null | undefined, joinRule: string | null | undefined, {
  label, requested, loading, allowUnknownJoin,
}: {
  label: "room" | "space";
  requested: boolean;
  loading: boolean;
  allowUnknownJoin: boolean;
}): { action: RoomLinkAction | null; status: string } {
  if (membership === "joined") return { action: "open", status: `You’re in this ${label}` };
  if (membership === "invited") return { action: "accept", status: "You’ve been invited" };
  if (membership === "banned") return { action: null, status: "Room unavailable" };
  if (membership === "knocked" || requested) return { action: null, status: "Join request sent" };
  switch (joinRule) {
    case "knock":
    case "knock_restricted":
      return { action: "knock", status: "Approval required" };
    case "public":
      return { action: "join", status: `Public ${label}` };
    case "restricted":
      return { action: "join", status: `Restricted ${label}` };
    case "invite":
    case "private":
      return { action: null, status: "Invite required" };
    default:
      return {
        action: allowUnknownJoin && !loading ? "join" : null,
        status: loading ? "Loading room preview…" : "Room preview unavailable",
      };
  }
}
