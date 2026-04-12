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
}

interface MessageRedactedPayload {
  roomId: string;
  redactedEventId: string;
}

interface CachedRoom {
  messages: Message[];
  prevBatch: string | null;
}

/** Merge by `eventId`; later arguments win (used so refresh / newer fetches overwrite bodies + `edited`). */
function mergeMessagesByEventId(first: Message[], second: Message[]): Message[] {
  const map = new Map<string, Message>();
  for (const m of first) map.set(m.eventId, m);
  for (const m of second) map.set(m.eventId, m);
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * After fetching the latest window from the server, drop any in-memory rows in that time window
 * that the server no longer returned (e.g. redacted / deleted messages).
 */
function mergeLatestServerWindow(prev: Message[], fetched: Message[]): Message[] {
  if (fetched.length === 0) return prev;
  const oldestFetchedTs = fetched[0].timestamp;
  const olderOnly = prev.filter((m) => m.timestamp < oldestFetchedTs);
  return mergeMessagesByEventId(olderOnly, fetched);
}

/** Max messages kept in memory per room. Older messages are trimmed on insert. */
const MAX_MESSAGES_PER_ROOM = 300;
/** Max rooms held in the global cache. Least-recently-accessed rooms are evicted first. */
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

/** Store messages for a room, trimming to MAX_MESSAGES_PER_ROOM. */
function setCachedRoom(roomId: string, messages: Message[], prevBatch: string | null) {
  const trimmed =
    messages.length > MAX_MESSAGES_PER_ROOM
      ? messages.slice(messages.length - MAX_MESSAGES_PER_ROOM)
      : messages;
  globalCache.set(roomId, { messages: trimmed, prevBatch });
  evictRoomsIfNeeded();
}

export function clearMessageCache() {
  globalCache.clear();
}

export function useMessages(roomId: string | null) {
  const cached = roomId ? globalCache.get(roomId) : undefined;
  const [messages, setMessages] = useState<Message[]>(cached?.messages ?? []);
  const [prevBatch, setPrevBatch] = useState<string | null>(cached?.prevBatch ?? null);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const cacheRef = useRef(globalCache);

  // Before paint: never show another room's timeline (or empty while we have no cache).
  useLayoutEffect(() => {
    if (!roomId) {
      setMessages([]);
      setPrevBatch(null);
      setInitialLoading(false);
      setRefreshing(false);
      return;
    }

    const cached = cacheRef.current.get(roomId);
    if (cached) {
      touchRoom(roomId);
      setMessages(cached.messages);
      setPrevBatch(cached.prevBatch);
      setInitialLoading(false);
    } else {
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

    invoke<MessageBatch>("get_messages", { roomId, from: null, limit: 50 })
      .then((batch) => {
        if (cancelled) return;
        const fetched = batch.messages.reverse();
        const prev = cacheRef.current.get(roomId)?.messages ?? [];
        const merged = mergeLatestServerWindow(prev, fetched);

        setMessages(merged);
        setPrevBatch(batch.prevBatch);
        setCachedRoom(roomId, merged, batch.prevBatch);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load messages:", e);
        setMessages([]);
        setPrevBatch(null);
      })
      .finally(() => {
        if (cancelled) return;
        setInitialLoading(false);
        setRefreshing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // Listen for live message events from the sync loop (new, edit, redact)
  useEffect(() => {
    if (!roomId) return;

    const unlistenMsg = listen<RoomMessagePayload>("room-message", (event) => {
      const { roomId: msgRoomId, message } = event.payload;
      if (msgRoomId !== roomId) return;

      setMessages((prev) => {
        const next = mergeMessagesByEventId(prev, [message]);
        setCachedRoom(roomId, next, cacheRef.current.get(roomId)?.prevBatch ?? null);
        return next;
      });
    });

    const unlistenEdit = listen<MessageEditPayload>("room-message-edit", (event) => {
      const { roomId: rid, targetEventId, body, imageMediaRequest, videoMediaRequest } =
        event.payload;
      if (rid !== roomId) return;

      setMessages((prev) => {
        const next = prev.map((m) => {
          if (m.eventId !== targetEventId) return m;
          const { imageMediaRequest: _oi, videoMediaRequest: _ov, ...rest } = m;
          if (imageMediaRequest != null) {
            return { ...rest, body, edited: true, imageMediaRequest };
          }
          if (videoMediaRequest != null) {
            return { ...rest, body, edited: true, videoMediaRequest };
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
    if (!roomId || !prevBatch || loading) return;

    setLoading(true);
    try {
      const batch = await invoke<MessageBatch>("get_messages", {
        roomId,
        from: prevBatch,
        limit: 50,
      });
      const older = batch.messages.reverse();
      setMessages((prev) => {
        const merged = mergeMessagesByEventId(older, prev);
        setCachedRoom(roomId, merged, batch.prevBatch);
        return merged;
      });
      setPrevBatch(batch.prevBatch);
    } catch (e) {
      console.error("Failed to load more messages:", e);
    }
    setLoading(false);
  }, [roomId, prevBatch, loading]);

  // Re-fetch latest messages (after sending)
  const refresh = useCallback(async () => {
    if (!roomId) return;

    try {
      const batch = await invoke<MessageBatch>("get_messages", {
        roomId,
        from: null,
        limit: 50,
      });
      const fetched = batch.messages.reverse();
      const prev = cacheRef.current.get(roomId)?.messages ?? [];
      const merged = mergeLatestServerWindow(prev, fetched);

      setMessages(merged);
      setPrevBatch(batch.prevBatch);
      setCachedRoom(roomId, merged, batch.prevBatch);
    } catch (e) {
      console.error("Failed to refresh messages:", e);
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