import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * React state for the user's preferred top-level space sidebar order,
 * backed by the `app.pax.space_order` Matrix account-data event.
 *
 * ### Sync model
 *
 * The stored order is intentionally a superset/subset of the live joined
 * space list:
 *
 *   - **Subset** — the user may be joined to spaces not yet in `storedOrder`
 *     (newly joined spaces that predate the first drag, or spaces joined on
 *     another device that hasn't written).  Consumers append these to the
 *     end using their fallback (alphabetical) order.
 *
 *   - **Superset** — `storedOrder` may contain spaces the user has since
 *     left.  Consumers filter these out at display time.  We don't prune
 *     eagerly because it would require loading the full joined-space list
 *     on every write; pruning is folded into the next `setOrder` call
 *     triggered by a user action.
 *
 * ### Cross-device sync
 *
 * Matrix account data syncs automatically via `/sync`, so a drag on one Pax
 * instance propagates to others.  This hook doesn't subscribe to live
 * account-data events (matrix-sdk's account-data sync is triggered via the
 * existing `rooms-changed` event path); the initial fetch on mount plus
 * refetches on explicit `setOrder` calls cover every path that matters for
 * a single user session.
 */
export function useSpaceOrder() {
  const [storedOrder, setStoredOrder] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** Latest value for reads inside `setOrder` without re-binding. */
  const storedOrderRef = useRef<string[]>([]);
  storedOrderRef.current = storedOrder;

  useEffect(() => {
    let cancelled = false;
    invoke<string[]>("get_space_order")
      .then((order) => {
        if (cancelled) return;
        setStoredOrder(order);
        setLoaded(true);
      })
      .catch((e) => {
        // Don't block the UI if account data is unreachable — we just fall
        // back to the alphabetical default until the next successful read.
        // eslint-disable-next-line no-console
        console.warn("[useSpaceOrder] initial fetch failed:", e);
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Persist a new order.  Callers pass the full ordered list of space ids
   * they want to remember (typically the currently joined spaces in the
   * new post-drop order); left-space ids are pruned implicitly by virtue
   * of not being in the list the caller builds.
   *
   * State updates optimistically: we set `storedOrder` before the network
   * PUT lands, so the sidebar reflects the drop instantly even if the
   * homeserver is slow.  On failure we roll back and log.
   */
  const setOrder = useCallback(async (nextOrder: string[]) => {
    const previous = storedOrderRef.current;
    setStoredOrder(nextOrder);
    try {
      await invoke("set_space_order", { order: nextOrder });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[useSpaceOrder] set_space_order failed; rolling back:", e);
      setStoredOrder(previous);
      throw e;
    }
  }, []);

  return { storedOrder, setOrder, loaded };
}

/**
 * Apply a stored top-level-space order to a live list of joined spaces.
 *
 * - Known ids (present in `storedOrder`) come first, in their stored order.
 * - Unknown ids (joined but not yet in the stored order) come after, in
 *   their original input order (the caller typically passes these already
 *   alpha-sorted).
 * - Stored ids that are no longer present are silently dropped.
 */
export function applyStoredSpaceOrder<T extends { id: string }>(
  spaces: T[],
  storedOrder: string[]
): T[] {
  if (storedOrder.length === 0) return spaces;
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const id of storedOrder) {
    const space = byId.get(id);
    if (space && !seen.has(id)) {
      out.push(space);
      seen.add(id);
    }
  }
  for (const space of spaces) {
    if (!seen.has(space.id)) {
      out.push(space);
      seen.add(space.id);
    }
  }
  return out;
}