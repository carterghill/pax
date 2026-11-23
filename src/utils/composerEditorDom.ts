import type { Message } from "../types/matrix";
import { normalizeImageSrcHref } from "./directImageUrl";
import { MATRIX_BODY_MXID_RE_GLOBAL, mentionDisplayName, mentionPillLabel } from "./matrixBodyMxid";
import { formatMatrixMarkdown, isMatrixMediaUri, matrixUserHref, matrixUserIdFromHref, parseMatrixMessageHtml } from "./matrixMessageHtml";

/** Serialized Matrix mention: full MXID (or `@room`) stored on the span; visible label is separate. */
export const PAX_COMPOSER_MENTION_USER_ID_ATTR = "data-pax-mention-user-id";
const PAX_COMPOSER_MENTION_DISPLAY_NAME_ATTR = "data-pax-mention-display-name";

export type ComposerMentionPillStyle = {
  backgroundColor: string;
  color: string;
  fontWeight: number;
};

/** Inline mention chip for the rich-text composer (matches MessageMarkdown pill look). */
export function createComposerMentionSpan(
  userId: string,
  displayName: string,
  style: ComposerMentionPillStyle,
): HTMLSpanElement {
  const span = document.createElement("span");
  span.setAttribute(PAX_COMPOSER_MENTION_USER_ID_ATTR, userId);
  span.setAttribute(PAX_COMPOSER_MENTION_DISPLAY_NAME_ATTR, displayName);
  span.contentEditable = "false";
  span.textContent = mentionPillLabel(userId, displayName);
  Object.assign(span.style, {
    display: "inline",
    padding: "1px 6px",
    borderRadius: "4px",
    backgroundColor: style.backgroundColor,
    color: style.color,
    fontWeight: String(style.fontWeight),
    userSelect: "text",
    transition: "background-color 120ms ease",
    cursor: "default",
    verticalAlign: "baseline",
  } satisfies Partial<CSSStyleDeclaration>);
  return span;
}

export function refreshComposerMentionLabels(
  root: HTMLElement,
  resolveMemberLabel: (userId: string) => string,
): boolean {
  let changed = false;
  for (const pill of root.querySelectorAll(`span[${PAX_COMPOSER_MENTION_USER_ID_ATTR}]`)) {
    const userId = pill.getAttribute(PAX_COMPOSER_MENTION_USER_ID_ATTR)!;
    const storedName = pill.getAttribute(PAX_COMPOSER_MENTION_DISPLAY_NAME_ATTR);
    const displayName = mentionDisplayName(userId, resolveMemberLabel(userId), storedName);
    const label = mentionPillLabel(userId, displayName);
    if (displayName !== storedName) {
      pill.setAttribute(PAX_COMPOSER_MENTION_DISPLAY_NAME_ATTR, displayName);
    }
    if (label !== pill.textContent) {
      pill.textContent = label;
      changed = true;
    }
  }
  return changed;
}

function composerTextNodeIsMxidExempt(textNode: Text): boolean {
  let p: Node | null = textNode.parentElement;
  while (p) {
    if (!(p instanceof HTMLElement)) break;
    const tag = p.tagName;
    if (tag === "A" || tag === "CODE" || tag === "PRE") return true;
    if (p.hasAttribute(PAX_COMPOSER_MENTION_USER_ID_ATTR)) return true;
    p = p.parentElement;
  }
  return false;
}

/** Plain-text offset of a collapsed caret within the composer (for restoring selection after DOM edits). */
export function getCaretPlainTextOffset(root: HTMLElement, sel: Selection): number | null {
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().replace(/\u200b/g, "").length;
}

export function setCaretPlainTextOffset(root: HTMLElement, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  let charCount = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const tn = walker.currentNode as Text;
    const len = (tn.textContent ?? "").replace(/\u200b/g, "").length;
    if (charCount + len >= offset) {
      const cleanTarget = offset - charCount;
      const r = document.createRange();
      const pill = tn.parentElement?.closest(`[${PAX_COMPOSER_MENTION_USER_ID_ATTR}]`);
      if (pill) {
        if (cleanTarget === 0) r.setStartBefore(pill);
        else r.setStartAfter(pill);
      } else {
        let rawOffset = 0;
        let cleanSeen = 0;
        const raw = tn.textContent ?? "";
        while (cleanSeen < cleanTarget && rawOffset < raw.length) {
          if (raw[rawOffset] !== "\u200b") cleanSeen++;
          rawOffset++;
        }
        r.setStart(tn, rawOffset);
      }
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    charCount += len;
  }
  const r = document.createRange();
  r.selectNodeContents(root);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

/**
 * Wrap bare MXID / `@room` tokens in text nodes with mention spans. Preserves caret when possible.
 * Skips `code` / `pre` and text inside existing mention spans.
 */
export function replaceBareMxidsWithPillsInComposer(
  root: HTMLElement,
  getDisplayName: (mxid: string) => string,
  makeSpan: (mxid: string, displayName: string) => HTMLSpanElement,
  isMention: (mxid: string) => boolean = () => true,
): boolean {
  const sel = window.getSelection();
  let caretBefore: number | null = null;
  if (sel && sel.rangeCount > 0 && sel.isCollapsed && sel.anchorNode && root.contains(sel.anchorNode)) {
    caretBefore = getCaretPlainTextOffset(root, sel);
  }

  let changed = false;
  // Typing a longer word after an automatic @room pill turns it back into text.
  for (const pill of root.querySelectorAll(`[${PAX_COMPOSER_MENTION_USER_ID_ATTR}="@room"]`)) {
    const next = pill.nextSibling;
    if (next?.nodeType !== Node.TEXT_NODE) continue;
    const text = `@room${(next.textContent ?? "").replace(/\u200b/g, "")}`;
    if (text.match(MATRIX_BODY_MXID_RE_GLOBAL)?.[0] === "@room") continue;
    (next as Text).insertData(0, "@room");
    pill.remove();
    changed = true;
  }

  const textNodes: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) {
    const tn = w.currentNode as Text;
    if (composerTextNodeIsMxidExempt(tn)) continue;
    textNodes.push(tn);
  }

  for (const tn of textNodes) {
    if (!tn.isConnected || !tn.parentNode) continue;
    const text = tn.textContent ?? "";
    const matches = [...text.matchAll(MATRIX_BODY_MXID_RE_GLOBAL)]
      .filter((match) => isMention(match[0]));
    if (matches.length === 0) continue;

    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of matches) {
      const idx = m.index!;
      const mxid = m[0];
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
      frag.appendChild(makeSpan(mxid, getDisplayName(mxid)));
      last = idx + mxid.length;
      changed = true;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    tn.parentNode.replaceChild(frag, tn);
  }

  if (changed && caretBefore != null) {
    const afterLen = getEditorPlainText(root).length;
    setCaretPlainTextOffset(root, Math.min(caretBefore, afterLen));
  }

  return changed;
}

type FillComposerMentionPills = {
  getDisplayName: (mxid: string, linkedName?: string | null) => string;
  makeSpan: (mxid: string, displayName: string) => HTMLSpanElement;
};

// ─── Serialize (rich DOM → markdown) ────────────────────────────────────────

export interface ComposerMessageContent {
  body: string;
  formattedBody?: string;
  mentions: { userIds: string[]; room: boolean };
}

/** Serialize text and explicitly marked mentions from the editable DOM. */
export function serializeComposerEditor(
  root: HTMLElement,
  resolveMemberLabel: (userId: string) => string,
): ComposerMessageContent {
  const userIds = new Set<string>();
  let room = false;

  function visit(node: Node, formatted: boolean, allowMentions: boolean): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    const tag = el.tagName;

    if (tag === "IMG") {
      const url = el.getAttribute("data-url") ?? "";
      const alt = el.getAttribute("alt") ?? "";
      return isMatrixMediaUri(url) ? `![${alt.replace(/[\\\[\]]/g, "\\$&")}](${url})` : url;
    }
    if (tag === "BR") return "\n";
    if (tag === "SPAN" && el.hasAttribute(PAX_COMPOSER_MENTION_USER_ID_ATTR)) {
      const userId = el.getAttribute(PAX_COMPOSER_MENTION_USER_ID_ATTR)!;
      if (!allowMentions) return userId;
      if (userId === "@room") {
        room = true;
        return userId;
      }
      userIds.add(userId);
      const label = mentionDisplayName(
        userId, resolveMemberLabel(userId), el.getAttribute(PAX_COMPOSER_MENTION_DISPLAY_NAME_ATTR),
      ).replace(/\s*\n\s*/g, " ").trim();
      if (!formatted) return label;
      const escapedLabel = label.replace(/[!-\/:-@[-`{-~]/g, "\\$&");
      return `[${escapedLabel}](${matrixUserHref(userId)})`;
    }

    let inner = "";
    const mentionsInChildren = allowMentions && tag !== "A" && tag !== "CODE" && tag !== "PRE";
    for (const c of el.childNodes) inner += visit(c, formatted, mentionsInChildren);

    if (tag === "B" || tag === "STRONG") return inner ? `**${inner}**` : "";
    if (tag === "I" || tag === "EM") return inner ? `_${inner}_` : "";
    if (tag === "S" || tag === "DEL" || tag === "STRIKE") return inner ? `~~${inner}~~` : "";
    if (tag === "CODE") {
      if (el.parentElement?.tagName === "PRE") return inner;
      return inner ? `\`${inner}\`` : "";
    }
    if (tag === "PRE") return `\`\`\`\n${inner}\n\`\`\``;
    if (tag === "A") {
      const href = el.getAttribute("href") ?? "";
      return `[${inner}](${href})`;
    }
    if (tag === "HR") return "\n---\n";
    if (tag === "H1") return `# ${inner}`;
    if (tag === "H2") return `## ${inner}`;
    if (tag === "LI") {
      const parent = el.parentElement;
      if (parent?.tagName === "OL") {
        const idx = Array.from(parent.children).indexOf(el) + (parent as HTMLOListElement).start;
        return `${idx}. ${inner}\n`;
      }
      return `- ${inner}\n`;
    }
    if (tag === "UL" || tag === "OL") return inner;
    if (tag === "BLOCKQUOTE") {
      return (
        inner
          .trimEnd()
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n") + "\n"
      );
    }
    if ((tag === "DIV" || tag === "P") && el.parentNode === root) return inner + "\n";

    return inner;
  }

  const markdown = (formatted: boolean) =>
    Array.from(root.childNodes, (node) => visit(node, formatted, true))
      .join("").replace(/\u200b/g, "").trim();

  const body = markdown(false);
  const formattedBody = formatMatrixMarkdown(body, userIds.size > 0 ? markdown(true) : body);
  return { body, formattedBody, mentions: { userIds: [...userIds], room } };
}

// ─── Fill (markdown → rich DOM, for loading edits) ──────────────────────────

/** Parse a markdown string into rich HTML and set it on the editor root. */
function fillComposerEditorFromMarkdown(
  root: HTMLElement,
  markdown: string,
  imgStyle: { borderRadius: number; maxWidth: string },
): void {
  let html = markdown;

  // Escape HTML entities
  html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Code blocks (before inline processing to protect their contents)
  html = html.replace(/```\n?([\s\S]*?)```/g, "<pre><code>$1</code></pre>");

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // Bold **…**
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic _…_ (word-boundary aware to avoid matching snake_case)
  html = html.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<em>$1</em>");

  // Strikethrough ~~…~~
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Headings (## before # so ## doesn't match as #)
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Horizontal rules
  html = html.replace(/^---$/gm, "<hr>");

  // Blockquotes (escaped > from entity step)
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

  // Bare image URLs → <img> (only URLs not already inside an HTML tag)
  html = html.replace(
    /(?<![">])(https?:\/\/[^\s<>"]+\.(?:gif|jpe?g|png|webp|avif|bmp|svg)(?:[?#][^\s<>"]*)?)/gi,
    (match) => {
      const src = normalizeImageSrcHref(match);
      if (!src) return match;
      return `<img data-url="${match}" src="${src}" alt="" contenteditable="false" style="max-width:${imgStyle.maxWidth};height:auto;border-radius:${imgStyle.borderRadius}px;vertical-align:middle;display:inline-block">`;
    },
  );

  // Newlines → <br>
  html = html.replace(/\n/g, "<br>");

  root.innerHTML = html || "\u200b";
}

export function fillComposerEditorForEdit(
  root: HTMLElement,
  message: Pick<Message, "body" | "formattedBody" | "mentionedUserIds" | "mentionsRoom">,
  imgStyle: { borderRadius: number; maxWidth: string },
  mentionPills: FillComposerMentionPills,
): void {
  const userIds = new Set(message.mentionedUserIds);
  const fragment = message.formattedBody && userIds.size > 0
    ? parseMatrixMessageHtml(message.formattedBody)
    : null;
  let hasMentionLinks = false;
  if (fragment) {
    for (const anchor of fragment.querySelectorAll("a[href]")) {
      const userId = matrixUserIdFromHref(anchor.getAttribute("href")!);
      if (userId && userIds.has(userId) && !anchor.closest("code, pre")) {
        const displayName = mentionPills.getDisplayName(userId, anchor.textContent);
        anchor.replaceWith(mentionPills.makeSpan(userId, displayName));
        hasMentionLinks = true;
      }
    }
  }
  if (fragment && hasMentionLinks) {
    for (const image of fragment.querySelectorAll("img")) {
      image.setAttribute("data-url", image.getAttribute("src")!);
      image.removeAttribute("src");
      image.contentEditable = "false";
      image.style.maxWidth = imgStyle.maxWidth;
      image.style.borderRadius = `${imgStyle.borderRadius}px`;
    }
    root.replaceChildren(fragment);
  } else {
    fillComposerEditorFromMarkdown(root, message.body, imgStyle);
  }
  replaceBareMxidsWithPillsInComposer(root, mentionPills.getDisplayName, mentionPills.makeSpan,
    (userId) => userId === "@room" ? Boolean(message.mentionsRoom) : userIds.has(userId),
  );
}

// ─── Plain text ─────────────────────────────────────────────────────────────

/** Lightweight plain-text read for canSend / typing indicator checks. */
export function getEditorPlainText(root: HTMLElement): string {
  return (root.textContent ?? "").replace(/\u200b/g, "");
}

// ─── Insertion helpers ──────────────────────────────────────────────────────

/** Insert plain text at the current selection, preserving undo history. */
export function insertPlainTextAtSelection(_root: HTMLElement, text: string): void {
  document.execCommand("insertText", false, text);
}

/**
 * Re-run `sync` on the next frame and when the image gets real dimensions (after load).
 * Without this, contenteditable `scrollHeight` stays one line until something else reflows.
 */
function whenComposerImageAffectsLayout(img: HTMLImageElement, sync: () => void): void {
  const run = () => requestAnimationFrame(() => sync());
  if (img.complete) {
    run();
    return;
  }
  run();
  img.addEventListener("load", run, { once: true });
  img.addEventListener("error", run, { once: true });
}

/** Attach layout sync for every `<img>` under `root` (e.g. after loading markdown into the editor). */
export function syncComposerHeightAfterImages(root: HTMLElement, sync: () => void): void {
  root.querySelectorAll("img").forEach((node) => {
    if (node instanceof HTMLImageElement) whenComposerImageAffectsLayout(node, sync);
  });
}

/** Insert an <img> element at the current selection. */
export function insertImageAtSelection(
  root: HTMLElement,
  href: string,
  imgStyle: { borderRadius: number; maxWidth: string },
  onImageLayout?: () => void,
): void {
  const src = normalizeImageSrcHref(href);
  if (!src) return;
  const img = document.createElement("img");
  img.setAttribute("data-url", href);
  img.src = src;
  img.alt = "";
  img.contentEditable = "false";
  img.draggable = false;
  img.style.maxWidth = imgStyle.maxWidth;
  img.style.height = "auto";
  img.style.borderRadius = `${imgStyle.borderRadius}px`;
  img.style.verticalAlign = "middle";
  img.style.display = "inline-block";

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    root.appendChild(img);
  } else {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(img);
    range.collapse(false);
  }

  if (onImageLayout) whenComposerImageAffectsLayout(img, onImageLayout);

  root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
}

// ─── Format state ───────────────────────────────────────────────────────────

/** Query which formatting is active at the current caret / selection. */
export function getActiveFormats(root: HTMLElement): Set<string> {
  const f = new Set<string>();
  try {
    if (document.queryCommandState("bold")) f.add("bold");
    if (document.queryCommandState("italic")) f.add("italic");
    if (document.queryCommandState("strikeThrough")) f.add("strikethrough");
    if (document.queryCommandState("insertUnorderedList")) f.add("ul");
    if (document.queryCommandState("insertOrderedList")) f.add("ol");
  } catch {
    /* queryCommandState can throw in edge cases */
  }

  const sel = window.getSelection();
  if (sel?.anchorNode) {
    let node: Node | null = sel.anchorNode;
    while (node && node !== root) {
      if (node instanceof HTMLElement) {
        const tag = node.tagName;
        if (tag === "CODE" && node.parentElement?.tagName !== "PRE") f.add("code");
        if (tag === "PRE") f.add("codeblock");
        if (tag === "BLOCKQUOTE") f.add("quote");
        if (tag === "H1") f.add("h1");
        if (tag === "H2") f.add("h2");
        if (tag === "A") f.add("link");
      }
      node = node.parentNode;
    }
  }

  return f;
}

// ─── Format toggles ────────────────────────────────────────────────────────

/** Toggle inline <code> around the current selection (no execCommand equivalent). */
export function toggleInlineCode(root: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  let codeEl: HTMLElement | null = null;
  let node: Node | null = sel.anchorNode;
  while (node && node !== root) {
    if (node instanceof HTMLElement && node.tagName === "CODE" && node.parentElement?.tagName !== "PRE") {
      codeEl = node;
      break;
    }
    node = node.parentNode;
  }

  if (codeEl) {
    const parent = codeEl.parentNode!;
    while (codeEl.firstChild) parent.insertBefore(codeEl.firstChild, codeEl);
    parent.removeChild(codeEl);
  } else {
    const range = sel.getRangeAt(0);
    const code = document.createElement("code");
    if (range.collapsed) {
      code.appendChild(document.createTextNode("\u200b"));
      range.insertNode(code);
      const t = code.firstChild!;
      range.setStart(t, 1);
      range.setEnd(t, 1);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      try {
        range.surroundContents(code);
      } catch {
        const frag = range.extractContents();
        code.appendChild(frag);
        range.insertNode(code);
      }
      sel.removeAllRanges();
      const r2 = document.createRange();
      r2.selectNodeContents(code);
      sel.addRange(r2);
    }
  }

  root.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

/** Toggle <pre><code> block around the current selection. */
export function toggleCodeBlock(root: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  let preEl: HTMLElement | null = null;
  let node: Node | null = sel.anchorNode;
  while (node && node !== root) {
    if (node instanceof HTMLElement && node.tagName === "PRE") {
      preEl = node;
      break;
    }
    node = node.parentNode;
  }

  if (preEl) {
    const text = preEl.textContent || "";
    const div = document.createElement("div");
    div.textContent = text;
    preEl.parentNode!.replaceChild(div, preEl);
    const r = document.createRange();
    r.selectNodeContents(div);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  } else {
    const range = sel.getRangeAt(0);
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    pre.appendChild(code);
    if (range.collapsed) {
      code.appendChild(document.createTextNode("\u200b"));
    } else {
      code.appendChild(range.extractContents());
    }
    range.insertNode(pre);
    const r = document.createRange();
    r.selectNodeContents(code);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  root.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

/** Toggle a link on the current selection. Prompts for URL if creating. */
export function toggleLink(root: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  let linkEl: HTMLAnchorElement | null = null;
  let node: Node | null = sel.anchorNode;
  while (node && node !== root) {
    if (node instanceof HTMLElement && node.tagName === "A") {
      linkEl = node as HTMLAnchorElement;
      break;
    }
    node = node.parentNode;
  }

  if (linkEl) {
    document.execCommand("unlink");
  } else {
    const range = sel.getRangeAt(0);
    if (range.collapsed) {
      document.execCommand("insertText", false, "link");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sel as any).modify?.("extend", "backward", "word");
    }
    const url = prompt("URL:", "https://");
    if (url) document.execCommand("createLink", false, url);
  }

  root.focus();
}
