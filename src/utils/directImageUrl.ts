/** Absolute https URL suitable for `<img src>` (protocol-relative → https). */
export function normalizeImageSrcHref(href: string): string | null {
  const t = href.trim();
  if (t.startsWith("//")) return `https:${t}`;
  if (/^https?:\/\//i.test(t)) return t;
  return null;
}

/** Path ends in a common static image extension (direct file URLs, not HTML pages). */
export function hrefLooksLikeDirectImageUrl(href: string): boolean {
  const abs = normalizeImageSrcHref(href);
  if (!abs) return false;
  try {
    const u = new URL(abs);
    if (!/^https?:$/i.test(u.protocol)) return false;
    return /\.(gif|jpe?g|png|webp|avif|bmp|svg)(?:$|[?#])/i.test(u.pathname);
  } catch {
    return false;
  }
}

function canonicalImageKey(href: string): string | null {
  const src = normalizeImageSrcHref(href);
  return src ? src.replace(/\/$/, "") : null;
}

/** `href` suitable for `<a href>` (opens in browser). */
export function normalizeLinkHref(href: string): string {
  const t = href.trim();
  if (t.startsWith("//")) return `https:${t}`;
  return t;
}

/**
 * Image/GIF URLs in composer or plain text: markdown `[label](url)` targets, then bare http(s) and // URLs.
 * Order preserved; duplicates (by normalized src) removed.
 */
export function extractDirectImageUrls(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (href: string) => {
    const trimmed = href.trim();
    if (!hrefLooksLikeDirectImageUrl(trimmed)) return;
    const key = canonicalImageKey(trimmed);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };

  const md = /\[[^\]]*\]\((https?:\/\/[^)\s]+|\/\/[^)\s]+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = md.exec(raw)) !== null) push(m[1]);

  const bare = /\b(https?:\/\/[^\s\])>"'`]+|\/\/[^\s\])>"'`]+)/gi;
  while ((m = bare.exec(raw)) !== null) push(m[1]);

  return out;
}

export type ComposerVisualSegment =
  | { type: "text"; text: string }
  | { type: "image"; href: string };

/**
 * Split `raw` into text + direct image URL segments (markdown `[l](url)` or bare URLs).
 * Used by the composer to show images instead of URL characters while keeping `raw` as source of truth.
 */
export function splitTextWithDirectImageEmbeds(raw: string): ComposerVisualSegment[] {
  const segments: ComposerVisualSegment[] = [];
  let segStart = 0;
  let i = 0;

  while (i < raw.length) {
    const at = raw.slice(i);
    const md = at.match(/^\[[^\]]*\]\((https?:\/\/[^)\s]+|\/\/[^)\s]+)\)/);
    if (md && hrefLooksLikeDirectImageUrl(md[1])) {
      if (i > segStart) segments.push({ type: "text", text: raw.slice(segStart, i) });
      segments.push({ type: "image", href: md[1].trim() });
      i += md[0].length;
      segStart = i;
      continue;
    }
    const bare = at.match(/^(https?:\/\/[^\s\])>"'`]+|\/\/[^\s\])>"'`]+)/);
    const boundaryOk =
      i === 0 || /[\s([{<'"`]/.test(raw[i - 1]!) || !/[\w/]/.test(raw[i - 1]!);
    if (bare && boundaryOk && hrefLooksLikeDirectImageUrl(bare[1])) {
      if (i > segStart) segments.push({ type: "text", text: raw.slice(segStart, i) });
      segments.push({ type: "image", href: bare[1].trim() });
      i += bare[0].length;
      segStart = i;
      continue;
    }
    i += 1;
  }
  if (segStart < raw.length) segments.push({ type: "text", text: raw.slice(segStart) });
  return segments;
}
