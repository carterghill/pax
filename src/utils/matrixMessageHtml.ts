import type { Element, ElementContent, Root, Text } from "hast";
import { defaultUrlTransform } from "react-markdown";
import { roomLinkTarget } from "./roomLinks.ts";

/** Matrix user permalinks, including the native matrix: URI form. */
export function matrixUserIdFromHref(href: string): string | null {
  try {
    const url = new URL(href);
    let userId: string;
    if (url.protocol === "matrix:") {
      const match = /^(?:u|user)\/([^/]+)$/.exec(url.pathname);
      if (!match) return null;
      userId = `@${decodeURIComponent(match[1])}`;
    } else {
      if (url.origin !== "https://matrix.to" || url.pathname !== "/") return null;
      const match = /^#\/([^/?]+)(?:\?.*)?$/.exec(url.hash);
      if (!match) return null;
      userId = decodeURIComponent(match[1]);
    }
    return /^@[^:\s]+:[^\s/]+$/.test(userId) ? userId : null;
  } catch {
    return null;
  }
}

export function matrixUserHref(userId: string): string {
  const encoded = encodeURIComponent(userId)
    .replace(/[()]/g, (c) => c === "(" ? "%28" : "%29")
    .replace(/%40/g, "@")
    .replace(/%3A/g, ":");
  return `https://matrix.to/#/${encoded}`;
}

const allowedTags = new Set([
  "a", "b", "blockquote", "br", "caption", "code", "del", "div", "em",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol",
  "p", "pre", "s", "span", "strong", "sub", "sup", "table", "tbody",
  "td", "th", "thead", "tr", "u", "ul",
]);

const omittedTags = new Set(["mx-reply", "script", "style", "template", "iframe"]);

/** Parse in an inert template and copy only message markup and validated attributes. */
export function parseMatrixMessageHtml(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  const fragment = document.createDocumentFragment();

  function appendNode(parent: DocumentFragment | HTMLElement, source: Node) {
    if (source.nodeType === Node.TEXT_NODE) {
      parent.append(source.textContent ?? "");
      return;
    }
    if (!(source instanceof Element) || source.namespaceURI !== "http://www.w3.org/1999/xhtml") return;
    const tag = source.localName;
    if (omittedTags.has(tag)) return;
    if (!allowedTags.has(tag)) {
      for (const child of source.childNodes) appendNode(parent, child);
      return;
    }

    const el = document.createElement(tag);
    if (tag === "a") {
      const href = source.getAttribute("href") ?? "";
      const safeHref = matrixUserIdFromHref(href) || roomLinkTarget(href) ? href : defaultUrlTransform(href);
      if (safeHref) el.setAttribute("href", safeHref);
    } else if (tag === "img") {
      const src = source.getAttribute("src") ?? "";
      if (!/^https?:\/\//i.test(src) || !defaultUrlTransform(src)) {
        parent.append(source.getAttribute("alt") ?? "");
        return;
      }
      el.setAttribute("src", src);
      el.setAttribute("alt", source.getAttribute("alt") ?? "");
    } else if (tag === "code") {
      const language = source.className.match(/(?:^|\s)language-[\w-]+/)?.[0].trim();
      if (language) el.className = language;
    } else if (tag === "ol" && /^-?\d+$/.test(source.getAttribute("start") ?? "")) {
      el.setAttribute("start", source.getAttribute("start")!);
    }
    for (const child of source.childNodes) appendNode(el, child);
    parent.append(el);
  }

  for (const node of template.content.childNodes) appendNode(fragment, node);
  return fragment;
}

export function matrixHtmlToHast(fragment: DocumentFragment): Root["children"] {
  function toHast(node: ChildNode): ElementContent {
    if (!(node instanceof HTMLElement)) return { type: "text", value: node.textContent ?? "" };
    const properties: Record<string, string> = {};
    for (const attr of node.attributes) {
      properties[attr.name === "class" ? "className" : attr.name] = attr.value;
    }
    return {
      type: "element",
      tagName: node.localName,
      properties,
      children: Array.from(node.childNodes, toHast),
    };
  }
  return Array.from(fragment.childNodes, toHast);
}

interface TextRange {
  start: number;
  end: number;
}

function projectMessageText(root: Root, mentionedUsers: ReadonlySet<string>, ignoredText?: string) {
  let plainText = "";
  const textNodes: (TextRange & { node: Text; parent: Root | Element })[] = [];
  const links: (TextRange & { userId: string })[] = [];

  function visit(parent: Root | Element, insideLinkOrCode = false) {
    for (const child of parent.children) {
      const start = plainText.length;
      if (child.type === "text") {
        if (child.value === ignoredText) continue;
        plainText += child.value.replace(/\s/g, "");
        if (!insideLinkOrCode && start < plainText.length) {
          textNodes.push({ node: child, parent, start, end: plainText.length });
        }
      } else if (child.type === "element") {
        const { tagName, properties } = child;
        const isLink = tagName === "a";
        visit(child, insideLinkOrCode || isLink || tagName === "code" || tagName === "pre");
        if (!insideLinkOrCode && isLink && typeof properties.href === "string") {
          const userId = matrixUserIdFromHref(properties.href);
          if (userId && mentionedUsers.has(userId) && start < plainText.length) {
            links.push({ start, end: plainText.length, userId });
          }
        }
      }
    }
  }

  visit(root);
  return { plainText, textNodes, links };
}

/** Keep the Markdown layout and use Matrix HTML to locate the linked mentions. */
export function mergeFormattedMentions(
  markdown: Root,
  formatted: Root,
  mentionedUsers: ReadonlySet<string>,
  editLabel?: string,
): Root["children"] | undefined {
  const source = projectMessageText(formatted, mentionedUsers);
  if (source.links.length === 0) return;

  const target = projectMessageText(markdown, mentionedUsers, editLabel);
  if (source.plainText !== target.plainText) return formatted.children;

  const replacements = new Map<Text, { parent: Root | Element; links: typeof source.links }>();
  for (const link of source.links) {
    if (target.links.some(({ start, end, userId }) =>
      start === link.start && end === link.end && userId === link.userId,
    )) continue;
    const match = target.textNodes.find(({ start, end }) => start <= link.start && end >= link.end);
    if (!match) return formatted.children;
    const range = { ...link, start: link.start - match.start, end: link.end - match.start };
    const existing = replacements.get(match.node);
    if (existing) existing.links.push(range);
    else replacements.set(match.node, { parent: match.parent, links: [range] });
  }

  for (const [node, { parent, links }] of replacements) {
    const characters = [...node.value.matchAll(/\S/g)];
    const parts: ElementContent[] = [];
    let offset = 0;
    for (const link of links) {
      const start = characters[link.start].index;
      const end = characters[link.end - 1].index + 1;
      if (start > offset) parts.push({ type: "text", value: node.value.slice(offset, start) });
      parts.push({
        type: "element",
        tagName: "a",
        properties: { href: matrixUserHref(link.userId) },
        children: [{ type: "text", value: node.value.slice(start, end) }],
      });
      offset = end;
    }
    if (offset < node.value.length) parts.push({ type: "text", value: node.value.slice(offset) });
    parent.children.splice(parent.children.indexOf(node), 1, ...parts);
  }
}
