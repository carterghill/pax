import { normalizeImageSrcHref } from "./directImageUrl";

// ─── Serialize (rich DOM → markdown) ────────────────────────────────────────

/** Walk the rich contenteditable DOM and produce a markdown string for sending. */
export function serializeComposerEditor(root: HTMLElement): string {
  function visit(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    const tag = el.tagName;

    if (tag === "IMG") return el.getAttribute("data-url") ?? "";
    if (tag === "BR") return "\n";

    let inner = "";
    for (const c of el.childNodes) inner += visit(c);

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
        const idx = Array.from(parent.children).indexOf(el) + 1;
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

  let result = "";
  for (const c of root.childNodes) result += visit(c);
  return result.replace(/\u200b/g, "").replace(/\n+$/, "");
}

// ─── Fill (markdown → rich DOM, for loading edits) ──────────────────────────

/** Parse a markdown string into rich HTML and set it on the editor root. */
export function fillComposerEditorFromMarkdown(
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

/** Insert an <img> element at the current selection. */
export function insertImageAtSelection(
  root: HTMLElement,
  href: string,
  imgStyle: { borderRadius: number; maxWidth: string },
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