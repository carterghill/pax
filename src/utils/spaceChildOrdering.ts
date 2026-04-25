//! Utilities for ordering space children via the `m.space.child` `order`
//! field (admin-set, per-MSC1772/MSC2946) and for generating new order
//! strings when a user drags to insert between two existing siblings.
//!
//! ### Sort algorithm (MSC1772 + MSC2946)
//!
//! Children of a space are sorted by, in order:
//!   1. `order` string, lexicographically (absent last).
//!   2. `origin_server_ts` of the `m.space.child` event, ascending.
//!   3. Room id, lexicographically (final deterministic tiebreaker).
//!
//! The spec treats "`order` absent" as "sort after anything with an `order`".
//! We implement this with a two-bucket split (`have order` first in lex order,
//! then `no order` by `origin_server_ts` / id).
//!
//! ### Order-string generation
//!
//! When the user drops a child between two siblings with known order strings
//! `lo` and `hi`, we compute a string that lex-sorts strictly between them
//! using the printable-ASCII range (0x20..=0x7e) per MSC1772.  This mirrors
//! what Element does and keeps order values short without rebalancing on
//! every drop.
//!
//! When either neighbour has no `order` string (or we're inserting at the
//! ends of an empty list), we synthesise a reasonable bracket ("O" for a
//! mid-range single character) and extend from there.  The resulting strings
//! converge to short values (~1–3 chars) in common insertion patterns and
//! only grow under adversarial repeated-midpoint inserts — which is fine:
//! we cap length at 50 and the backend rejects longer values.
//!
//! All order strings we generate satisfy:
//!   - length in 1..=50
//!   - bytes in 0x20..=0x7e
//!
//! matching the backend validation in `commands::rooms::set_space_child_order`.

import type { Room, SpaceChildOrder } from "../types/matrix";

/** MSC1772: printable-ASCII range that `order` strings may use. */
const ORDER_MIN = 0x20;
const ORDER_MAX = 0x7e;
/** Backend also enforces this; we never generate strings longer. */
const ORDER_MAX_LEN = 50;

/**
 * Get a room's ordering metadata for a given parent space.  Returns a
 * zero-stamp blank when the room isn't a child of that space or when no
 * metadata was carried through from the backend.  Callers should typically
 * already know the room is in the space.
 */
export function getChildOrderInSpace(
  room: Room,
  spaceId: string
): SpaceChildOrder {
  const meta = room.spaceChildOrders?.[spaceId];
  if (meta) return meta;
  return { order: null, originServerTs: 0 };
}

/**
 * Compare two children of the same parent space per the MSC2946 rules.
 * Stable: equal entries fall back to room id as the final tiebreaker.
 */
export function compareSpaceChildren(
  a: Room,
  b: Room,
  parentSpaceId: string
): number {
  const aMeta = getChildOrderInSpace(a, parentSpaceId);
  const bMeta = getChildOrderInSpace(b, parentSpaceId);

  // 1. Bucket by presence of `order`: have-order sorts before no-order.
  const aHas = aMeta.order != null && aMeta.order !== "";
  const bHas = bMeta.order != null && bMeta.order !== "";
  if (aHas && !bHas) return -1;
  if (!aHas && bHas) return 1;

  // 2. Both have `order`: lex-compare.
  if (aHas && bHas) {
    const cmp = (aMeta.order as string).localeCompare(bMeta.order as string);
    if (cmp !== 0) return cmp;
  }

  // 3. Fall through (neither has `order`, or their `order`s are equal):
  //    origin_server_ts asc.
  if (aMeta.originServerTs !== bMeta.originServerTs) {
    return aMeta.originServerTs - bMeta.originServerTs;
  }

  // 4. Final deterministic tiebreaker: room id.
  return a.id.localeCompare(b.id);
}

/**
 * Sort an array of rooms by their `m.space.child` ordering within a given
 * parent space (pure, returns a new array).  Use this instead of
 * alphabetical sort when the rooms are the direct children of a space.
 */
export function sortBySpaceChildOrder(rooms: Room[], parentSpaceId: string): Room[] {
  return [...rooms].sort((a, b) => compareSpaceChildren(a, b, parentSpaceId));
}

/**
 * Return a string that lex-sorts strictly between `lo` and `hi` using bytes
 * in 0x20..=0x7e.  At least one of `lo`/`hi` may be `null` to denote the
 * start/end of the range; passing `null` for both returns a single
 * mid-range character ("O").
 *
 * Invariant: when both are non-null, `lo < hi` lexicographically.  The
 * caller is responsible for ordering them.
 *
 * When `lo` and `hi` are adjacent in printable-ASCII lex order (e.g.
 * `lo="a"`, `hi="a "` where `" "` is 0x20) no valid printable string fits
 * between them.  In that degenerate case this returns `null` so the caller
 * can fall back to a rebalance strategy (rewrite several neighbours).
 */
export function orderStringBetween(
  lo: string | null,
  hi: string | null
): string | null {
  if (!lo && !hi) {
    return "O";
  }
  if (!lo && hi) {
    const out = orderStringBefore(hi);
    return validateBetween(null, hi, out);
  }
  if (lo && !hi) {
    const out = orderStringAfter(lo);
    return validateBetween(lo, null, out);
  }
  const out = orderStringMidpoint(lo as string, hi as string);
  return validateBetween(lo, hi, out);
}

/** Return `candidate` iff lo < candidate < hi (bounds may be null). */
function validateBetween(
  lo: string | null,
  hi: string | null,
  candidate: string
): string | null {
  if (lo !== null && !(lo < candidate)) return null;
  if (hi !== null && !(candidate < hi)) return null;
  // Final sanity: bytes must be printable ASCII.
  for (let i = 0; i < candidate.length; i++) {
    const c = candidate.charCodeAt(i);
    if (c < ORDER_MIN || c > ORDER_MAX) return null;
  }
  return candidate;
}

/** Produce a short string strictly less than `hi`. */
function orderStringBefore(hi: string): string {
  // If the first char of `hi` can be decremented, do that and return one
  // char; otherwise append a mid-range char so we lex less than `hi` but
  // still use printable bytes.  Edge: `hi === " "` (0x20, the minimum) can't
  // be decremented, so we have to insert deeper.
  const c0 = hi.charCodeAt(0);
  if (c0 > ORDER_MIN) {
    return String.fromCharCode(c0 - 1);
  }
  // `hi` starts at 0x20: the only way to be lex-less is a prefix that is ""
  // — impossible since every order string is non-empty — OR to be a shorter
  // string with the same first char but lower at a later position.  The
  // cleanest fallback: generate a new order just after `hi`'s first char
  // minus one is impossible, so instead grow: return `hi[0]` + " " repeated?
  // Simpler: use orderStringMidpoint with a synthetic lo = "" (we emulate by
  // picking a byte just above ORDER_MIN).
  return orderStringMidpoint(String.fromCharCode(ORDER_MIN), hi);
}

/** Produce a short string strictly greater than `lo`. */
function orderStringAfter(lo: string): string {
  const c0 = lo.charCodeAt(0);
  if (c0 < ORDER_MAX) {
    return String.fromCharCode(c0 + 1);
  }
  // `lo` starts at 0x7e: extend by appending a mid-range char so the new
  // string is a prefix-greater sibling (`~O` > `~`).
  if (lo.length >= ORDER_MAX_LEN) {
    // Last-resort safety: we've hit the length cap and the caller is still
    // trying to push past the end.  The backend will reject this; surface
    // it by returning the original string so the caller's equality check
    // can detect the no-op.  In practice this requires ~50 sequential
    // "drop at the bottom" actions all landing on `~`-prefixed strings,
    // which is hard to achieve without a rebalance.
    return lo;
  }
  return lo + "O";
}

/**
 * Find a printable-ASCII string strictly between `lo` and `hi`.
 * Precondition: `lo < hi` lexicographically, both non-empty, both using
 * bytes in 0x20..=0x7e.
 *
 * Algorithm: walk character by character.
 *
 *   - If `lo[i] === hi[i]`, both must share this prefix — emit that char and
 *     descend.
 *   - If `hi[i] - lo[i] >= 2`, midpoint at position `i` is strictly between
 *     and we're done.
 *   - If `hi[i] - lo[i] === 1`, the split has to happen after `lo[i]`: emit
 *     `lo[i]` and then any printable byte that makes us greater than the
 *     rest of `lo` (i.e. greater than `lo[i+1..]`) while remaining shorter /
 *     smaller than `hi[0..i+1]` which ends at `hi[i]`.  A single char > the
 *     final byte of `lo` works, or just "O" appended when `lo` terminates.
 */
function orderStringMidpoint(lo: string, hi: string): string {
  const out: number[] = [];
  const MID = Math.floor((ORDER_MIN + ORDER_MAX) / 2); // 0x4f = "O"

  for (let i = 0; ; i++) {
    const aDefined = i < lo.length;
    const bDefined = i < hi.length;

    // hi ran out while lo hasn't — impossible given lo < hi lexicographically
    // (a shorter string is less than a longer string with the same prefix).
    // Defensive: treat remaining lo as needing to be extended past.
    if (!bDefined) {
      // Fall through to "extend lo" branch below by breaking out here: we
      // can't be between them at this length, so synthesise something > lo.
      out.push(MID);
      break;
    }

    const b = hi.charCodeAt(i);

    if (!aDefined) {
      // lo terminated at an earlier position, but `out` currently equals
      // `lo`'s prefix plus possibly already-equal chars from hi.  We need
      // something strictly > lo but < hi.  Since we've already matched hi's
      // prefix so far (otherwise we'd have branched earlier), the new char
      // at position i must be strictly less than `b` (= hi[i]).  Any
      // printable char in [ORDER_MIN, b-1] works; pick the midpoint of that
      // range for balance, falling back to ORDER_MIN when b == ORDER_MIN+1.
      if (b > ORDER_MIN + 1) {
        out.push(Math.floor((ORDER_MIN + b) / 2));
      } else {
        // b == ORDER_MIN or ORDER_MIN+1: can't insert a char below b at this
        // position; descend one more level with ORDER_MIN and then add MID.
        out.push(ORDER_MIN);
        out.push(MID);
      }
      break;
    }

    const a = lo.charCodeAt(i);

    if (a === b) {
      out.push(a);
      if (out.length >= ORDER_MAX_LEN) {
        // Overflow safety: we're about to exceed 50 chars mid-prefix.  The
        // backend will reject this; in practice this requires a 50-char
        // shared prefix between two adjacent siblings, which only happens
        // after heavy adversarial use.  Emit MID as a last-ditch suffix.
        out.push(MID);
        break;
      }
      continue;
    }

    // a < b at position i.
    if (b - a >= 2) {
      out.push(Math.floor((a + b) / 2));
      break;
    }

    // b - a === 1: emit a and then find something > lo[i+1..].
    out.push(a);
    if (out.length >= ORDER_MAX_LEN) {
      out.push(MID);
      break;
    }
    // Produce the shortest tail that is > lo[i+1..].  A single char > lo[i+1]
    // (or anything printable when lo is exhausted) suffices.
    if (i + 1 >= lo.length) {
      out.push(MID);
      break;
    }
    const next = lo.charCodeAt(i + 1);
    if (next < ORDER_MAX) {
      out.push(next + 1);
      break;
    }
    // next === ORDER_MAX: walk forward through lo's trailing 0x7e run.  Any
    // suffix that extends beyond lo but is all printable works.
    out.push(ORDER_MAX);
    out.push(MID);
    break;
  }

  if (out.length > ORDER_MAX_LEN) {
    out.length = ORDER_MAX_LEN;
  }
  return String.fromCharCode(...out);
}

/**
 * A single `m.space.child` order write: set `childRoomId`'s `order` field
 * in `parentSpaceId` to `order`.
 */
export interface SpaceChildOrderWrite {
  childRoomId: string;
  order: string;
}

/**
 * Plan for applying a drag-drop reorder in a given parent space.
 *
 * In the common case this is a single write to the dragged child.  If the
 * current neighbours' order strings leave no gap (either they're missing,
 * or they're adjacent in the printable-ASCII lex space), we rebalance by
 * reassigning order strings to nearby siblings so the drop has room.
 */
export interface ReorderPlan {
  writes: SpaceChildOrderWrite[];
}

/**
 * Build a reorder plan for moving `draggedChildId` so that the post-drag
 * list has the dragged child immediately before `beforeChildId` (or at the
 * end when `beforeChildId === null`).  `siblingsOrdered` must include the
 * dragged child at its current position and be sorted per
 * {@link compareSpaceChildren} for `parentSpaceId`.
 *
 * This is the primary caller-facing API — it takes a "drop target" that
 * matches what a drag UI naturally knows (the row the user is hovering
 * above) rather than an index, which eliminates pre-drag / post-drag
 * coordinate ambiguity.
 */
export function buildReorderPlan(
  siblingsOrdered: Room[],
  draggedChildId: string,
  beforeChildId: string | null,
  parentSpaceId: string
): ReorderPlan {
  const currentIndex = siblingsOrdered.findIndex((r) => r.id === draggedChildId);
  if (currentIndex < 0) {
    return { writes: [] };
  }

  // Build the post-drag list (dragged child in its new position) up front —
  // this is what we reason about for neighbours and rebalances.  The "new
  // neighbours" of the dragged child are the rows immediately before and
  // after it in this list.
  const without = siblingsOrdered.filter((_, i) => i !== currentIndex);
  let newIndex: number;
  if (beforeChildId === null) {
    newIndex = without.length; // append to end
  } else {
    newIndex = without.findIndex((r) => r.id === beforeChildId);
    if (newIndex < 0) {
      // Target row not in the list (shouldn't happen given the caller just
      // read it from the sidebar's current render); fall back to end.
      newIndex = without.length;
    }
  }

  // No-op detection: dropping the child exactly where it already sits.
  // `without` is the list with the dragged removed; `newIndex` points to
  // where the dragged would be re-inserted.  Re-inserting at position
  // `currentIndex` in `without` yields the original list IFF the dragged
  // child already had an `order` string.  When the dragged child has no
  // `order`, we still want to write one to disambiguate its position
  // against other no-order siblings.
  if (newIndex === currentIndex) {
    const selfMeta = getChildOrderInSpace(
      siblingsOrdered[currentIndex],
      parentSpaceId
    );
    if (selfMeta.order != null && selfMeta.order !== "") {
      return { writes: [] };
    }
  }

  // Compute neighbour order strings.
  const loNeighbour = newIndex > 0 ? without[newIndex - 1] : null;
  const hiNeighbour = newIndex < without.length ? without[newIndex] : null;

  const loOrder = loNeighbour
    ? getChildOrderInSpace(loNeighbour, parentSpaceId).order
    : null;
  const hiOrder = hiNeighbour
    ? getChildOrderInSpace(hiNeighbour, parentSpaceId).order
    : null;

  // Happy path: both neighbours (or the corresponding list edges) have
  // concrete orders and we can fit a new string between them.
  if (
    (loNeighbour === null || (loOrder != null && loOrder !== "")) &&
    (hiNeighbour === null || (hiOrder != null && hiOrder !== ""))
  ) {
    const between = orderStringBetween(loOrder, hiOrder);
    if (between !== null) {
      return {
        writes: [{ childRoomId: draggedChildId, order: between }],
      };
    }
  }

  // Rebalance path: a neighbour is missing `order` (ambiguous sort
  // position), or the printable-ASCII gap is exhausted.  Rewrite all
  // siblings with fresh, evenly spaced orders.
  return buildRebalancePlan(without, draggedChildId, newIndex, parentSpaceId);
}

/**
 * Assign fresh, evenly-spaced order strings to every sibling in the
 * post-drag list, skipping writes that would be no-ops.  Used when the
 * happy-path between-neighbours write would collide with a missing or
 * unwriteable gap.
 */
function buildRebalancePlan(
  withoutDragged: Room[],
  draggedChildId: string,
  newIndex: number,
  parentSpaceId: string
): ReorderPlan {
  // Build the full post-drag list by inserting a placeholder id at newIndex.
  // We'll then generate an order string for each position.  We use a
  // simple 2-character sequence: "A ", "A!", "A\"", ... incrementing the
  // second byte.  With 94 printable chars and 2-char strings we can hold
  // up to 94 * 94 ≈ 8836 entries before we'd need 3 chars — more than
  // enough for any single space's children.
  //
  // Starting at position 0x41 ("A") leaves room above and below for
  // future "insert at top / bottom" operations without rebalancing.
  const postDrag: Array<string> = [];
  for (let i = 0; i < withoutDragged.length + 1; i++) {
    if (i < newIndex) postDrag.push(withoutDragged[i].id);
    else if (i === newIndex) postDrag.push(draggedChildId);
    else postDrag.push(withoutDragged[i - 1].id);
  }

  const N = postDrag.length;
  const writes: SpaceChildOrderWrite[] = [];
  for (let i = 0; i < N; i++) {
    // Evenly spaced orders within "A" .. "Z" when N <= 26; otherwise
    // fall back to two-char orders "A" + printable.
    const order = rebalanceOrderAt(i, N);
    const childId = postDrag[i];
    // Skip writes where the existing order already equals the target —
    // reduces HTTP churn when most siblings are already in a good shape
    // (common after the very first rebalance).
    const existing =
      childId === draggedChildId
        ? null
        : withoutDragged.find((r) => r.id === childId);
    const existingOrder = existing
      ? getChildOrderInSpace(existing, parentSpaceId).order
      : null;
    if (existingOrder === order) continue;
    writes.push({ childRoomId: childId, order });
  }
  return { writes };
}

/**
 * Generate the `i`th of `n` evenly-spaced order strings.  Uses single-char
 * A-Z when n <= 26; otherwise uses `A` + a printable byte per position.
 */
function rebalanceOrderAt(i: number, n: number): string {
  if (n <= 26) {
    // 26 single-char orders from "A" to "Z".
    const c = 0x41 + Math.floor((i * 25) / Math.max(1, n - 1));
    return String.fromCharCode(c);
  }
  // Two-char orders: leading "A", second char scaled across the printable
  // range.  Space (0x20) at position 0 would be a valid sort key but looks
  // ugly when inspecting the event content; skip it by using [0x21, 0x7e].
  const span = ORDER_MAX - (ORDER_MIN + 1);
  const c2 = ORDER_MIN + 1 + Math.floor((i * span) / Math.max(1, n - 1));
  return "A" + String.fromCharCode(c2);
}