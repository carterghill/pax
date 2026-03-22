import {
  Children,
  cloneElement,
  createElement,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { parse as parseTwemoji, type ParsedTwemojiEntity } from "twemoji-parser";

/** Scale for emoji-only messages / composer (body is plain Unicode only). */
export const EMOJI_ONLY_DISPLAY_SCALE = 2;

/**
 * True when `source` is non-empty after trim and every non-whitespace run is a Twemoji-parseable emoji.
 */
export function isOnlyEmojisAndWhitespace(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed) return false;
  const entities = parseTwemoji(trimmed);
  if (entities.length === 0) return false;
  let i = 0;
  let ei = 0;
  while (i < trimmed.length) {
    const c = trimmed[i];
    if (c === " " || c === "\n" || c === "\r" || c === "\t") {
      i += 1;
      continue;
    }
    if (ei >= entities.length) return false;
    const e = entities[ei];
    if (e.indices[0] !== i) return false;
    i = e.indices[1];
    ei += 1;
  }
  return ei === entities.length;
}

function emojifyPlainString(text: string): ReactNode {
  try {
    const entities = parseTwemoji(text);
    if (entities.length === 0) return text;

    const nodes: ReactNode[] = [];
    let cursor = 0;
    entities.forEach((e: ParsedTwemojiEntity, idx: number) => {
      const [start, end] = e.indices;
      if (start > cursor) nodes.push(text.slice(cursor, start));
      nodes.push(
        <span
          key={`tw-${start}-${idx}`}
          className="pax-twemoji-glyph"
          style={{
            fontSize: "1.08em",
            lineHeight: 1,
            verticalAlign: "-0.06em",
            display: "inline-block",
          }}
        >
          {e.text}
        </span>,
      );
      cursor = end;
    });
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return nodes.length === 1 ? nodes[0] : <>{nodes}</>;
  } catch {
    return text;
  }
}

/**
 * Renders Twemoji (COLR font) for Unicode emoji in markdown output while leaving code blocks unchanged.
 */
export function emojifyReactNode(node: ReactNode, inCode: boolean): ReactNode {
  if (inCode) return node;
  if (node == null || typeof node === "boolean") return node;
  if (typeof node === "string" || typeof node === "number") {
    return emojifyPlainString(String(node));
  }
  if (Array.isArray(node)) {
    return node.map((n, i) => (
      <Fragment key={i}>{emojifyReactNode(n, inCode)}</Fragment>
    ));
  }
  if (!isValidElement(node)) return node;

  const el = node as ReactElement<{ children?: ReactNode }>;
  const type = el.type;

  if (type === Fragment) {
    return createElement(
      Fragment,
      { key: el.key },
      emojifyReactNode(el.props.children as ReactNode, inCode),
    );
  }
  if (type === "pre" || type === "code") {
    return cloneElement(el, {
      children: emojifyReactNode(el.props.children as ReactNode, true),
    });
  }

  const ch = el.props.children as ReactNode;
  if (ch === undefined || ch === null) return el;

  return cloneElement(el, {
    children: emojifyReactNode(ch, inCode),
  });
}

/** Normalize markdown children (incl. nested fragments) before emojifying. */
export function emojifyMarkdownChildren(children: ReactNode): ReactNode {
  return emojifyReactNode(Children.toArray(children), false);
}
