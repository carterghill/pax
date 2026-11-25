import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useUserAvatarStoreOptional } from "../context/UserAvatarStore";
import { useIgnoredUsers } from "../context/IgnoredUsersContext";
import { projectMessages } from "../features/chat/messages/ignoredUsers";
import { isTimelineNotice } from "../features/chat/messages/messageListUtils";
import { projectCallHistory, trimTimelineWindow } from "../features/chat/messages/callHistory";
import { Message, MessageBatch } from "../types/matrix";

/* ------------------------------------------------------------------ */
/*  Payload types for sync events                                      */
/* ------------------------------------------------------------------ */

export interface RoomMessagePayload {
  roomId: string;
  message: Message;
}

interface LatestTimelineFetch {
  roomId: string;
  updates: Map<string, Message | null>;
  latestEventId: string | null;
}

export interface MessageEditPayload {
  roomId: string;
  targetEventId: string;
  sender: string;
  body: string;
  formattedBody: string | null;
  mentionedUserIds: string[] | null;
  mentionsRoom: boolean;
  imageMediaRequest: unknown | null;
  videoMediaRequest: unknown | null;
  fileMediaRequest: unknown | null;
  fileMime: unknown | null;
  fileDisplayName: unknown | null;
  imageWidth: unknown | null;
  imageHeight: unknown | null;
  imageBlurhash: unknown | null;
  videoWidth: unknown | null;
  videoHeight: unknown | null;
  unsupportedMatrixMsgtype: unknown | null;
}

export interface MessageRedactedPayload {
  roomId: string;
  redactedEventId: string;
}

export interface RoomMessageReactionPayload {
  roomId: string;
  targetEventId: string;
  key: string;
  sender: string;
  added: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Maximum visible rows in the active room; call signals share one row. */
const WINDOW_SIZE = 100;

/** Messages fetched per backward-pagination request. */
const PAGE_SIZE = 50;

/** Messages fetched for the initial load and jumpToRecent. */
const INITIAL_LOAD_SIZE = 50;

/** LRU cap for recent-window message snapshots (text + metadata only; no image bytes). */
const MAX_ROOMS_MESSAGE_CACHE = 10;

interface RoomMessagesCacheEntry {
  messages: Message[];
  olderToken: string | null;
  isAtLatest: boolean;
}

const roomMessagesCache = new Map<string, RoomMessagesCacheEntry>();

function cloneMessagesForCache(msgs: Message[]): Message[] {
  return msgs.map((m) => ({
    ...m,
    reactions: m.reactions?.map((r) => ({ ...r })),
  }));
}

function touchRoomMessagesCache(roomId: string) {
  const entry = roomMessagesCache.get(roomId);
  if (!entry) return;
  roomMessagesCache.delete(roomId);
  roomMessagesCache.set(roomId, entry);
}

function getRoomMessagesSnapshot(roomId: string): RoomMessagesCacheEntry | undefined {
  const entry = roomMessagesCache.get(roomId);
  if (!entry) return undefined;
  touchRoomMessagesCache(roomId);
  return {
    messages: cloneMessagesForCache(entry.messages),
    olderToken: entry.olderToken,
    isAtLatest: entry.isAtLatest,
  };
}

function putRoomMessagesSnapshot(roomId: string, entry: RoomMessagesCacheEntry) {
  const stored: RoomMessagesCacheEntry = {
    messages: cloneMessagesForCache(entry.messages),
    olderToken: entry.olderToken,
    isAtLatest: entry.isAtLatest,
  };
  if (roomMessagesCache.has(roomId)) roomMessagesCache.delete(roomId);
  roomMessagesCache.set(roomId, stored);
  while (roomMessagesCache.size > MAX_ROOMS_MESSAGE_CACHE) {
    const oldest = roomMessagesCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    roomMessagesCache.delete(oldest);
  }
}

/**
 * Persist only when the in-memory list matches a single tail fetch:
 * at-latest, no backward pagination in this visit, and count ≤ initial load
 * (so `olderToken` still matches this window).
 */
function trySaveRoomMessagesCache(
  roomId: string,
  snapshot: {
    messages: Message[];
    olderToken: string | null;
    isAtLatest: boolean;
    hasLoadedOlder: boolean;
  },
) {
  if (!snapshot.isAtLatest || snapshot.hasLoadedOlder) return;
  const trimmed = snapshot.messages.filter((m) => !m.eventId.startsWith("local:"));
  if (trimmed.length === 0) return;
  if (projectCallHistory(trimmed).messages.length > INITIAL_LOAD_SIZE) return;
  putRoomMessagesSnapshot(roomId, {
    messages: trimmed,
    olderToken: snapshot.olderToken,
    isAtLatest: true,
  });
}

/* ------------------------------------------------------------------ */
/*  Pure helpers                                                       */
/* ------------------------------------------------------------------ */

// History and sync deliver fresh JSON objects even for an unchanged Matrix event.
function reuseMessage(previous: Message | undefined, incoming: Message): Message {
  return previous && JSON.stringify(previous) === JSON.stringify(incoming) ? previous : incoming;
}

function mergeTimelineUpdates(current: Message[], updates: Message[]): Message[] {
  const byId = new Map(current.map((message) => [message.eventId, message]));
  let changed = false;
  for (const message of updates) {
    const previous = byId.get(message.eventId);
    if (!message.decryptionFailed || !previous || previous.decryptionFailed) {
      const next = reuseMessage(previous, message);
      if (next !== previous) {
        byId.set(message.eventId, next);
        changed = true;
      }
    }
  }
  return changed
    ? trimTimelineWindow([...byId.values()].sort((a, b) => a.timestamp - b.timestamp), WINDOW_SIZE, "latest")
    : current;
}

function revokeLocalPreviewIfNeeded(m: Message) {
  const u = m.localImagePreviewObjectUrl;
  if (u && u.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* ok */
    }
  }
}

function removeMatchingLocalEchoes(
  prev: Message[],
  incoming: Message,
  currentUserId: string | null | undefined,
): Message[] {
  if (!currentUserId || incoming.sender !== currentUserId) return prev;

  const toRemove = prev.filter((m) => {
    if (!m.eventId.startsWith("local:")) return false;
    if (m.sender !== incoming.sender) return false;
    if (m.threadRootId !== incoming.threadRootId) return false;
    if (m.body !== incoming.body) return false;
    if (incoming.fileMediaRequest) {
      return m.fileDisplayName === incoming.fileDisplayName;
    }
    if (incoming.imageMediaRequest) {
      return Boolean(m.localImagePreviewObjectUrl);
    }
    if (incoming.videoMediaRequest) {
      return (
        m.fileDisplayName === incoming.fileDisplayName &&
        m.fileMime === incoming.fileMime
      );
    }
    return false;
  });

  if (toRemove.length === 0) return prev;
  toRemove.forEach(revokeLocalPreviewIfNeeded);
  const drop = new Set(toRemove.map((m) => m.eventId));
  return prev.filter((m) => !drop.has(m.eventId));
}

/** Match server vs UI keys (Matrix allows variation-selector differences on emoji). */
function reactionKeysEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const strip = (s: string) => s.replace(/[\uFE0E\uFE0F]/g, "");
  return strip(a) === strip(b);
}

/** Normalized key for optimistic/sync echo token matching. */
function reactionKeyForToken(k: string): string {
  return k.replace(/[\uFE0E\uFE0F]/g, "");
}

function userIdLower(s: string): string {
  return s.trim().toLowerCase();
}

function addToReactedBy(existing: string[] | undefined, sender: string): string[] {
  const m = new Map<string, string>();
  for (const id of existing ?? []) {
    m.set(userIdLower(id), id);
  }
  m.set(userIdLower(sender), sender);
  return [...m.values()].sort((a, b) => userIdLower(a).localeCompare(userIdLower(b)));
}

function removeFromReactedBy(
  existing: string[] | undefined,
  sender: string,
): string[] | undefined {
  if (!existing?.length) return existing;
  const sl = userIdLower(sender);
  const next = existing.filter((id) => userIdLower(id) !== sl);
  return next.length === 0 ? undefined : next;
}

export function applyReactionDelta(
  arr: Message[],
  payload: RoomMessageReactionPayload,
  currentUserId: string | null,
  optimisticEchoTokens: { current: Set<string> } | null,
): Message[] {
  const me = currentUserId?.trim().toLowerCase() ?? null;
  const fromMe =
    me != null && payload.sender.trim().toLowerCase() === me;
  return arr.map((m) => {
    if (m.eventId !== payload.targetEventId || isTimelineNotice(m)) return m;
    const list = m.reactions ? [...m.reactions] : [];
    const i = list.findIndex((r) => reactionKeysEqual(r.key, payload.key));

    // Skip the sync echo of a change we already applied in the UI after invoke.
    if (fromMe && optimisticEchoTokens) {
      const t =
        (payload.added ? "add" : "rem") +
        `|${m.eventId}|${reactionKeyForToken(payload.key)}`;
      if (optimisticEchoTokens.current.has(t)) {
        optimisticEchoTokens.current.delete(t);
        return m;
      }
    }

    if (payload.added) {
      if (i === -1) {
        list.push({
          key: payload.key,
          count: 1,
          reactedByMe: fromMe,
          reactedBy: [payload.sender],
        });
      } else {
        const r = { ...list[i] };
        r.count += 1;
        if (fromMe) r.reactedByMe = true;
        if (r.reactedBy != null) {
          r.reactedBy = addToReactedBy(r.reactedBy, payload.sender);
        }
        list[i] = r;
      }
    } else if (i !== -1) {
      const r = { ...list[i] };
      r.count = Math.max(0, r.count - 1);
      if (fromMe) r.reactedByMe = false;
      if (r.reactedBy != null) {
        r.reactedBy = removeFromReactedBy(r.reactedBy, payload.sender);
      }
      if (r.count === 0) {
        list.splice(i, 1);
      } else {
        list[i] = r;
      }
    }
    return { ...m, reactions: list.length > 0 ? list : undefined };
  });
}

function editPayloadDimension(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function editPayloadUnsupportedMatrixMsgtype(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

export function applyMessageEdit(arr: Message[], payload: MessageEditPayload): Message[] {
  const idx = arr.findIndex((m) => m.eventId === payload.targetEventId);
  if (idx === -1) return arr;

  const current = arr[idx];
  if (isTimelineNotice(current) || current.sender !== payload.sender) return arr;
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
    imageWidth: _oiw,
    imageHeight: _oih,
    imageBlurhash: _oibh,
    videoWidth: _ovw,
    videoHeight: _ovh,
    unsupportedMatrixMsgtype: _ou,
    ...otherFields
  } = current;
  const rest = {
    ...otherFields,
    formattedBody: payload.formattedBody ?? undefined,
    mentionedUserIds: payload.mentionedUserIds ?? undefined,
    mentionsRoom: payload.mentionsRoom,
  };

  const unsupportedMatrixMsgtype =
    payload.unsupportedMatrixMsgtype !== undefined
      ? editPayloadUnsupportedMatrixMsgtype(payload.unsupportedMatrixMsgtype)
      : current.unsupportedMatrixMsgtype ?? null;

  let nextMessage: Message;
  if (imageMediaRequest != null) {
    nextMessage = {
      ...rest,
      body,
      edited: true,
      unsupportedMatrixMsgtype,
      imageMediaRequest,
      imageWidth: editPayloadDimension(payload.imageWidth),
      imageHeight: editPayloadDimension(payload.imageHeight),
      imageBlurhash:
        typeof payload.imageBlurhash === "string"
          ? payload.imageBlurhash
          : undefined,
    };
  } else if (videoMediaRequest != null) {
    nextMessage = {
      ...rest,
      body,
      edited: true,
      unsupportedMatrixMsgtype,
      videoMediaRequest,
      videoWidth: editPayloadDimension(payload.videoWidth),
      videoHeight: editPayloadDimension(payload.videoHeight),
    };
  } else if (fileMediaRequest != null) {
    nextMessage = {
      ...rest,
      body,
      edited: true,
      unsupportedMatrixMsgtype,
      fileMediaRequest,
      fileMime: typeof fileMime === "string" ? fileMime : null,
      fileDisplayName: typeof fileDisplayName === "string" ? fileDisplayName : null,
    };
  } else {
    nextMessage = { ...rest, body, edited: true, unsupportedMatrixMsgtype };
  }

  nextMessage = { ...nextMessage, reactions: current.reactions };

  const next = arr.slice();
  next[idx] = nextMessage;
  return next;
}

/* ------------------------------------------------------------------ */
/*  Backward-compat export (App.tsx calls on logout)                   */
/* ------------------------------------------------------------------ */

/** Clears the recent-room message LRU (call on logout). */
export function clearMessageCache() {
  roomMessagesCache.clear();
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function useMessages(roomId: string | null, currentUserId: string | null = null) {
  const { userIds: ignoredUsers, revision: ignoreListRevision } = useIgnoredUsers();
  const previousIgnoredUsers = useRef(ignoredUsers);
  // Feed the global user-avatar store from every message batch we fetch so
  // sidebars/members/headers can resolve sender avatars without a separate
  // round-trip. Clearing is delegated to the store's own event listeners
  // (account changes and avatar-specific invalidation).
  const userAvatarStore = useUserAvatarStoreOptional();
  const primeAvatarsFromMessages = useCallback(
    (msgs: Message[]) => {
      if (!userAvatarStore || msgs.length === 0) return;
      userAvatarStore.primeMany(
        msgs.filter((m) => !isTimelineNotice(m))
          .map((m) => ({ userId: m.sender, avatarUrl: m.avatarUrl })),
      );
    },
    [userAvatarStore],
  );
  const primeAvatarsFromMessagesRef = useRef(primeAvatarsFromMessages);
  primeAvatarsFromMessagesRef.current = primeAvatarsFromMessages;

  /* ---- State ---- */
  const [messages, setMessages] = useState<Message[]>([]);
  const [olderToken, setOlderToken] = useState<string | null>(null);
  const [isAtLatest, setIsAtLatest] = useState(true);
  const [latestCursor, setLatestCursor] = useState<{ roomId: string | null; eventId: string | null }>({ roomId: null, eventId: null });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [initialLoading, setInitialLoading] = useState(false);
  const [pendingRecentCount, setPendingRecentCount] = useState(0);

  /* ---- Refs (sync reads across callbacks) ---- */
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;
  const olderTokenRef = useRef<string | null>(olderToken);
  olderTokenRef.current = olderToken;
  const isAtLatestRef = useRef(isAtLatest);
  isAtLatestRef.current = isAtLatest;
  const activeRoomIdRef = useRef(roomId);
  activeRoomIdRef.current = roomId;
  const loadingLockRef = useRef(false);
  const initialFetchingRef = useRef(false);
  const latestFetchRef = useRef<LatestTimelineFetch | null>(null);
  /** True after `loadOlder` / `loadMessagesAroundEvent` — tail-only cache would have wrong pagination. */
  const hasLoadedOlderRef = useRef(false);
  const prevRoomIdRef = useRef<string | null>(null);
  /** Dedupes `room-message-reaction` sync when we already updated from a successful chip invoke. */
  const reactionOptimisticEchoRef = useRef<Set<string>>(new Set());

  /* ---- Commit helper ---- */

  const commit = useCallback(
    (next: Message[], token: string | null, atLatest: boolean) => {
      messagesRef.current = next;
      olderTokenRef.current = token;
      isAtLatestRef.current = atLatest;
      setMessages(next);
      setOlderToken(token);
      setIsAtLatest(atLatest);
    },
    [],
  );

  const fetchLatest = useCallback(async (target: string) => {
    const fetch: LatestTimelineFetch = { roomId: target, updates: new Map(), latestEventId: null };
    latestFetchRef.current = fetch;
    try {
      const batch = await invoke<MessageBatch>("get_messages", {
        roomId: target,
        from: null,
        limit: INITIAL_LOAD_SIZE,
      });
      if (latestFetchRef.current !== fetch || activeRoomIdRef.current !== target) return null;

      const recent = batch.messages.slice().reverse();
      const byId = new Map(recent.map((message) => [message.eventId, message]));
      for (const message of messagesRef.current) {
        if (!message.decryptionFailed && byId.get(message.eventId)?.decryptionFailed) {
          byId.set(message.eventId, message);
        }
      }
      // Keep sync updates that arrived while the history request was in flight.
      const latestEventId = fetch.latestEventId && !byId.has(fetch.latestEventId)
        ? fetch.latestEventId
        : batch.latestEventId ?? null;
      for (const [id, message] of fetch.updates) {
        if (message === null) {
          byId.delete(id);
        } else if (!byId.has(id) || (byId.get(id)?.decryptionFailed && !message.decryptionFailed)) {
          byId.set(id, message);
        }
      }
      return {
        messages: trimTimelineWindow([...byId.values()].sort((a, b) => a.timestamp - b.timestamp), WINDOW_SIZE, "latest"),
        prevBatch: batch.prevBatch,
        latestEventId,
      };
    } finally {
      if (latestFetchRef.current === fetch) latestFetchRef.current = null;
    }
  }, []);

  /* ================================================================ */
  /*  Room switch: synchronous blank before paint                      */
  /* ================================================================ */

  useLayoutEffect(() => {
    const switchingFrom = prevRoomIdRef.current;
    if (switchingFrom != null && switchingFrom !== roomId) {
      trySaveRoomMessagesCache(switchingFrom, {
        messages: messagesRef.current,
        olderToken: olderTokenRef.current,
        isAtLatest: isAtLatestRef.current,
        hasLoadedOlder: hasLoadedOlderRef.current,
      });
    }
    prevRoomIdRef.current = roomId;
    setLatestCursor({ roomId, eventId: null });

    loadingLockRef.current = false;
    initialFetchingRef.current = false;
    latestFetchRef.current = null;
    setLoadingOlder(false);
    setPendingRecentCount(0);

    if (!roomId) {
      for (const m of messagesRef.current) revokeLocalPreviewIfNeeded(m);
      commit([], null, true);
      setInitialLoading(false);
      hasLoadedOlderRef.current = false;
      return;
    }

    for (const m of messagesRef.current) revokeLocalPreviewIfNeeded(m);

    hasLoadedOlderRef.current = false;

    const cached = getRoomMessagesSnapshot(roomId);
    if (cached) {
      commit(cached.messages, cached.olderToken, cached.isAtLatest);
      primeAvatarsFromMessagesRef.current(cached.messages);
      // Keep the snapshot as a fallback if the fetch fails, and wait before showing its placeholders.
      setInitialLoading(cached.messages.some((message) => message.decryptionFailed));
    } else {
      commit([], null, true);
      setInitialLoading(true);
    }
  }, [roomId, commit]);

  /* ================================================================ */
  /*  Room switch: async initial fetch                                 */
  /* ================================================================ */

  useEffect(() => {
    if (!roomId) return;

    let cancelled = false;
    const target = roomId;
    initialFetchingRef.current = true;

    // Attachment retention has its own budget and reader leases. Room changes
    // can load messages immediately without clearing or scanning media files.
    void (async () => {
      try {
        const batch = await fetchLatest(target);
        if (!batch || cancelled || activeRoomIdRef.current !== target) return;
        const msgs = batch.messages;
        setLatestCursor({ roomId: target, eventId: batch.latestEventId });
        commit(msgs, batch.prevBatch, true);
        primeAvatarsFromMessagesRef.current(msgs);
        putRoomMessagesSnapshot(target, {
          messages: msgs,
          olderToken: batch.prevBatch,
          isAtLatest: true,
        });
        setPendingRecentCount(0);
      } catch (e) {
        if (cancelled || activeRoomIdRef.current !== target) return;
        console.error("[useMessages] initial fetch error:", e);
      } finally {
        if (!cancelled && activeRoomIdRef.current === target) {
          initialFetchingRef.current = false;
          setInitialLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      initialFetchingRef.current = false;
    };
  }, [roomId, commit, fetchLatest]);

  /* ================================================================ */
  /*  Sync event listeners                                             */
  /* ================================================================ */

  useEffect(() => {
    if (!roomId) return;

    const onTimelineEntry = ({ roomId: rid, message }: RoomMessagePayload) => {
      if (rid !== roomId || activeRoomIdRef.current !== roomId) return;
      const existing = messagesRef.current.find((m) => m.eventId === message.eventId);
      if (existing && !existing.decryptionFailed && message.decryptionFailed) return;
      const alreadyVisible = existing !== undefined;
      const isNotice = isTimelineNotice(message);
      const fetch = latestFetchRef.current;
      if (fetch?.roomId === roomId) {
        fetch.updates.set(message.eventId, message);
        if (!alreadyVisible) fetch.latestEventId = message.eventId;
      }
      if (!alreadyVisible) {
        setLatestCursor({ roomId, eventId: message.eventId });
      }

      if (!isAtLatestRef.current) {
        if (!alreadyVisible && !isNotice) setPendingRecentCount((c) => c + 1);
        return;
      }

      let prev = messagesRef.current;
      if (!isNotice) prev = removeMatchingLocalEchoes(prev, message, currentUserId);

      const idx = prev.findIndex((m) => m.eventId === message.eventId);

      let next: Message[];
      if (idx !== -1) {
        const old = prev[idx];
        const replacement = reuseMessage(old, {
          ...message,
          senderName: isNotice ? message.senderName ?? old.senderName : message.senderName,
          reactions: message.reactions ?? old.reactions,
        });
        if (replacement === old && prev === messagesRef.current) return;
        next = prev;
        if (replacement !== old) {
          revokeLocalPreviewIfNeeded(old);
          next = prev.slice();
          next[idx] = replacement;
        }
      } else {
        next = [...prev, message];
        if (
          next.length >= 2 &&
          next[next.length - 2].timestamp > message.timestamp
        ) {
          next.sort((a, b) => a.timestamp - b.timestamp);
        }
        next = trimTimelineWindow(next, WINDOW_SIZE, "latest");
      }
      primeAvatarsFromMessagesRef.current([message]);
      messagesRef.current = next;
      setMessages(next);
    };
    const unMsg = listen<RoomMessagePayload>("room-message", ({ payload }) => onTimelineEntry(payload));
    const unNotice = listen<RoomMessagePayload>("room-timeline-notice", ({ payload }) => onTimelineEntry(payload));

    const unEdit = listen<MessageEditPayload>("room-message-edit", (event) => {
      if (event.payload.roomId !== roomId) return;
      const next = applyMessageEdit(messagesRef.current, event.payload);
      if (next !== messagesRef.current) {
        messagesRef.current = next;
        setMessages(next);
      }
    });

    const unRedact = listen<MessageRedactedPayload>(
      "room-message-redacted",
      (event) => {
        if (event.payload.roomId !== roomId) return;
        const eid = event.payload.redactedEventId;
        const fetch = latestFetchRef.current;
        if (fetch?.roomId === roomId) fetch.updates.set(eid, null);
        const next = messagesRef.current.filter((m) => m.eventId !== eid);
        if (next.length !== messagesRef.current.length) {
          messagesRef.current = next;
          setMessages(next);
        }
      },
    );

    const unReact = listen<RoomMessageReactionPayload>(
      "room-message-reaction",
      (event) => {
        if (event.payload.roomId !== roomId) return;
        const next = applyReactionDelta(
          messagesRef.current,
          event.payload,
          currentUserId,
          reactionOptimisticEchoRef,
        );
        messagesRef.current = next;
        setMessages(next);
      },
    );

    return () => {
      unMsg.then((fn) => fn());
      unNotice.then((fn) => fn());
      unEdit.then((fn) => fn());
      unRedact.then((fn) => fn());
      unReact.then((fn) => fn());
    };
  }, [roomId, currentUserId]);

  /* ================================================================ */
  /*  loadOlder                                                        */
  /* ================================================================ */

  const loadOlder = useCallback(async () => {
    if (
      !roomId ||
      loadingLockRef.current ||
      initialFetchingRef.current ||
      olderTokenRef.current === null
    ) {
      return;
    }

    const target = roomId;
    const fromToken = olderTokenRef.current;
    loadingLockRef.current = true;
    setLoadingOlder(true);

    try {
      const batch = await invoke<MessageBatch>("get_messages", {
        roomId: target,
        from: fromToken,
        limit: PAGE_SIZE,
      });
      if (activeRoomIdRef.current !== target) return;

      hasLoadedOlderRef.current = true;

      const older = batch.messages.slice().reverse();
      if (older.length === 0) {
        olderTokenRef.current = batch.prevBatch;
        setOlderToken(batch.prevBatch);
        return;
      }

      const existingIds = new Set(messagesRef.current.map((m) => m.eventId));
      const genuinelyNew = older.filter((m) => !existingIds.has(m.eventId));
      if (genuinelyNew.length === 0) {
        olderTokenRef.current = batch.prevBatch;
        setOlderToken(batch.prevBatch);
        return;
      }

      let combined = [...genuinelyNew, ...messagesRef.current];
      combined.sort((a, b) => a.timestamp - b.timestamp);

      let nextAtLatest = isAtLatestRef.current;
      const window = trimTimelineWindow(combined, WINDOW_SIZE, "oldest");
      if (window.length < combined.length) {
        combined = window;
        nextAtLatest = false;
      }

      commit(combined, batch.prevBatch, nextAtLatest);
      primeAvatarsFromMessagesRef.current(combined);
    } catch (e) {
      console.error("[useMessages] loadOlder error:", e);
    } finally {
      if (activeRoomIdRef.current === target) {
        setLoadingOlder(false);
      }
      loadingLockRef.current = false;
    }
  }, [roomId, commit]);

  /* ================================================================ */
  /*  jumpToRecent                                                     */
  /* ================================================================ */

  const jumpToRecent = useCallback(async () => {
    if (!roomId) return;
    const target = roomId;
    loadingLockRef.current = true;

    try {
      const batch = await fetchLatest(target);
      if (!batch || activeRoomIdRef.current !== target) return;

      const msgs = batch.messages;
      setLatestCursor({ roomId: target, eventId: batch.latestEventId });
      commit(msgs, batch.prevBatch, true);
      primeAvatarsFromMessagesRef.current(msgs);
      hasLoadedOlderRef.current = false;
      putRoomMessagesSnapshot(target, {
        messages: msgs,
        olderToken: batch.prevBatch,
        isAtLatest: true,
      });
      setPendingRecentCount(0);
    } catch (e) {
      console.error("[useMessages] jumpToRecent error:", e);
    } finally {
      loadingLockRef.current = false;
    }
  }, [roomId, commit, fetchLatest]);

  /* ================================================================ */
  /*  loadNewer — reload latest window when scrolled back              */
  /* ================================================================ */

  const loadNewer = useCallback(async () => {
    if (!roomId || isAtLatestRef.current || loadingLockRef.current) return;
    await jumpToRecent();
  }, [roomId, jumpToRecent]);

  /* ================================================================ */
  /*  refresh (after sending a message)                                */
  /* ================================================================ */

  const refresh = useCallback(async () => {
    if (!roomId) return;
    const target = roomId;

    try {
      const batch = await invoke<MessageBatch>("get_messages", {
        roomId: target,
        from: null,
        limit: PAGE_SIZE,
      });
      if (activeRoomIdRef.current !== target) return;
      if (!isAtLatestRef.current) return;

      setLatestCursor({ roomId: target, eventId: batch.latestEventId ?? null });
      const combined = mergeTimelineUpdates(messagesRef.current, batch.messages.slice().reverse());

      commit(combined, batch.prevBatch, true);
      primeAvatarsFromMessagesRef.current(combined);
    } catch (e) {
      console.error("[useMessages] refresh error:", e);
    }
  }, [roomId, commit]);

  useEffect(() => {
    const previous = previousIgnoredUsers.current;
    previousIgnoredUsers.current = ignoredUsers;
    const unignored = [...previous].some((id) => !ignoredUsers.has(id));
    if (unignored) roomMessagesCache.clear();
    if ((unignored || ignoredUsers.size > previous.size) && isAtLatestRef.current) void refresh();
  }, [ignoredUsers, refresh]);

  // Restoring keys must also retry the timeline: undecryptable events may have
  // been omitted from an earlier fetch and cached as an empty room.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const unlisten = listen<string[] | null>("encryption-keys-received", (event) => {
      const rooms = event.payload;
      if (rooms) for (const id of rooms) roomMessagesCache.delete(id);
      else roomMessagesCache.clear();
      if (!roomId || (rooms && !rooms.includes(roomId))) return;
      clearTimeout(timer);
      const retry = async () => {
        if (cancelled || activeRoomIdRef.current !== roomId) return;
        if (initialFetchingRef.current || loadingLockRef.current) {
          timer = setTimeout(() => void retry(), 500);
          return;
        }
        const atLatest = isAtLatestRef.current;
        const snapshot = messagesRef.current;
        const anchor = [...snapshot].reverse().find((message) => !message.eventId.startsWith("local:"));
        try {
          const batch = await invoke<MessageBatch>(atLatest || !anchor ? "get_messages" : "get_messages_around_event",
            atLatest || !anchor ? { roomId, from: null, limit: INITIAL_LOAD_SIZE } : { roomId, eventId: anchor.eventId });
          if (cancelled || activeRoomIdRef.current !== roomId || isAtLatestRef.current !== atLatest) return;
          if (atLatest) setLatestCursor({ roomId, eventId: batch.latestEventId ?? null });
          const recovered = batch.messages.filter((message) => atLatest || snapshot.length === 0
            || (message.timestamp >= snapshot[0].timestamp && message.timestamp <= snapshot[snapshot.length - 1].timestamp));
          const combined = mergeTimelineUpdates(messagesRef.current, recovered);
          commit(combined, snapshot.length === 0 ? batch.prevBatch : olderTokenRef.current, atLatest);
          primeAvatarsFromMessagesRef.current(recovered);
        } catch (error) {
          console.error("[useMessages] could not refresh restored history:", error);
        }
      };
      timer = setTimeout(() => void retry(), 500);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void unlisten.then((stop) => stop());
    };
  }, [roomId, commit]);

  /* ================================================================ */
  /*  removeMessageById                                                */
  /* ================================================================ */

  const removeMessageById = useCallback((eventId: string) => {
    const prev = messagesRef.current;
    const victim = prev.find((m) => m.eventId === eventId);
    if (victim) revokeLocalPreviewIfNeeded(victim);
    const next = prev.filter((m) => m.eventId !== eventId);
    if (next.length !== prev.length) {
      messagesRef.current = next;
      setMessages(next);
    }
  }, []);

  const addOptimisticMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      let next = [...prev, msg];
      if (next.length >= 2 && next[next.length - 2].timestamp > msg.timestamp) {
        next = next.slice().sort((a, b) => a.timestamp - b.timestamp);
      }
      const window = trimTimelineWindow(next, WINDOW_SIZE, "latest");
      if (window !== next) {
        const retained = new Set(window.map((message) => message.eventId));
        next.filter((message) => !retained.has(message.eventId)).forEach(revokeLocalPreviewIfNeeded);
        next = window;
      }
      messagesRef.current = next;
      return next;
    });
  }, []);

  const patchMessage = useCallback((eventId: string, patch: Partial<Message>) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.eventId === eventId);
      if (idx === -1) return prev;
      const next = prev.slice();
      const old = next[idx];
      if (patch.imageMediaRequest != null && old.localImagePreviewObjectUrl) {
        revokeLocalPreviewIfNeeded(old);
      }
      let merged = patch;
      if (
        patch.localFileUpload &&
        patch.localFileUpload.phase !== "failed"
      ) {
        const prevProg = old.localFileUpload?.progress ?? 0;
        const nextProg = patch.localFileUpload.progress ?? prevProg;
        merged = {
          ...patch,
          localFileUpload: {
            ...patch.localFileUpload,
            progress: Math.max(prevProg, nextProg),
          },
        };
      }
      next[idx] = { ...old, ...merged };
      messagesRef.current = next;
      return next;
    });
  }, []);

  const replaceMessageEventId = useCallback(
    (oldId: string, newId: string, patch?: Partial<Message>) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.eventId === oldId);
        if (idx === -1) return prev;
        let next: Message[];
        if (oldId !== newId && prev.some((message) => message.eventId === newId)) {
          revokeLocalPreviewIfNeeded(prev[idx]);
          next = prev.filter((message) => message.eventId !== oldId);
        } else {
          next = prev.slice();
          next[idx] = { ...next[idx], ...patch, eventId: newId };
        }
        messagesRef.current = next;
        return next;
      });
    },
    [],
  );

  const patchMessageByUploadId = useCallback((uploadId: string, patch: Partial<Message>) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.localPipelineUploadId === uploadId);
      if (idx === -1) return prev;
      const next = prev.slice();
      const old = next[idx];
      if (patch.imageMediaRequest != null && old.localImagePreviewObjectUrl) {
        revokeLocalPreviewIfNeeded(old);
      }
      let merged = patch;
      if (
        patch.localFileUpload &&
        patch.localFileUpload.phase !== "failed"
      ) {
        const prevProg = old.localFileUpload?.progress ?? 0;
        const nextProg = patch.localFileUpload.progress ?? prevProg;
        merged = {
          ...patch,
          localFileUpload: {
            ...patch.localFileUpload,
            progress: Math.max(prevProg, nextProg),
          },
        };
      }
      next[idx] = { ...old, ...merged };
      messagesRef.current = next;
      return next;
    });
  }, []);

  /* ================================================================ */
  /*  Load a window around a specific event (e.g. jump to pinned)      */
  /* ================================================================ */

  /**
   * Apply chip click immediately after `send_room_reaction` / `remove_room_reaction` succeeds.
   * Registers a token so the follow-up sync does not double-apply.
   */
  const applyLocalReactionFromChip = useCallback(
    (targetEventId: string, key: string, wasReactedByMe: boolean) => {
      const me = currentUserId?.trim();
      const token =
        (wasReactedByMe ? "rem" : "add") +
        `|${targetEventId}|${reactionKeyForToken(key)}`;
      reactionOptimisticEchoRef.current.add(token);
      window.setTimeout(() => {
        reactionOptimisticEchoRef.current.delete(token);
      }, 8000);

      setMessages((prev) => {
        const next = prev.map((m) => {
          if (m.eventId !== targetEventId) return m;
          const list = m.reactions ? [...m.reactions] : [];
          const i = list.findIndex((r) => reactionKeysEqual(r.key, key));
          if (wasReactedByMe) {
            if (i === -1) return m; // sync may have already removed
            const r = { ...list[i] };
            if (!r.reactedByMe) return m;
            r.count = Math.max(0, r.count - 1);
            r.reactedByMe = false;
            if (me && r.reactedBy != null) {
              r.reactedBy = removeFromReactedBy(r.reactedBy, me);
            }
            if (r.count === 0) {
              list.splice(i, 1);
            } else {
              list[i] = r;
            }
            return {
              ...m,
              reactions: list.length > 0 ? list : undefined,
            };
          }
          if (!me) {
            if (i === -1) {
              list.push({ key, count: 1, reactedByMe: true });
            } else {
              const r = { ...list[i] };
              if (r.reactedByMe) return m;
              r.count += 1;
              r.reactedByMe = true;
              list[i] = r;
            }
            return { ...m, reactions: list };
          }
          if (i === -1) {
            list.push({ key, count: 1, reactedByMe: true, reactedBy: [me] });
          } else {
            const r = { ...list[i] };
            if (r.reactedByMe) return m;
            r.count += 1;
            r.reactedByMe = true;
            if (r.reactedBy != null) {
              r.reactedBy = addToReactedBy(r.reactedBy, me);
            }
            list[i] = r;
          }
          return { ...m, reactions: list };
        });
        messagesRef.current = next;
        return next;
      });
    },
    [currentUserId],
  );

  const loadMessagesAroundEvent = useCallback(
    async (eventId: string) => {
      if (!roomId) return;
      const target = roomId;
      loadingLockRef.current = true;
      setLoadingOlder(true);
      try {
        const batch = await invoke<MessageBatch>("get_messages_around_event", {
          roomId: target,
          eventId,
        });
        if (activeRoomIdRef.current !== target) return;
        hasLoadedOlderRef.current = true;
        const msgs = batch.messages.slice().reverse();
        commit(msgs, batch.prevBatch, false);
        primeAvatarsFromMessagesRef.current(msgs);
        setPendingRecentCount(0);
      } catch (e) {
        console.error("[useMessages] loadMessagesAroundEvent error:", e);
      } finally {
        if (activeRoomIdRef.current === target) {
          setLoadingOlder(false);
        }
        loadingLockRef.current = false;
      }
    },
    [roomId, commit],
  );

  /* ================================================================ */
  /*  Return                                                           */
  /* ================================================================ */

  const hasOlder = olderToken !== null;
  const showJumpToRecent = !isAtLatest || pendingRecentCount > 0;
  const visibleMessages = useMemo(
    () => projectMessages(messages, ignoredUsers, ignoreListRevision),
    [messages, ignoredUsers, ignoreListRevision],
  );

  return {
    messages: visibleMessages,
    latestEventId: latestCursor.roomId === roomId ? latestCursor.eventId : null,
    loadOlder,
    loadNewer,
    hasOlder,
    isAtLatest,
    loadingOlder,
    initialLoading: initialLoading || latestCursor.roomId !== roomId,
    pendingRecentCount,
    showJumpToRecent,
    jumpToRecent,
    refresh,
    removeMessageById,
    addOptimisticMessage,
    patchMessage,
    replaceMessageEventId,
    patchMessageByUploadId,
    loadMessagesAroundEvent,
    applyLocalReactionFromChip,
  };
}
