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

interface BufferedNewerPage {
  messages: Message[];
  restorePrevBatch: string | null;
}

interface OlderShiftMeta {
  remainingCount: number;
  restorePrevBatch: string | null;
}

interface RecentVisibleWindowSnapshot extends CachedRoom {
  olderRecentPages: Message[][];
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

function replaceExistingMessage(arr: Message[], msg: Message): Message[] {
  const idx = arr.findIndex((m) => m.eventId === msg.eventId);
  if (idx === -1) return arr;
  if (arr[idx] === msg) return arr;
  const next = arr.slice();
  next[idx] = msg;
  return next;
}

function applyMessageEdit(
  arr: Message[],
  payload: MessageEditPayload,
): Message[] {
  const idx = arr.findIndex((m) => m.eventId === payload.targetEventId);
  if (idx === -1) return arr;

  const current = arr[idx];
  const {
    body,
    imageMediaRequest,
    videoMediaRequest,
    fileMediaRequest,
    fileMime,
    fileDisplayName,
  } = payload;

  const {
    imageMediaRequest: _oi,
    videoMediaRequest: _ov,
    fileMediaRequest: _of,
    fileMime: _ofm,
    fileDisplayName: _ofd,
    ...rest
  } = current;

  let nextMessage: Message;
  if (imageMediaRequest != null) {
    nextMessage = { ...rest, body, edited: true, imageMediaRequest };
  } else if (videoMediaRequest != null) {
    nextMessage = { ...rest, body, edited: true, videoMediaRequest };
  } else if (fileMediaRequest != null) {
    nextMessage = {
      ...rest,
      body,
      edited: true,
      fileMediaRequest,
      fileMime: typeof fileMime === "string" ? fileMime : null,
      fileDisplayName:
        typeof fileDisplayName === "string" ? fileDisplayName : null,
    };
  } else {
    nextMessage = { ...rest, body, edited: true };
  }

  const next = arr.slice();
  next[idx] = nextMessage;
  return next;
}

function removeMessageByEventId(arr: Message[], eventId: string): Message[] {
  const idx = arr.findIndex((m) => m.eventId === eventId);
  if (idx === -1) return arr;
  const next = arr.slice();
  next.splice(idx, 1);
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
const MAX_MESSAGES_PER_ROOM = 150;
/** Max messages mounted in the active timeline window. */
const MAX_VISIBLE_MESSAGES = 50;
/** Max rooms held in the global cache. */
const MAX_CACHED_ROOMS = 15;
/** How many evicted newer pages we keep for smooth reverse scrolling. */
const MAX_NEWER_BUFFER_PAGES = 100;
/** Offer a jump affordance once the user is several loads from recent. */
const JUMP_TO_RECENT_AFTER_PAGES = 3;
/** Standard history page size. */
const MESSAGE_PAGE_LIMIT = 25;

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
function normalizeCachedRoomSnapshot(
  messages: Message[],
  prevBatch: string | null,
): CachedRoom {
  let trimmed = messages;
  let cachedPrevBatch = prevBatch;
  if (messages.length > MAX_MESSAGES_PER_ROOM) {
    trimmed = messages.slice(messages.length - MAX_MESSAGES_PER_ROOM);
    cachedPrevBatch = null; // token is no longer contiguous — invalidate
  }
  return { messages: trimmed, prevBatch: cachedPrevBatch };
}

function buildOlderRecentPages(messages: Message[]): Message[][] {
  if (messages.length <= MAX_VISIBLE_MESSAGES) return [];
  const hiddenOlder = messages.slice(0, messages.length - MAX_VISIBLE_MESSAGES);
  const pages: Message[][] = [];
  for (let start = 0; start < hiddenOlder.length; start += MESSAGE_PAGE_LIMIT) {
    pages.push(hiddenOlder.slice(start, start + MESSAGE_PAGE_LIMIT));
  }
  return pages;
}

function normalizeRecentVisibleWindowSnapshot(
  messages: Message[],
  prevBatch: string | null,
): RecentVisibleWindowSnapshot {
  const olderRecentPages = buildOlderRecentPages(messages);
  if (olderRecentPages.length === 0) {
    return { messages, prevBatch, olderRecentPages: [] };
  }
  return {
    messages: messages.slice(messages.length - MAX_VISIBLE_MESSAGES),
    prevBatch,
    olderRecentPages,
  };
}

function setCachedRoom(
  roomId: string,
  messages: Message[],
  prevBatch: string | null,
): CachedRoom {
  const normalized = normalizeCachedRoomSnapshot(messages, prevBatch);
  globalCache.set(roomId, normalized);
  evictRoomsIfNeeded();
  return normalized;
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
  const initialVisible = cached
    ? normalizeRecentVisibleWindowSnapshot(cached.messages, cached.prevBatch)
    : { messages: [], prevBatch: null, olderRecentPages: [] };
  const [messages, setMessages] = useState<Message[]>(initialVisible.messages);
  const [prevBatch, setPrevBatch] = useState<string | null>(initialVisible.prevBatch);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [bufferedOlderRecentPages, setBufferedOlderRecentPages] = useState(
    initialVisible.olderRecentPages.length,
  );
  const [bufferedNewerPages, setBufferedNewerPages] = useState(0);
  const [pageDistanceFromRecent, setPageDistanceFromRecent] = useState(0);
  const [pendingRecentCount, setPendingRecentCount] = useState(0);
  const cacheRef = useRef(globalCache);
  const activeRoomIdRef = useRef(roomId);
  activeRoomIdRef.current = roomId;
  const messagesRef = useRef<Message[]>(initialVisible.messages);
  const prevBatchRef = useRef<string | null>(initialVisible.prevBatch);
  const olderRecentPagesRef = useRef<Message[][]>(initialVisible.olderRecentPages);
  const newerBufferRef = useRef<BufferedNewerPage[]>([]);
  const olderShiftMetaRef = useRef<OlderShiftMeta[]>([]);
  const pageDistanceRef = useRef(0);
  const pendingRecentCountRef = useRef(0);

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
    `[useMessages] render #${renderCountRef.current} room=${roomId?.slice(-6) ?? "null"} msgs=${messages.length} prevBatch=${prevBatch ? prevBatch.slice(0, 12) + "…" : "null"} loading=${loading} hasMore=${bufferedOlderRecentPages > 0 || prevBatch !== null} olderRecentBuf=${bufferedOlderRecentPages} newerBuf=${bufferedNewerPages} pagesFromRecent=${pageDistanceFromRecent} pendingRecent=${pendingRecentCount} lockRef=${loadingLockRef.current} initialFetchRef=${initialFetchingRef.current}`
  );

  const commitVisibleWindow = useCallback((nextMessages: Message[], nextPrevBatch: string | null) => {
    let msgs = nextMessages;
    if (msgs.length > MAX_VISIBLE_MESSAGES) {
      console.warn(
        `[useMessages] commitVisibleWindow: DEFENSIVE CLAMP ${msgs.length} → ${MAX_VISIBLE_MESSAGES}`,
      );
      msgs = msgs.slice(msgs.length - MAX_VISIBLE_MESSAGES);
    }
    messagesRef.current = msgs;
    prevBatchRef.current = nextPrevBatch;
    setMessages(msgs);
    setPrevBatch(nextPrevBatch);
  }, []);

  const setOlderRecentPages = useCallback((pages: Message[][]) => {
    olderRecentPagesRef.current = pages;
    setBufferedOlderRecentPages(pages.length);
  }, []);

  const commitRecentVisibleWindow = useCallback(
    (nextMessages: Message[], nextPrevBatch: string | null) => {
      const normalized = normalizeRecentVisibleWindowSnapshot(
        nextMessages,
        nextPrevBatch,
      );
      setOlderRecentPages(normalized.olderRecentPages);
      commitVisibleWindow(normalized.messages, normalized.prevBatch);
    },
    [commitVisibleWindow, setOlderRecentPages],
  );

  const commitVisibleMessages = useCallback((nextMessages: Message[]) => {
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
  }, []);

  const setPageDistance = useCallback((next: number) => {
    const safe = Math.max(0, next);
    pageDistanceRef.current = safe;
    setPageDistanceFromRecent(safe);
  }, []);

  const setPendingRecent = useCallback((next: number) => {
    const safe = Math.max(0, next);
    pendingRecentCountRef.current = safe;
    setPendingRecentCount(safe);
  }, []);

  const clearHistoryWindowState = useCallback(() => {
    setOlderRecentPages([]);
    newerBufferRef.current = [];
    olderShiftMetaRef.current = [];
    setBufferedNewerPages(0);
    setPageDistance(0);
    setPendingRecent(0);
  }, [setOlderRecentPages, setPageDistance, setPendingRecent]);

  const pushBufferedNewerPage = useCallback((page: BufferedNewerPage) => {
    if (page.messages.length === 0) return;
    const next = [...newerBufferRef.current, page];
    if (next.length > MAX_NEWER_BUFFER_PAGES) next.shift();
    newerBufferRef.current = next;
    setBufferedNewerPages(next.length);
  }, []);

  const popBufferedNewerPage = useCallback((): BufferedNewerPage | null => {
    if (newerBufferRef.current.length === 0) return null;
    const next = newerBufferRef.current.slice();
    const page = next.pop() ?? null;
    newerBufferRef.current = next;
    setBufferedNewerPages(next.length);
    return page;
  }, []);

  const patchBufferedNewerPages = useCallback(
    (updater: (arr: Message[]) => Message[]) => {
      let changed = false;
      const nextPages: BufferedNewerPage[] = [];
      for (const page of newerBufferRef.current) {
        const nextMessages = updater(page.messages);
        if (nextMessages !== page.messages) changed = true;
        if (nextMessages.length > 0) {
          nextPages.push(
            nextMessages === page.messages
              ? page
              : { ...page, messages: nextMessages },
          );
        } else {
          changed = true;
        }
      }
      if (!changed) return;
      newerBufferRef.current = nextPages;
      setBufferedNewerPages(nextPages.length);
    },
    [],
  );

  const patchLatestSnapshot = useCallback(
    (updater: (arr: Message[]) => Message[], prevBatchOverride?: string | null) => {
      const targetRoomId = activeRoomIdRef.current;
      if (!targetRoomId) return;
      const cachedEntry = cacheRef.current.get(targetRoomId);
      const baseMessages =
        cachedEntry?.messages ??
        (pageDistanceRef.current === 0 ? messagesRef.current : []);
      const nextMessages = updater(baseMessages);
      const nextPrevBatch =
        prevBatchOverride === undefined
          ? (cachedEntry?.prevBatch ?? null)
          : prevBatchOverride;
      if (nextMessages === baseMessages && prevBatchOverride === undefined) return;
      setCachedRoom(targetRoomId, nextMessages, nextPrevBatch);
    },
    [],
  );

  const buildLatestSnapshot = useCallback((targetRoomId: string, batch: MessageBatch) => {
    const fetched = batch.messages.slice().reverse();
    const cachedEntry = cacheRef.current.get(targetRoomId);
    const prevLatest = cachedEntry?.messages ?? [];
    const merged = mergeLatestServerWindow(prevLatest, fetched);

    const cacheExtendsOlder =
      prevLatest.length > 0 &&
      fetched.length > 0 &&
      prevLatest[0].timestamp < fetched[0].timestamp;
    const effectivePrevBatch = cacheExtendsOlder
      ? (cachedEntry?.prevBatch ?? batch.prevBatch)
      : batch.prevBatch;

    return {
      fetched,
      merged,
      cachedCount: prevLatest.length,
      cacheExtendsOlder,
      effectivePrevBatch,
      cachedPrevBatch: cachedEntry?.prevBatch ?? null,
    };
  }, []);

  // Before paint: never show another room's timeline (or empty while we have no cache).
  useLayoutEffect(() => {
    // Reset synchronous guards on room switch so a stale in-flight
    // request from the previous room can't block the new one.
    loadingLockRef.current = false;
    initialFetchingRef.current = false;
    renderCountRef.current = 0;
    syncEventCountRef.current = 0;
    clearHistoryWindowState();
    setLoading(false);

    if (!roomId) {
      console.log("[useMessages] layoutEffect: roomId=null, clearing state");
      commitVisibleWindow([], null);
      setInitialLoading(false);
      setRefreshing(false);
      return;
    }

    const cached = cacheRef.current.get(roomId);
    if (cached) {
      const normalizedCached =
        cached.messages.length > MAX_MESSAGES_PER_ROOM
          ? setCachedRoom(roomId, cached.messages, cached.prevBatch)
          : cached;
      touchRoom(roomId);
      console.log(
        `[useMessages] layoutEffect: restored cache room=${roomId.slice(-6)} msgs=${normalizedCached.messages.length} prevBatch=${normalizedCached.prevBatch ? normalizedCached.prevBatch.slice(0, 12) + "…" : "null"}`
      );
      commitRecentVisibleWindow(
        normalizedCached.messages,
        normalizedCached.prevBatch,
      );
      setInitialLoading(false);
    } else {
      console.log(`[useMessages] layoutEffect: no cache for room=${roomId.slice(-6)}, will fetch`);
      commitVisibleWindow([], null);
      setInitialLoading(true);
    }
    setRefreshing(false);
  }, [roomId, clearHistoryWindowState, commitRecentVisibleWindow, commitVisibleWindow]);

  // Fetch from server when room changes (cancelled on switch / unmount).
  useEffect(() => {
    if (!roomId) return;

    let cancelled = false;
    const targetRoomId = roomId;
    const hadCache = !!cacheRef.current.get(targetRoomId);
    if (hadCache) setRefreshing(true);

    initialFetchingRef.current = true;
    const id = seq();
    console.log(
      `[useMessages] initialFetch #${id} START room=${targetRoomId.slice(-6)} hadCache=${hadCache}`
    );

    invoke<MessageBatch>("get_messages", {
      roomId: targetRoomId,
      from: null,
      limit: MESSAGE_PAGE_LIMIT,
    })
      .then((batch) => {
        if (cancelled || activeRoomIdRef.current !== targetRoomId) {
          console.log(`[useMessages] initialFetch #${id} CANCELLED`);
          return;
        }
        const snapshot = buildLatestSnapshot(targetRoomId, batch);

        console.log(
          `[useMessages] initialFetch #${id} DONE fetched=${snapshot.fetched.length} cached=${snapshot.cachedCount} merged=${snapshot.merged.length} cacheExtendsOlder=${snapshot.cacheExtendsOlder} freshToken=${batch.prevBatch ? batch.prevBatch.slice(0, 12) + "…" : "null"} effectiveToken=${snapshot.effectivePrevBatch ? snapshot.effectivePrevBatch.slice(0, 12) + "…" : "null"} cachedToken=${snapshot.cachedPrevBatch ? snapshot.cachedPrevBatch.slice(0, 12) + "…" : "null"}`
        );

        const normalizedSnapshot = setCachedRoom(
          targetRoomId,
          snapshot.merged,
          snapshot.effectivePrevBatch,
        );
        clearHistoryWindowState();
        commitRecentVisibleWindow(
          normalizedSnapshot.messages,
          normalizedSnapshot.prevBatch,
        );
      })
      .catch((e) => {
        if (cancelled || activeRoomIdRef.current !== targetRoomId) return;
        console.error(`[useMessages] initialFetch #${id} ERROR:`, e);
        commitVisibleWindow([], null);
      })
      .finally(() => {
        if (cancelled || activeRoomIdRef.current !== targetRoomId) return;
        initialFetchingRef.current = false;
        setInitialLoading(false);
        setRefreshing(false);
      });

    return () => {
      cancelled = true;
      initialFetchingRef.current = false;
    };
  }, [roomId, buildLatestSnapshot, clearHistoryWindowState, commitRecentVisibleWindow, commitVisibleWindow]);

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

      const cachedEntry = cacheRef.current.get(roomId);
      const cachedMessages = cachedEntry?.messages ?? [];
      const cachedHadEvent = cachedMessages.some((m) => m.eventId === message.eventId);
      const nextCached = insertOrUpdateMessage(cachedMessages, message);
      if (nextCached !== cachedMessages) {
        setCachedRoom(roomId, nextCached, cachedEntry?.prevBatch ?? prevBatchRef.current);
      }

      if (pageDistanceRef.current === 0 && !loadingLockRef.current) {
        const cachedAfter = cacheRef.current.get(roomId);
        if (!cachedAfter) {
          console.log(`[useMessages] sync:room-message #${n} → no-op (same ref)`);
          return;
        }
        console.log(
          `[useMessages] sync:room-message #${n} → recent snapshot=${cachedAfter.messages.length} visible=${Math.min(cachedAfter.messages.length, MAX_VISIBLE_MESSAGES)}`
        );
        commitRecentVisibleWindow(cachedAfter.messages, cachedAfter.prevBatch);
        return;
      }

      // In history mode (pageDistance > 0) or during a loadMore fetch:
      // only update existing messages in the visible window — don't reset it.
      const nextVisible = replaceExistingMessage(messagesRef.current, message);
      if (nextVisible !== messagesRef.current) {
        commitVisibleMessages(nextVisible);
      }
      patchBufferedNewerPages((arr) => replaceExistingMessage(arr, message));
      if (!cachedHadEvent) {
        setPendingRecent(pendingRecentCountRef.current + 1);
      }
    });

    const unlistenEdit = listen<MessageEditPayload>("room-message-edit", (event) => {
      const payload = event.payload;
      const { roomId: rid, targetEventId } = payload;
      if (rid !== roomId) return;

      console.log(
        `[useMessages] sync:room-message-edit room=${roomId.slice(-6)} target=${targetEventId.slice(-8)}`
      );

      patchLatestSnapshot((arr) => applyMessageEdit(arr, payload));

      if (pageDistanceRef.current === 0 && !loadingLockRef.current) {
        const cachedAfter = cacheRef.current.get(roomId);
        if (cachedAfter) {
          commitRecentVisibleWindow(cachedAfter.messages, cachedAfter.prevBatch);
        }
        return;
      }

      const nextVisible = applyMessageEdit(messagesRef.current, payload);
      if (nextVisible !== messagesRef.current) {
        commitVisibleMessages(nextVisible);
      }

      patchBufferedNewerPages((arr) => applyMessageEdit(arr, payload));
    });

    const unlistenRedact = listen<MessageRedactedPayload>("room-message-redacted", (event) => {
      const { roomId: rid, redactedEventId } = event.payload;
      if (rid !== roomId) return;

      console.log(
        `[useMessages] sync:room-message-redacted room=${roomId.slice(-6)} eventId=${redactedEventId.slice(-8)}`
      );

      patchLatestSnapshot((arr) => removeMessageByEventId(arr, redactedEventId));

      if (pageDistanceRef.current === 0 && !loadingLockRef.current) {
        const cachedAfter = cacheRef.current.get(roomId);
        if (cachedAfter) {
          commitRecentVisibleWindow(cachedAfter.messages, cachedAfter.prevBatch);
        }
        return;
      }

      const nextVisible = removeMessageByEventId(messagesRef.current, redactedEventId);
      if (nextVisible !== messagesRef.current) {
        commitVisibleMessages(nextVisible);
      }

      patchBufferedNewerPages((arr) => removeMessageByEventId(arr, redactedEventId));
    });

    return () => {
      unlistenMsg.then((fn) => fn());
      unlistenEdit.then((fn) => fn());
      unlistenRedact.then((fn) => fn());
    };
  }, [
    roomId,
    commitRecentVisibleWindow,
    commitVisibleMessages,
    patchBufferedNewerPages,
    patchLatestSnapshot,
    setPendingRecent,
  ]);

  const loadMore = useCallback(async () => {
    const id = seq();
    console.log(
      `[useMessages] loadMore #${id} ENTER room=${roomId?.slice(-6) ?? "null"} prevBatch=${prevBatchRef.current ? prevBatchRef.current.slice(0, 12) + "…" : "null"} lockRef=${loadingLockRef.current} initialFetchRef=${initialFetchingRef.current} pagesFromRecent=${pageDistanceRef.current} olderRecentBuf=${olderRecentPagesRef.current.length} newerBuf=${newerBufferRef.current.length}`
    );

    // Synchronous ref guards — immune to React's batched state commits.
    if (
      !roomId ||
      loadingLockRef.current ||
      initialFetchingRef.current ||
      (olderRecentPagesRef.current.length === 0 && !prevBatchRef.current)
    ) {
      console.log(
        `[useMessages] loadMore #${id} BAILED: roomId=${!!roomId} prevBatch=${!!prevBatchRef.current} olderRecent=${olderRecentPagesRef.current.length} lock=${loadingLockRef.current} initFetch=${initialFetchingRef.current}`
      );
      return;
    }

    if (olderRecentPagesRef.current.length > 0) {
      const olderRecentPage =
        olderRecentPagesRef.current[olderRecentPagesRef.current.length - 1];
      const nextOlderRecentPages = olderRecentPagesRef.current.slice(0, -1);
      setOlderRecentPages(nextOlderRecentPages);

      const merged = sortedMergeMessages(olderRecentPage, messagesRef.current);
      const evictedNewest = merged.length > MAX_VISIBLE_MESSAGES
        ? merged.slice(MAX_VISIBLE_MESSAGES)
        : [];
      const nextVisible = evictedNewest.length > 0
        ? merged.slice(0, MAX_VISIBLE_MESSAGES)
        : merged;

      if (evictedNewest.length > 0) {
        pushBufferedNewerPage({
          messages: evictedNewest,
          restorePrevBatch: prevBatchRef.current,
        });
        olderShiftMetaRef.current.push({
          remainingCount: evictedNewest.length,
          restorePrevBatch: prevBatchRef.current,
        });
        console.log(
          `[useMessages] loadMore #${id} EVICTED ${evictedNewest.length} newest → newerBuf=${newerBufferRef.current.length}`
        );
      }

      setPageDistance(pageDistanceRef.current + 1);
      console.log(
        `[useMessages] loadMore #${id} RECENT-BUFFER restored=${olderRecentPage.length} visible=${nextVisible.length} olderRecentBuf=${nextOlderRecentPages.length} newerBuf=${newerBufferRef.current.length}`
      );
      commitVisibleWindow(nextVisible, prevBatchRef.current);
      return;
    }

    const targetRoomId = roomId;
    const requestPrevBatch = prevBatchRef.current;
    loadingLockRef.current = true;
    setLoading(true);

    // Optimistically enter "history mode" so sync events arriving during
    // the async fetch won't call commitRecentVisibleWindow and reset the
    // visible window out from under us.
    setPageDistance(pageDistanceRef.current + 1);
    let pageDistanceCommitted = false;

    const t0 = performance.now();
    try {
      const batch = await invoke<MessageBatch>("get_messages", {
        roomId: targetRoomId,
        from: requestPrevBatch,
        limit: MESSAGE_PAGE_LIMIT,
      });
      if (activeRoomIdRef.current !== targetRoomId) return;

      const older = batch.messages.reverse();
      const elapsed = (performance.now() - t0).toFixed(0);
      const merged = sortedMergeMessages(older, messagesRef.current);
      const newCount = merged.length - messagesRef.current.length;

      const evictedNewest = merged.length > MAX_VISIBLE_MESSAGES
        ? merged.slice(MAX_VISIBLE_MESSAGES)
        : [];
      const nextVisible = evictedNewest.length > 0
        ? merged.slice(0, MAX_VISIBLE_MESSAGES)
        : merged;

      if (evictedNewest.length > 0) {
        pushBufferedNewerPage({
          messages: evictedNewest,
          restorePrevBatch: requestPrevBatch,
        });
        olderShiftMetaRef.current.push({
          remainingCount: evictedNewest.length,
          restorePrevBatch: requestPrevBatch,
        });
        console.log(
          `[useMessages] loadMore #${id} EVICTED ${evictedNewest.length} newest → newerBuf=${newerBufferRef.current.length}`
        );
      }

      console.log(
        `[useMessages] loadMore #${id} DONE in ${elapsed}ms: fetched=${older.length} prev=${messagesRef.current.length} merged=${merged.length} NEW=${newCount} visible=${nextVisible.length} newerBuf=${newerBufferRef.current.length} newToken=${batch.prevBatch ? batch.prevBatch.slice(0, 12) + "…" : "null"}`
      );

      if (newCount === 0) {
        console.warn(
          `[useMessages] loadMore #${id} ⚠ ZERO new messages — prevBatch token likely points into already-loaded content`
        );
      } else {
        pageDistanceCommitted = true;
      }

      commitVisibleWindow(nextVisible, batch.prevBatch);
    } catch (e) {
      console.error(`[useMessages] loadMore #${id} ERROR:`, e);
    } finally {
      if (activeRoomIdRef.current === targetRoomId) {
        setLoading(false);
        if (!pageDistanceCommitted) {
          setPageDistance(pageDistanceRef.current - 1);
        }
      }
      loadingLockRef.current = false;
    }
  }, [
    roomId,
    commitVisibleWindow,
    pushBufferedNewerPage,
    setOlderRecentPages,
    setPageDistance,
  ]);

  const loadNewer = useCallback(() => {
    if (!roomId) return;
    const page = popBufferedNewerPage();
    if (!page) return;

    const appended = sortedMergeMessages(messagesRef.current, page.messages);
    const overflow = Math.max(0, appended.length - MAX_VISIBLE_MESSAGES);
    const nextVisible = overflow > 0 ? appended.slice(overflow) : appended;

    let nextPrevBatch = prevBatchRef.current;
    let remainingTrim = overflow;
    while (remainingTrim > 0 && olderShiftMetaRef.current.length > 0) {
      const meta = olderShiftMetaRef.current[olderShiftMetaRef.current.length - 1];
      if (remainingTrim < meta.remainingCount) {
        meta.remainingCount -= remainingTrim;
        remainingTrim = 0;
      } else {
        remainingTrim -= meta.remainingCount;
        nextPrevBatch = meta.restorePrevBatch;
        olderShiftMetaRef.current.pop();
      }
    }

    const nextPageDistance = Math.max(0, pageDistanceRef.current - 1);
    setPageDistance(nextPageDistance);
    if (nextPageDistance === 0 && newerBufferRef.current.length === 0) {
      olderShiftMetaRef.current = [];
      const cachedEntry = cacheRef.current.get(roomId);
      if (cachedEntry) {
        commitRecentVisibleWindow(cachedEntry.messages, cachedEntry.prevBatch);
        setPendingRecent(0);
        return;
      }
    }

    console.log(
      `[useMessages] loadNewer room=${roomId.slice(-6)} restored=${page.messages.length} overflow=${overflow} visible=${nextVisible.length} newerBuf=${newerBufferRef.current.length} pagesFromRecent=${nextPageDistance}`
    );

    commitVisibleWindow(nextVisible, nextPrevBatch);
  }, [
    roomId,
    commitRecentVisibleWindow,
    commitVisibleWindow,
    popBufferedNewerPage,
    setPageDistance,
    setPendingRecent,
  ]);

  // Re-fetch latest messages (after sending)
  const refresh = useCallback(async () => {
    if (!roomId) return;

    const id = seq();
    const targetRoomId = roomId;
    console.log(`[useMessages] refresh #${id} START room=${targetRoomId.slice(-6)}`);

    try {
      const batch = await invoke<MessageBatch>("get_messages", {
        roomId: targetRoomId,
        from: null,
        limit: MESSAGE_PAGE_LIMIT,
      });
      if (activeRoomIdRef.current !== targetRoomId) return;

      const snapshot = buildLatestSnapshot(targetRoomId, batch);

      console.log(
        `[useMessages] refresh #${id} DONE fetched=${snapshot.fetched.length} prev=${snapshot.cachedCount} merged=${snapshot.merged.length} cacheExtendsOlder=${snapshot.cacheExtendsOlder} pagesFromRecent=${pageDistanceRef.current}`
      );

      const normalizedSnapshot = setCachedRoom(
        targetRoomId,
        snapshot.merged,
        snapshot.effectivePrevBatch,
      );
      if (pageDistanceRef.current === 0) {
        commitRecentVisibleWindow(
          normalizedSnapshot.messages,
          normalizedSnapshot.prevBatch,
        );
        setPendingRecent(0);
      } else if (snapshot.merged.length > snapshot.cachedCount) {
        setPendingRecent(
          pendingRecentCountRef.current + (snapshot.merged.length - snapshot.cachedCount),
        );
      }
    } catch (e) {
      console.error(`[useMessages] refresh #${id} ERROR:`, e);
    }
  }, [roomId, buildLatestSnapshot, commitRecentVisibleWindow, setPendingRecent]);

  const jumpToRecent = useCallback(async () => {
    if (!roomId) return;
    const targetRoomId = roomId;
    const cachedEntry = cacheRef.current.get(targetRoomId);
    const normalizedCached =
      cachedEntry == null
        ? null
        : cachedEntry.messages.length > MAX_MESSAGES_PER_ROOM
          ? setCachedRoom(targetRoomId, cachedEntry.messages, cachedEntry.prevBatch)
          : cachedEntry;
    clearHistoryWindowState();
    if (normalizedCached) {
      touchRoom(targetRoomId);
      commitRecentVisibleWindow(
        normalizedCached.messages,
        normalizedCached.prevBatch,
      );
    }

    setRefreshing(true);
    try {
      const batch = await invoke<MessageBatch>("get_messages", {
        roomId: targetRoomId,
        from: null,
        limit: MESSAGE_PAGE_LIMIT,
      });
      if (activeRoomIdRef.current !== targetRoomId) return;

      const snapshot = buildLatestSnapshot(targetRoomId, batch);
      const normalizedSnapshot = setCachedRoom(
        targetRoomId,
        snapshot.merged,
        snapshot.effectivePrevBatch,
      );
      commitRecentVisibleWindow(
        normalizedSnapshot.messages,
        normalizedSnapshot.prevBatch,
      );
      setPendingRecent(0);
    } catch (e) {
      console.error("[useMessages] jumpToRecent ERROR:", e);
    } finally {
      if (activeRoomIdRef.current === targetRoomId) {
        setRefreshing(false);
      }
    }
  }, [roomId, buildLatestSnapshot, clearHistoryWindowState, commitRecentVisibleWindow, setPendingRecent]);

  const removeMessageById = useCallback(
    (eventId: string) => {
      if (!roomId) return;
      patchLatestSnapshot((arr) => removeMessageByEventId(arr, eventId));
      if (pageDistanceRef.current === 0) {
        const cachedAfter = cacheRef.current.get(roomId);
        if (cachedAfter) {
          commitRecentVisibleWindow(cachedAfter.messages, cachedAfter.prevBatch);
        }
        return;
      }
      const nextVisible = removeMessageByEventId(messagesRef.current, eventId);
      if (nextVisible !== messagesRef.current) {
        commitVisibleMessages(nextVisible);
      }
      patchBufferedNewerPages((arr) => removeMessageByEventId(arr, eventId));
    },
    [
      roomId,
      commitRecentVisibleWindow,
      commitVisibleMessages,
      patchBufferedNewerPages,
      patchLatestSnapshot,
    ],
  );

  const canRestoreNewer = bufferedNewerPages > 0;
  const showJumpToRecent =
    pageDistanceFromRecent >= JUMP_TO_RECENT_AFTER_PAGES || pendingRecentCount > 0;

  return {
    messages,
    loadMore,
    loadNewer,
    hasMore: bufferedOlderRecentPages > 0 || prevBatch !== null,
    loading,
    initialLoading,
    refreshing,
    canRestoreNewer,
    pageDistanceFromRecent,
    pendingRecentCount,
    showJumpToRecent,
    jumpToRecent,
    refresh,
    removeMessageById,
  };
}