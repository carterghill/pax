import type { Element, ElementContent, Root } from "hast";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { roomLinkTarget } from "./roomLinks.ts";
import { hrefLooksLikeDirectImageUrl, imageDimensions, type ImageDimensions } from "./directImageUrl.ts";

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
  "a", "b", "blockquote", "br", "caption", "code", "del", "details", "div", "em",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol",
  "p", "pre", "s", "span", "strong", "sub", "summary", "sup", "table", "tbody",
  "td", "th", "thead", "tr", "u", "ul",
]);

const omittedTags = new Set(["mx-reply", "script", "style", "template", "iframe"]);
const inlineTags = new Set(["a", "b", "br", "code", "del", "em", "i", "img", "s", "span", "strong", "sub", "sup", "u"]);
const maxTagDepth = 100;

export function isMatrixMediaUri(uri: string): boolean {
  const match = /^mxc:\/\/((?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]+)?)\/[A-Za-z0-9_-]+$/.exec(uri);
  // The SDK stores the slash offset, including the six-byte scheme, in one byte.
  if (!match || match[0] !== uri || match[1].length > 249) return false;
  try {
    return Boolean(new URL(`https://${match[1]}`).hostname);
  } catch {
    return false;
  }
}

function imageDimension(value: string | null): number | undefined {
  if (value == null || !/^\d+$/.test(value.trim())) return;
  const dimension = Number(value);
  if (Number.isSafeInteger(dimension) && dimension > 0) return dimension;
}

export function isMatrixMessageLink(href: string): boolean {
  if (/[\x00-\x1f\x7f]/.test(href)) return false;
  if (matrixUserIdFromHref(href) || roomLinkTarget(href)) return true;
  if (!/^(?:(?:https?|ftp):\/\/|mailto:|magnet:)/i.test(href)) return false;
  try {
    return Boolean(new URL(href));
  } catch {
    return false;
  }
}

/** Parse in an inert template and copy only message markup and validated attributes. */
export function parseMatrixMessageHtml(html: string, { forSending = false } = {}): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  const inertDocument = template.content.ownerDocument;
  const fragment = inertDocument.createDocumentFragment();

  function appendNode(parent: DocumentFragment | HTMLElement, source: Node, depth: number) {
    if (source.nodeType === Node.TEXT_NODE) {
      parent.append(source.textContent ?? "");
      return;
    }
    if (depth > maxTagDepth || !(source instanceof Element) || source.namespaceURI !== "http://www.w3.org/1999/xhtml") return;
    const tag = source.localName;
    if (omittedTags.has(tag)) return;
    if (tag === "input" && source.getAttribute("type") === "checkbox" && source.hasAttribute("disabled")) {
      parent.append(source.hasAttribute("checked") ? "☑" : "☐");
      return;
    }
    if (!allowedTags.has(tag)) {
      for (const child of source.childNodes) appendNode(parent, child, depth + 1);
      return;
    }

    const el = inertDocument.createElement(tag);
    if (tag === "a") {
      const href = source.getAttribute("href")?.trim() ?? "";
      if (isMatrixMessageLink(href)) el.setAttribute("href", href);
      const size = imageDimensions(source.getAttribute("data-pax-width"), source.getAttribute("data-pax-height"));
      if (size && hrefLooksLikeDirectImageUrl(href)) {
        el.dataset.paxWidth = String(size.width);
        el.dataset.paxHeight = String(size.height);
      }
    } else if (tag === "img") {
      const src = source.getAttribute("src")?.trim() ?? "";
      const alt = source.getAttribute("alt") ?? "";
      if (!isMatrixMediaUri(src)) {
        if (forSending && /^https?:\/\//i.test(src) && isMatrixMessageLink(src)) {
          const link = inertDocument.createElement("a");
          link.setAttribute("href", src);
          link.textContent = alt || src;
          parent.append(link);
        } else {
          parent.append(alt);
        }
        return;
      }
      el.setAttribute("src", src);
      el.setAttribute("alt", alt);
      const title = source.getAttribute("title");
      if (title != null) el.setAttribute("title", title);
      for (const name of ["width", "height"]) {
        const dimension = imageDimension(source.getAttribute(name));
        if (dimension != null) el.setAttribute(name, String(dimension));
      }
    } else if (tag === "code") {
      const language = source.className.match(/(?:^|\s)language-[\w-]+/)?.[0].trim();
      if (language) el.className = language;
    } else if (tag === "ol") {
      const start = source.getAttribute("start")?.trim();
      if (start && /^[+-]?\d+$/.test(start) && Number.isSafeInteger(Number(start))) {
        el.setAttribute("start", String(Number(start)));
      }
    } else if (tag === "span") {
      for (const name of ["data-mx-color", "data-mx-bg-color"]) {
        const color = source.getAttribute(name);
        if (color && /^#[0-9a-f]{6}$/i.test(color)) el.setAttribute(name, color);
      }
      const spoiler = source.getAttribute("data-mx-spoiler");
      if (spoiler != null) el.setAttribute("data-mx-spoiler", spoiler);
    }
    for (const child of source.childNodes) appendNode(el, child, depth + 1);
    parent.append(el);
  }

  for (const node of template.content.childNodes) appendNode(fragment, node, 1);
  return fragment;
}

export function formatMatrixMarkdown(body: string, markdown = body, imageSizes?: ReadonlyMap<string, ImageDimensions>): string | undefined {
  const html = micromark(markdown, {
    // The Matrix allowlist below also recognizes native Matrix links and mxc images.
    allowDangerousProtocol: true,
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });
  const fragment = parseMatrixMessageHtml(html, { forSending: true });
  if (imageSizes?.size) {
    for (const link of fragment.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const size = imageSizes.get(link.getAttribute("href")!);
      if (size) {
        link.dataset.paxWidth = String(size.width);
        link.dataset.paxHeight = String(size.height);
      }
    }
  }
  const nodes = Array.from(fragment.childNodes).filter((node) => node.nodeType !== Node.TEXT_NODE || node.textContent?.trim());
  const paragraph = nodes.length === 1 && nodes[0] instanceof HTMLElement && nodes[0].localName === "p" ? nodes[0] : null;
  if (paragraph) {
    if (!paragraph.firstElementChild && paragraph.textContent === body) return;
    if (!paragraph.textContent?.includes("\n")) paragraph.replaceWith(...paragraph.childNodes);
  }
  const template = document.createElement("template");
  template.content.append(fragment);
  return template.innerHTML.trim() || undefined;
}

/** Keep adjacent inline nodes together inside the timeline's column layout. */
export function wrapMatrixHtmlInlineRuns(nodes: ElementContent[]): ElementContent[] {
  const children: ElementContent[] = [];
  let run: Element | undefined;
  for (const node of nodes) {
    if (node.type === "element" && !inlineTags.has(node.tagName)) {
      children.push(node);
      run = undefined;
    } else {
      if (!run) {
        if (node.type === "text" && !node.value.trim()) continue;
        run = { type: "element", tagName: "div", properties: {}, children: [] };
        children.push(run);
      }
      run.children.push(node);
    }
  }
  return children;
}

export function matrixHtmlToHast(fragment: DocumentFragment): Root["children"] {
  function toHast(node: ChildNode): ElementContent {
    if (!(node instanceof HTMLElement)) return { type: "text", value: node.textContent ?? "" };
    const properties: Element["properties"] = {};
    for (const { name, value } of node.attributes) {
      if (name === "start" || name === "width" || name === "height") properties[name] = Number(value);
      else if (name === "class") properties.className = Array.from(node.classList);
      else properties[name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
    }
    return {
      type: "element",
      tagName: node.localName,
      properties,
      children: Array.from(node.childNodes, toHast),
    };
  }
  return wrapMatrixHtmlInlineRuns(Array.from(fragment.childNodes, toHast));
}
