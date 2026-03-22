import { normalizeImageSrcHref, splitTextWithDirectImageEmbeds } from "./directImageUrl";

/** Serialize contenteditable body to the plain markdown string (images → stored `data-url`). */
export function serializeComposerEditor(root: HTMLElement): string {
  const parts: string[] = [];

  function visit(n: Node): void {
    if (n.nodeType === Node.TEXT_NODE) {
      parts.push(n.textContent ?? "");
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    if (el.tagName === "IMG") {
      parts.push(el.getAttribute("data-url") ?? "");
      return;
    }
    if (el.tagName === "BR") {
      parts.push("\n");
      return;
    }
    for (const c of el.childNodes) visit(c);
    if ((el.tagName === "DIV" || el.tagName === "P") && el.parentNode === root) {
      parts.push("\n");
    }
  }

  for (const c of root.childNodes) visit(c);
  return parts.join("").replace(/\u200b/g, "");
}

export function fillComposerEditor(
  root: HTMLElement,
  raw: string,
  imgStyle: { borderRadius: number; maxWidth: string },
): void {
  root.replaceChildren();
  const segments = splitTextWithDirectImageEmbeds(raw);
  for (const seg of segments) {
    if (seg.type === "text") {
      if (seg.text) root.appendChild(document.createTextNode(seg.text));
    } else {
      const src = normalizeImageSrcHref(seg.href);
      if (!src) {
        root.appendChild(document.createTextNode(seg.href));
        continue;
      }
      const img = document.createElement("img");
      img.setAttribute("data-url", seg.href);
      img.src = src;
      img.alt = "";
      img.contentEditable = "false";
      img.draggable = false;
      img.style.maxWidth = imgStyle.maxWidth;
      img.style.height = "auto";
      img.style.borderRadius = `${imgStyle.borderRadius}px`;
      img.style.verticalAlign = "middle";
      img.style.display = "inline-block";
      root.appendChild(img);
    }
  }
  if (root.childNodes.length === 0) {
    root.appendChild(document.createTextNode("\u200b"));
  }
}

function plainLengthOfSubtree(n: Node, editorRoot: HTMLElement): number {
  if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? "").length;
  if (n.nodeType !== Node.ELEMENT_NODE) return 0;
  const el = n as HTMLElement;
  if (el.tagName === "IMG") return (el.getAttribute("data-url") ?? "").length;
  if (el.tagName === "BR") return 1;
  let t = 0;
  for (const c of el.childNodes) t += plainLengthOfSubtree(c, editorRoot);
  if ((el.tagName === "DIV" || el.tagName === "P") && el.parentNode === editorRoot) t += 1;
  return t;
}

/** Map selection/caret to plain-text offsets (ordering matches `serializeComposerEditor`). */
export function domPointToPlainOffset(root: HTMLElement, node: Node, offset: number): number {
  if (node === root) {
    let p = 0;
    const lim = Math.min(offset, root.childNodes.length);
    for (let i = 0; i < lim; i++) {
      p += plainLengthOfSubtree(root.childNodes[i]!, root);
    }
    return p;
  }

  let pos = 0;
  let done = false;

  function visit(n: Node): void {
    if (done) return;
    if (n.nodeType === Node.TEXT_NODE) {
      const len = (n.textContent ?? "").length;
      if (n === node) {
        pos += Math.min(offset, len);
        done = true;
        return;
      }
      pos += len;
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    if (el.tagName === "IMG") {
      const len = (el.getAttribute("data-url") ?? "").length;
      if (el === node) {
        pos += offset === 0 ? 0 : len;
        done = true;
        return;
      }
      pos += len;
      return;
    }
    if (el.tagName === "BR") {
      if (el === node) {
        pos += offset === 0 ? 0 : 1;
        done = true;
        return;
      }
      pos += 1;
      return;
    }
    for (const c of el.childNodes) {
      visit(c);
      if (done) return;
    }
    if ((el.tagName === "DIV" || el.tagName === "P") && el.parentNode === root) {
      pos += 1;
    }
  }

  for (const c of root.childNodes) {
    visit(c);
    if (done) break;
  }
  return pos;
}

export function getPlainTextOffsetsFromSelection(root: HTMLElement): { start: number; end: number } {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { start: 0, end: 0 };
  const a = domPointToPlainOffset(root, sel.anchorNode!, sel.anchorOffset);
  const f = domPointToPlainOffset(root, sel.focusNode!, sel.focusOffset);
  return { start: Math.min(a, f), end: Math.max(a, f) };
}

function setBoundary(root: HTMLElement, offset: number, range: Range, isStart: boolean): void {
  let pos = 0;
  let placed = false;

  function visit(n: Node): void {
    if (placed) return;
    if (n.nodeType === Node.TEXT_NODE) {
      const len = (n.textContent ?? "").length;
      if (pos + len >= offset) {
        const o = Math.max(0, Math.min(len, offset - pos));
        if (isStart) range.setStart(n, o);
        else range.setEnd(n, o);
        placed = true;
        return;
      }
      pos += len;
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    if (el.tagName === "IMG") {
      const len = (el.getAttribute("data-url") ?? "").length;
      if (offset <= pos) {
        if (isStart) range.setStartBefore(el);
        else range.setEndBefore(el);
        placed = true;
        return;
      }
      if (offset <= pos + len) {
        if (isStart) range.setStartAfter(el);
        else range.setEndAfter(el);
        placed = true;
        return;
      }
      pos += len;
      return;
    }
    if (el.tagName === "BR") {
      if (offset <= pos) {
        const parent = el.parentNode!;
        const idx = Array.prototype.indexOf.call(parent.childNodes, el);
        if (isStart) range.setStart(parent, idx);
        else range.setEnd(parent, idx);
        placed = true;
        return;
      }
      if (offset <= pos + 1) {
        const parent = el.parentNode!;
        const idx = Array.prototype.indexOf.call(parent.childNodes, el) + 1;
        if (isStart) range.setStart(parent, idx);
        else range.setEnd(parent, idx);
        placed = true;
        return;
      }
      pos += 1;
      return;
    }
    for (const c of el.childNodes) {
      visit(c);
      if (placed) return;
    }
    if ((el.tagName === "DIV" || el.tagName === "P") && el.parentNode === root) {
      if (offset <= pos) {
        const idx = Array.prototype.indexOf.call(root.childNodes, el);
        if (isStart) range.setStart(root, idx);
        else range.setEnd(root, idx);
        placed = true;
        return;
      }
      if (offset <= pos + 1) {
        const idx = Array.prototype.indexOf.call(root.childNodes, el) + 1;
        if (isStart) range.setStart(root, idx);
        else range.setEnd(root, idx);
        placed = true;
        return;
      }
      pos += 1;
    }
  }

  if (offset <= 0 && root.firstChild) {
    if (root.firstChild.nodeType === Node.TEXT_NODE) {
      if (isStart) range.setStart(root.firstChild, 0);
      else range.setEnd(root.firstChild, 0);
      placed = true;
    }
  }

  if (!placed) {
    for (const c of root.childNodes) {
      visit(c);
      if (placed) return;
    }
  }

  if (!placed) {
    if (root.childNodes.length === 0) {
      if (isStart) range.setStart(root, 0);
      else range.setEnd(root, 0);
      return;
    }
    const last = root.childNodes[root.childNodes.length - 1]!;
    if (last.nodeType === Node.TEXT_NODE) {
      const len = (last.textContent ?? "").length;
      if (isStart) range.setStart(last, len);
      else range.setEnd(last, len);
    } else {
      if (isStart) range.setStart(root, root.childNodes.length);
      else range.setEnd(root, root.childNodes.length);
    }
  }
}

export function setSelectionPlainTextOffsets(root: HTMLElement, start: number, end: number): void {
  const range = document.createRange();
  setBoundary(root, start, range, true);
  setBoundary(root, end, range, false);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

export function insertPlainTextAtSelection(root: HTMLElement, text: string): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(document.createTextNode(text));
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
}
