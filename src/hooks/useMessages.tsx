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
  imageWidth: unknown | null;
  imageHeight: unknown | null;
  videoWidth: unknown | null;
  videoHeight: unknown | null;
}

interface MessageRedactedPayload {
  roomId: string;
  redactedEventId: string;
}

interface RoomMessageReactionPayload {
  roomId: string;
  targetEventId: string;
  key: string;
  sender: string;
  added: boolean;
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

function applyReactionDelta(
  arr: Message[],
  payload: RoomMessageReactionPayload,
  currentUserId: string | null,
  optimisticEchoTokens: { current: Set<string> } | null,
): Message[] {
  const me = currentUserId?.trim().toLowerCase() ?? null;
  const fromMe =
    me != null && payload.sender.trim().toLowerCase() === me;
  return arr.map((m) => {
    if (m.eventId !== payload.targetEventId) return m;
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
    imageWidth: _oiw,
    imageHeight: _oih,
    videoWidth: _ovw,
    videoHeight: _ovh,
    ...rest
  } = current;

  let nextMessage: Message;
  if (imageMediaRequest != null) {
    nextMessage = {
      ...rest,
      body,
      edited: true,
      imageMediaRequest,
      imageWidth: editPayloadDimension(payload.imageWidth),
      imageHeight: editPayloadDimension(payload.imageHeight),
    };
  } else if (videoMediaRequest != null) {
    nextMessage = {
      ...rest,
      body,
      edited: true,
      videoMediaRequest,
      videoWidth: editPayloadDimension(payload.videoWidth),
      videoHeight: editPayloadDimension(payload.videoHeight),
    };
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

  nextMessage = { ...nextMessage, reactions: current.reactions };

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
        next[idx] = {
          ...message,
          reactions: message.reactions ?? old.reactions,
        };
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
    applyLocalReactionFromChip,
  };
}