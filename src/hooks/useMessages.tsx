import { useEffect, useLayoutEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useUserAvatarStoreOptional } from "../context/UserAvatarStore";
import { Message, MessageBatch } from "../types/matrix";

/* ------------------------------------------------------------------ */
/*  Payload types for sync events                                      */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Absolute maximum messages held in JS memory for the active room. */
const WINDOW_SIZE = 100;

/** Messages fetched per backward-pagination request. */
const PAGE_SIZE = 50;

/** Messages fetched for the initial load and jumpToRecent. */
const INITIAL_LOAD_SIZE = 50;

/* ------------------------------------------------------------------ */
/*  Pure helpers                                                       */
/* ------------------------------------------------------------------ */

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

function applyMessageEdit(arr: Message[], payload: MessageEditPayload): Message[] {
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
      fileDisplayName: typeof fileDisplayName === "string" ? fileDisplayName : null,
    };
  } else {
    nextMessage = { ...rest, body, edited: true };
  }

  const next = arr.slice();
  next[idx] = nextMessage;
  return next;
}

/* ------------------------------------------------------------------ */
/*  Backward-compat export (App.tsx calls on logout)                   */
/* ------------------------------------------------------------------ */

/** No-op — the old global cache is gone. */
export function clearMessageCache() {
  /* nothing to do */
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function useMessages(roomId: string | null, currentUserId: string | null = null) {
  // Feed the global user-avatar store from every message batch we fetch so
  // sidebars/members/headers can resolve sender avatars without a separate
  // round-trip. Clearing is delegated to the store's own event listeners
  // (logout / clear_media_cache invalidation).
  const userAvatarStore = useUserAvatarStoreOptional();
  const primeAvatarsFromMessages = useCallback(
    (msgs: Message[]) => {
      if (!userAvatarStore || msgs.length === 0) return;
      userAvatarStore.primeMany(
        msgs.map((m) => ({ userId: m.sender, avatarUrl: m.avatarUrl })),
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

  /* ================================================================ */
  /*  Room switch: synchronous blank before paint                      */
  /* ================================================================ */

  useLayoutEffect(() => {
    loadingLockRef.current = false;
    initialFetchingRef.current = false;
    setLoadingOlder(false);
    setPendingRecentCount(0);

    if (!roomId) {
      for (const m of messagesRef.current) revokeLocalPreviewIfNeeded(m);
      commit([], null, true);
      setInitialLoading(false);
      return;
    }

    for (const m of messagesRef.current) revokeLocalPreviewIfNeeded(m);
    commit([], null, true);
    setInitialLoading(true);
  }, [roomId, commit]);

  /* ================================================================ */
  /*  Room switch: async initial fetch                                 */
  /* ================================================================ */

  useEffect(() => {
    if (!roomId) return;

    let cancelled = false;
    const target = roomId;
    initialFetchingRef.current = true;

    // Drops attachment temp files from the previous room before we
    // fetch new ones. Avatars are intentionally preserved across room
    // switches (see `clear_media_cache` in the backend); they're shared
    // with every other view and wiping them caused widespread 404 flashes.
    void (async () => {
      try {
        await invoke("clear_media_cache");
      } catch {
        /* non-fatal */
      }
      if (cancelled || activeRoomIdRef.current !== target) return;

      try {
        const batch = await invoke<MessageBatch>("get_messages", {
          roomId: target,
          from: null,
          limit: INITIAL_LOAD_SIZE,
        });
        if (cancelled || activeRoomIdRef.current !== target) return;
        const msgs = batch.messages.slice().reverse();
        commit(msgs, batch.prevBatch, true);
        primeAvatarsFromMessagesRef.current(msgs);
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
  }, [roomId, commit]);

  /* ================================================================ */
  /*  Sync event listeners                                             */
  /* ================================================================ */

  useEffect(() => {
    if (!roomId) return;

    const unMsg = listen<RoomMessagePayload>("room-message", (event) => {
      const { roomId: rid, message } = event.payload;
      if (rid !== roomId) return;

      if (!isAtLatestRef.current) {
        setPendingRecentCount((c) => c + 1);
        return;
      }

      let prev = messagesRef.current;
      prev = removeMatchingLocalEchoes(prev, message, currentUserId);

      const idx = prev.findIndex((m) => m.eventId === message.eventId);

      let next: Message[];
      if (idx !== -1) {
        next = prev.slice();
        const old = next[idx];
        revokeLocalPreviewIfNeeded(old);
        next[idx] = message;
      } else {
        next = [...prev, message];
        if (
          next.length >= 2 &&
          next[next.length - 2].timestamp > message.timestamp
        ) {
          next.sort((a, b) => a.timestamp - b.timestamp);
        }
        if (next.length > WINDOW_SIZE) {
          next = next.slice(next.length - WINDOW_SIZE);
        }
      }
      primeAvatarsFromMessagesRef.current([message]);
      messagesRef.current = next;
      setMessages(next);
    });

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
        const next = messagesRef.current.filter((m) => m.eventId !== eid);
        if (next.length !== messagesRef.current.length) {
          messagesRef.current = next;
          setMessages(next);
        }
      },
    );

    return () => {
      unMsg.then((fn) => fn());
      unEdit.then((fn) => fn());
      unRedact.then((fn) => fn());
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

      const older = batch.messages.slice().reverse();
      if (older.length === 0) {
        olderTokenRef.current = null;
        setOlderToken(null);
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
      if (combined.length > WINDOW_SIZE) {
        combined = combined.slice(0, WINDOW_SIZE);
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
      const batch = await invoke<MessageBatch>("get_messages", {
        roomId: target,
        from: null,
        limit: INITIAL_LOAD_SIZE,
      });
      if (activeRoomIdRef.current !== target) return;

      const msgs = batch.messages.slice().reverse();
      commit(msgs, batch.prevBatch, true);
      primeAvatarsFromMessagesRef.current(msgs);
      setPendingRecentCount(0);
    } catch (e) {
      console.error("[useMessages] jumpToRecent error:", e);
    } finally {
      loadingLockRef.current = false;
    }
  }, [roomId, commit]);

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

      const fetched = batch.messages.slice().reverse();
      const prev = messagesRef.current;

      const fetchedIds = new Set(fetched.map((m) => m.eventId));
      const kept = prev.filter((m) => !fetchedIds.has(m.eventId));

      let combined = [...kept, ...fetched];
      combined.sort((a, b) => a.timestamp - b.timestamp);

      const seen = new Set<string>();
      combined = combined.filter((m) => {
        if (seen.has(m.eventId)) return false;
        seen.add(m.eventId);
        return true;
      });

      if (combined.length > WINDOW_SIZE) {
        combined = combined.slice(combined.length - WINDOW_SIZE);
      }

      commit(combined, batch.prevBatch, true);
      primeAvatarsFromMessagesRef.current(combined);
    } catch (e) {
      console.error("[useMessages] refresh error:", e);
    }
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
      if (next.length > WINDOW_SIZE) {
        const dropped = next.slice(0, next.length - WINDOW_SIZE);
        dropped.forEach(revokeLocalPreviewIfNeeded);
        next = next.slice(next.length - WINDOW_SIZE);
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
      next[idx] = { ...old, ...patch };
      messagesRef.current = next;
      return next;
    });
  }, []);

  const replaceMessageEventId = useCallback(
    (oldId: string, newId: string, patch?: Partial<Message>) => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.eventId === oldId);
        if (idx === -1) return prev;
        const next = prev.slice();
        next[idx] = { ...next[idx], ...patch, eventId: newId };
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
      next[idx] = { ...old, ...patch };
      messagesRef.current = next;
      return next;
    });
  }, []);

  /* ================================================================ */
  /*  Load a window around a specific event (e.g. jump to pinned)      */
  /* ================================================================ */

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
        const msgs = batch.messages.slice().reverse();
        commit(msgs, batch.prevBatch, false);
        primeAvatarsFromMessages(msgs);
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

  return {
    messages,
    loadOlder,
    loadNewer,
    hasOlder,
    isAtLatest,
    loadingOlder,
    initialLoading,
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
  };
}