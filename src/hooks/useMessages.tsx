import { useEffect, useLayoutEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Message, MessageBatch } from "../types/matrix";

interface RoomMessagePayload {
  roomId: string;
  message: Message;
}

interface MessageEditPayload {
  roomId: string;
  targetEventId: string;
  body: string;
  imageMediaRequest: unknown | null;
  videoMediaRequest: unknown | null;
  fileMediaRequest: unknown | null;
  fileMime: unknown | null;
  fileDisplayName: unknown | null;
}

interface MessageRedactedPayload {
  roomId: string;
  redactedEventId: string;
}

interface CachedRoom {
  messages: Message[];
  prevBatch: string | null;
}

/* ------------------------------------------------------------------ */
/*  Merge helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Merge two timestamp-sorted message arrays. `second` wins on eventId
 * collisions (so newer fetches overwrite stale bodies / `edited` flags).
 * O(n) when both inputs are already sorted — avoids the old Map + full
 * re-sort that fired on every single sync event.
 *
 * Returns `second` by reference when `first` adds nothing new (all dupes),
 * which lets React bail out of re-rendering via referential equality.
 */
function sortedMergeMessages(first: Message[], second: Message[]): Message[] {
  if (first.length === 0) return second;
  if (second.length === 0) return first;

  // Index second's eventIds so we can skip dupes in first.
  const secondIds = new Set<string>();
  for (const m of second) secondIds.add(m.eventId);

  // Quick check: if every message in `first` already exists in `second`,
  // the merge result is identical to `second` — return it directly to
  // avoid allocating a new array and triggering a React re-render.
  let firstHasNew = false;
  for (const m of first) {
    if (!secondIds.has(m.eventId)) {
      firstHasNew = true;
      break;
    }
  }
  if (!firstHasNew) return second;

  const result: Message[] = [];
  let i = 0;
  let j = 0;
  while (i < first.length && j < second.length) {
    // Skip anything in `first` that `second` supersedes.
    if (secondIds.has(first[i].eventId)) {
      i++;
      continue;
    }
    if (first[i].timestamp <= second[j].timestamp) {
      result.push(first[i++]);
    } else {
      result.push(second[j++]);
    }
  }
  while (i < first.length) {
    if (!secondIds.has(first[i].eventId)) result.push(first[i]);
    i++;
  }
  while (j < second.length) result.push(second[j++]);
  return result;
}

/**
 * Fast path for a single live message from sync: update-in-place if it
 * already exists, otherwise binary-insert by timestamp.  Most live
 * messages land at the very end so the common case is O(1).
 */
function insertOrUpdateMessage(arr: Message[], msg: Message): Message[] {
  // Update existing?
  const idx = arr.findIndex((m) => m.eventId === msg.eventId);
  if (idx !== -1) {
    // Same reference check — skip no-op updates.
    if (arr[idx] === msg) return arr;
    const next = arr.slice();
    next[idx] = msg;
    return next;
  }

  // Append (most common for live messages).
  if (arr.length === 0 || msg.timestamp >= arr[arr.length - 1].timestamp) {
    return [...arr, msg];
  }

  // Rare out-of-order: binary search for the right slot.
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].timestamp < msg.timestamp) lo = mid + 1;
    else hi = mid;
  }
  const next = arr.slice();
  next.splice(lo, 0, msg);
  return next;
}

/**
 * After fetching the latest window from the server, drop any in-memory rows
 * in that time window that the server no longer returned (e.g. redacted /
 * deleted messages).
 */
function mergeLatestServerWindow(prev: Message[], fetched: Message[]): Message[] {
  if (fetched.length === 0) return prev;
  const oldestFetchedTs = fetched[0].timestamp;
  const olderOnly = prev.filter((m) => m.timestamp < oldestFetchedTs);
  return sortedMergeMessages(olderOnly, fetched);
}

/* ------------------------------------------------------------------ */
/*  Global room cache                                                  */
/* ------------------------------------------------------------------ */

/** Max messages kept in the cache per room. */
const MAX_MESSAGES_PER_ROOM = 300;
/** Max rooms held in the global cache. */
const MAX_CACHED_ROOMS = 15;

const globalCache = new Map<string, CachedRoom>();

/** Touch a room to mark it most-recently-used (Map preserves insertion order). */
function touchRoom(roomId: string) {
  const entry = globalCache.get(roomId);
  if (entry) {
    globalCache.delete(roomId);
    globalCache.set(roomId, entry);
  }
}

/** Evict oldest rooms when the cache exceeds the limit. */
function evictRoomsIfNeeded() {
  while (globalCache.size > MAX_CACHED_ROOMS) {
    const oldest = globalCache.keys().next().value;
    if (oldest) globalCache.delete(oldest);
    else break;
  }
}

/**
 * Store messages for a room, trimming to MAX_MESSAGES_PER_ROOM.
 *
 * When trimming occurs the oldest messages are dropped.  Because the
 * `prevBatch` pagination token pointed at content older than the
 * now-trimmed boundary, it would produce a gap on the next load.
 * Clear it so the UI shows "Beginning of conversation" rather than
 * attempting to paginate into a gap.  The initial fetch on the next
 * room visit will set a fresh, valid token.
 */
function setCachedRoom(roomId: string, messages: Message[], prevBatch: string | null) {
  let trimmed = messages;
  let cachedPrevBatch = prevBatch;
  if (messages.length > MAX_MESSAGES_PER_ROOM) {
    trimmed = messages.slice(messages.length - MAX_MESSAGES_PER_ROOM);
    cachedPrevBatch = null; // token is no longer contiguous — invalidate
  }
  globalCache.set(roomId, { messages: trimmed, prevBatch: cachedPrevBatch });
  evictRoomsIfNeeded();
}

export function clearMessageCache() {
  globalCache.clear();
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

// Monotonic counter for log correlation
let _seqId = 0;
function seq() { return ++_seqId; }

export function useMessages(roomId: string | null) {
  const cached = roomId ? globalCache.get(roomId) : undefined;
  const [messages, setMessages] = useState<Message[]>(cached?.messages ?? []);
  const [prevBatch, setPrevBatch] = useState<string | null>(cached?.prevBatch ?? null);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const cacheRef = useRef(globalCache);

  // ---- Synchronous guards (immune to React's async batching) --------
  /** Prevents concurrent `loadMore` calls between setLoading(true) and the next React commit. */
  const loadingLockRef = useRef(false);
  /** True while the initial fetch (from: null) is in flight — blocks loadMore from racing it. */
  const initialFetchingRef = useRef(false);

  // ---- Logging refs ----
  const renderCountRef = useRef(0);
  renderCountRef.current++;
  const syncEventCountRef = useRef(0);

  console.log(
    `[useMessages] render #${renderCountRef.current} room=${roomId?.slice(-6) ?? "null"} msgs=${messages.length} prevBatch=${prevBatch ? prevBatch.slice(0, 12) + "…" : "null"} loading=${loading} hasMore=${prevBatch !== null} lockRef=${loadingLockRef.current} initialFetchRef=${initialFetchingRef.current}`
  );

  // Before paint: never show another room's timeline (or empty while we have no cache).
  useLayoutEffect(() => {
    // Reset synchronous guards on room switch so a stale in-flight
    // request from the previous room can't block the new one.
    loadingLockRef.current = false;
    initialFetchingRef.current = false;
    renderCountRef.current = 0;
    syncEventCountRef.current = 0;

    if (!roomId) {
      console.log("[useMessages] layoutEffect: roomId=null, clearing state");
      setMessages([]);
      setPrevBatch(null);
      setInitialLoading(false);
      setRefreshing(false);
      return;
    }

    const cached = cacheRef.current.get(roomId);
    if (cached) {
      touchRoom(roomId);
      console.log(
        `[useMessages] layoutEffect: restored cache room=${roomId.slice(-6)} msgs=${cached.messages.length} prevBatch=${cached.prevBatch ? cached.prevBatch.slice(0, 12) + "…" : "null"}`
      );
      setMessages(cached.messages);
      setPrevBatch(cached.prevBatch);
      setInitialLoading(false);
    } else {
      console.log(`[useMessages] layoutEffect: no cache for room=${roomId.slice(-6)}, will fetch`);
      setMessages([]);
      setPrevBatch(null);
      setInitialLoading(true);
    }
    setRefreshing(false);
  }, [roomId]);

  // Fetch from server when room changes (cancelled on switch / unmount).
  useEffect(() => {
    if (!roomId) return;

    let cancelled = false;
    const hadCache = !!cacheRef.current.get(roomId);
    if (hadCache) setRefreshing(true);

    initialFetchingRef.current = true;
    const id = seq();
    console.log(
      `[useMessages] initialFetch #${id} START room=${roomId.slice(-6)} hadCache=${hadCache}`
    );

    invoke<MessageBatch>("get_messages", { roomId, from: null, limit: 50 })
      .then((batch) => {
        if (cancelled) {
          console.log(`[useMessages] initialFetch #${id} CANCELLED`);
          return;
        }
        const fetched = batch.messages.reverse();
        const cachedEntry = cacheRef.current.get(roomId);
        const prev = cachedEntry?.messages ?? [];
        const merged = mergeLatestServerWindow(prev, fetched);

        const cacheExtendsOlder =
          prev.length > 0 &&
          fetched.length > 0 &&
          prev[0].timestamp < fetched[0].timestamp;
        const effectivePrevBatch = cacheExtendsOlder
          ? (cachedEntry?.prevBatch ?? batch.prevBatch)
          : batch.prevBatch;

        console.log(
          `[useMessages] initialFetch #${id} DONE fetched=${fetched.length} cached=${prev.length} merged=${merged.length} cacheExtendsOlder=${cacheExtendsOlder} freshToken=${batch.prevBatch ? batch.prevBatch.slice(0, 12) + "…" : "null"} effectiveToken=${effectivePrevBatch ? effectivePrevBatch.slice(0, 12) + "…" : "null"} cachedToken=${cachedEntry?.prevBatch ? cachedEntry.prevBatch.slice(0, 12) + "…" : "null"}`
        );

        setMessages(merged);
        setPrevBatch(effectivePrevBatch);
        setCachedRoom(roomId, merged, effectivePrevBatch);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error(`[useMessages] initialFetch #${id} ERROR:`, e);
        setMessages([]);
        setPrevBatch(null);
      })
      .finally(() => {
        if (cancelled) return;
        initialFetchingRef.current = false;
        setInitialLoading(false);
        setRefreshing(false);
      });

    return () => {
      cancelled = true;
      initialFetchingRef.current = false;
    };
  }, [roomId]);

  // Listen for live message events from the sync loop (new, edit, redact)
  useEffect(() => {
    if (!roomId) return;

    const unlistenMsg = listen<RoomMessagePayload>("room-message", (event) => {
      const { roomId: msgRoomId, message } = event.payload;
      if (msgRoomId !== roomId) return;

      const n = ++syncEventCountRef.current;
      console.log(
        `[useMessages] sync:room-message #${n} room=${roomId.slice(-6)} eventId=${message.eventId.slice(-8)} sender=${message.sender.slice(-12)} ts=${message.timestamp}`
      );

      setMessages((prev) => {
        const next = insertOrUpdateMessage(prev, message);
        if (next === prev) {
          console.log(`[useMessages] sync:room-message #${n} → no-op (same ref)`);
        } else {
          console.log(`[useMessages] sync:room-message #${n} → ${prev.length}→${next.length} msgs`);
        }
        setCachedRoom(roomId, next, cacheRef.current.get(roomId)?.prevBatch ?? null);
        return next;
      });
    });

    const unlistenEdit = listen<MessageEditPayload>("room-message-edit", (event) => {
      const {
        roomId: rid,
        targetEventId,
        body,
        imageMediaRequest,
        videoMediaRequest,
        fileMediaRequest,
        fileMime,
        fileDisplayName,
      } = event.payload;
      if (rid !== roomId) return;

      console.log(
        `[useMessages] sync:room-message-edit room=${roomId.slice(-6)} target=${targetEventId.slice(-8)}`
      );

      setMessages((prev) => {
        const next = prev.map((m) => {
          if (m.eventId !== targetEventId) return m;
          const {
            imageMediaRequest: _oi,
            videoMediaRequest: _ov,
            fileMediaRequest: _of,
            fileMime: _ofm,
            fileDisplayName: _ofd,
            ...rest
          } = m;
          if (imageMediaRequest != null) {
            return { ...rest, body, edited: true, imageMediaRequest };
          }
          if (videoMediaRequest != null) {
            return { ...rest, body, edited: true, videoMediaRequest };
          }
          if (fileMediaRequest != null) {
            return {
              ...rest,
              body,
              edited: true,
              fileMediaRequest,
              fileMime: typeof fileMime === "string" ? fileMime : null,
              fileDisplayName: typeof fileDisplayName === "string" ? fileDisplayName : null,
            };
          }
          return { ...rest, body, edited: true };
        });
        setCachedRoom(roomId, next, cacheRef.current.get(roomId)?.prevBatch ?? null);
        return next;
      });
    });

    const unlistenRedact = listen<MessageRedactedPayload>("room-message-redacted", (event) => {
      const { roomId: rid, redactedEventId } = event.payload;
      if (rid !== roomId) return;

      console.log(
        `[useMessages] sync:room-message-redacted room=${roomId.slice(-6)} eventId=${redactedEventId.slice(-8)}`
      );

      setMessages((prev) => {
        const next = prev.filter((m) => m.eventId !== redactedEventId);
        setCachedRoom(roomId, next, cacheRef.current.get(roomId)?.prevBatch ?? null);
        return next;
      });
    });

    return () => {
      unlistenMsg.then((fn) => fn());
      unlistenEdit.then((fn) => fn());
      unlistenRedact.then((fn) => fn());
    };
  }, [roomId]);

  const loadMore = useCallback(async () => {
    const id = seq();
    console.log(
      `[useMessages] loadMore #${id} ENTER room=${roomId?.slice(-6) ?? "null"} prevBatch=${prevBatch ? prevBatch.slice(0, 12) + "…" : "null"} lockRef=${loadingLockRef.current} initialFetchRef=${initialFetchingRef.current}`
    );

    // Synchronous ref guards — immune to React's batched state commits.
    if (!roomId || !prevBatch || loadingLockRef.current || initialFetchingRef.current) {
      console.log(
        `[useMessages] loadMore #${id} BAILED: roomId=${!!roomId} prevBatch=${!!prevBatch} lock=${loadingLockRef.current} initFetch=${initialFetchingRef.current}`
      );
      return;
    }

    loadingLockRef.current = true;
    setLoading(true);
    const t0 = performance.now();
    try {
      const batch = await invoke<MessageBatch>("get_messages", {
        roomId,
        from: prevBatch,
        limit: 50,
      });
      const older = batch.messages.reverse();
      const elapsed = (performance.now() - t0).toFixed(0);

      setMessages((prev) => {
        const merged = sortedMergeMessages(older, prev);
        const newCount = merged.length - prev.length;
        console.log(
          `[useMessages] loadMore #${id} DONE in ${elapsed}ms: fetched=${older.length} prev=${prev.length} merged=${merged.length} NEW=${newCount} sameRef=${merged === prev} newToken=${batch.prevBatch ? batch.prevBatch.slice(0, 12) + "…" : "null"}`
        );
        if (newCount === 0) {
          console.warn(
            `[useMessages] loadMore #${id} ⚠ ZERO new messages — prevBatch token likely points into already-loaded content`
          );
        }
        setCachedRoom(roomId, merged, batch.prevBatch);
        return merged;
      });
      setPrevBatch(batch.prevBatch);
    } catch (e) {
      console.error(`[useMessages] loadMore #${id} ERROR:`, e);
    } finally {
      loadingLockRef.current = false;
      setLoading(false);
    }
  }, [roomId, prevBatch]);

  // Re-fetch latest messages (after sending)
  const refresh = useCallback(async () => {
    if (!roomId) return;

    const id = seq();
    console.log(`[useMessages] refresh #${id} START room=${roomId.slice(-6)}`);

    try {
      const batch = await invoke<MessageBatch>("get_messages", {
        roomId,
        from: null,
        limit: 50,
      });
      const fetched = batch.messages.reverse();
      const cachedEntry = cacheRef.current.get(roomId);
      const prev = cachedEntry?.messages ?? [];
      const merged = mergeLatestServerWindow(prev, fetched);

      const cacheExtendsOlder =
        prev.length > 0 &&
        fetched.length > 0 &&
        prev[0].timestamp < fetched[0].timestamp;
      const effectivePrevBatch = cacheExtendsOlder
        ? (cachedEntry?.prevBatch ?? batch.prevBatch)
        : batch.prevBatch;

      console.log(
        `[useMessages] refresh #${id} DONE fetched=${fetched.length} prev=${prev.length} merged=${merged.length} cacheExtendsOlder=${cacheExtendsOlder}`
      );

      setMessages(merged);
      setPrevBatch(effectivePrevBatch);
      setCachedRoom(roomId, merged, effectivePrevBatch);
    } catch (e) {
      console.error(`[useMessages] refresh #${id} ERROR:`, e);
    }
  }, [roomId]);

  const removeMessageById = useCallback(
    (eventId: string) => {
      if (!roomId) return;
      setMessages((prev) => {
        const next = prev.filter((m) => m.eventId !== eventId);
        setCachedRoom(roomId, next, cacheRef.current.get(roomId)?.prevBatch ?? null);
        return next;
      });
    },
    [roomId],
  );

  return {
    messages,
    loadMore,
    hasMore: prevBatch !== null,
    loading,
    initialLoading,
    refreshing,
    refresh,
    removeMessageById,
  };
}