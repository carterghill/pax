import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Room } from "../types/matrix";
import { loadPersistedRooms, savePersistedRooms } from "../utils/roomsCache";
import { useUserAvatarStoreOptional, type UserAvatarStore } from "../context/UserAvatarStore";
import { avatarSrc } from "../utils/avatarSrc";

/** Matches the Rust fallback in `get_rooms` when the SDK has no m.room.name yet. */
const GENERIC_UNNAMED = "Unnamed";

/**
 * Upper bound on how long we wait for DM peer avatars to fetch +
 * decode before letting the sidebar render anyway. If federation is
 * slow or the homeserver is down we don't want the user staring at a
 * loading spinner forever — better a brief sidebar flash than a
 * stuck "Loading rooms..." screen.
 */
const AVATAR_PREPAINT_TIMEOUT_MS = 500;

/**
 * Kick off fetch + decode for every DM peer avatar path in the list
 * and resolve when they've all landed (or the timeout expires). The
 * sidebar can render with zero flash once this resolves, because
 * the browser already has the pixels ready for every `<img src>` it's
 * about to mount.
 */
async function waitForDmAvatarsDecoded(
  list: Room[],
  store: UserAvatarStore | null,
): Promise<void> {
  // Collect every DM peer path we're about to render. Prefer the
  // store (it's authoritative — populated from both the rooms list
  // and hydrated from localStorage on warm restart) and fall back
  // to the room's own avatarUrl on cold start when the store might
  // not have the entry yet.
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    if (!r.isDirect || !r.dmPeerUserId) continue;
    const fromStore = store?.lookup(r.dmPeerUserId);
    const url = typeof fromStore === "string" && fromStore
      ? fromStore
      : r.avatarUrl;
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  if (urls.length === 0) return;

  // eslint-disable-next-line no-console
  console.log(`[waitForDmAvatarsDecoded] awaiting ${urls.length} images:`, urls);
  const start = performance.now();

  const decodes = urls.map((u) => {
    const src = avatarSrc(u);
    if (!src) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const img = new Image();
      img.decoding = "sync";
      // `onload` + `decode()` together ensure the pixels are in
      // the image cache AND pre-decoded, so a subsequent
      // `<img src={same}>` mount paints in the same frame. Any
      // error (stale path, asset-protocol 403, etc.) resolves
      // rather than rejects — we don't want one bad avatar to
      // block the whole sidebar.
      const done = () => resolve();
      img.onload = () => {
        if (typeof img.decode === "function") {
          img.decode().then(done, done);
        } else {
          done();
        }
      };
      img.onerror = done;
      img.src = src;
    });
  });

  // Race `Promise.all(decodes)` against a hard timeout so a stuck
  // fetch doesn't pin the loading screen forever.
  await Promise.race([
    Promise.all(decodes),
    new Promise<void>((resolve) => setTimeout(resolve, AVATAR_PREPAINT_TIMEOUT_MS)),
  ]);
  // eslint-disable-next-line no-console
  console.log(
    `[waitForDmAvatarsDecoded] done after ${(performance.now() - start).toFixed(0)}ms`,
  );
}

function isPlaceholderRoomName(name: string): boolean {
  return !name.trim() || name === GENERIC_UNNAMED;
}

/** Keep the last non-placeholder name while sync fills in canonical room state. */
function withStableRoomDisplayName(
  previous: Room | undefined,
  incoming: Room
): Room {
  if (!previous || previous.id !== incoming.id) return incoming;
  if (!isPlaceholderRoomName(incoming.name)) return incoming;
  if (!isPlaceholderRoomName(previous.name)) {
    return { ...incoming, name: previous.name };
  }
  return incoming;
}

function mergeFetchedRoomsPreserveNames(
  previousList: Room[],
  incomingList: Room[]
): Room[] {
  const prevById = new Map(previousList.map((r) => [r.id, r]));
  return incomingList.map((room) =>
    withStableRoomDisplayName(prevById.get(room.id), room)
  );
}

export type RoomsForLayout = {
  spaces: Room[];
  roomsBySpace: (spaceId: string | null) => Room[];
  getRoom: (roomId: string) => Room | null;
  fetchRooms: () => Promise<Room[]>;
  upsertOptimisticRoom: (room: Room) => void;
};

export function useRooms(userId: string | null) {
  const [fetchedRooms, setFetchedRooms] = useState<Room[]>([]);
  const [optimisticRooms, setOptimisticRooms] = useState<Room[]>([]);
  const [initialLoadComplete, setInitialLoadComplete] = useState(() => !userId);
  const fetchingRef = useRef(false);
  /** Latest optimistic rows for merge during fetch (state is async). */
  const optimisticRoomsRef = useRef<Room[]>([]);
  optimisticRoomsRef.current = optimisticRooms;

  // For 1:1 DMs, `get_rooms` returns the peer's avatar on the room row —
  // prime the global store so every <UserAvatar userId={peer}/> instance
  // renders the same resolved path without a separate fetch.
  const userAvatarStore = useUserAvatarStoreOptional();
  const primeDmPeerAvatars = useCallback(
    (list: Room[]) => {
      if (!userAvatarStore) return;
      userAvatarStore.primeMany(
        list
          .filter((r) => r.isDirect && r.dmPeerUserId)
          .map((r) => ({ userId: r.dmPeerUserId as string, avatarUrl: r.avatarUrl })),
      );
    },
    [userAvatarStore],
  );
  const primeDmPeerAvatarsRef = useRef(primeDmPeerAvatars);
  primeDmPeerAvatarsRef.current = primeDmPeerAvatars;

  const mergeRooms = useCallback((serverRooms: Room[], pendingRooms: Room[]) => {
    const pendingById = new Map(pendingRooms.map((r) => [r.id, r]));
    const mergedServer = serverRooms.map((room) =>
      withStableRoomDisplayName(pendingById.get(room.id), room)
    );
    const serverIds = new Set(serverRooms.map((r) => r.id));
    const orphanPending = pendingRooms.filter((r) => !serverIds.has(r.id));
    return [...mergedServer, ...orphanPending];
  }, []);

  const fetchRooms = useCallback(async (): Promise<Room[]> => {
    if (!userId || fetchingRef.current) return [];
    fetchingRef.current = true;

    try {
      const list = await invoke<Room[]>("get_rooms");
      primeDmPeerAvatars(list);
      const optById = new Map(
        optimisticRoomsRef.current.map((r) => [r.id, r])
      );
      const listWithOptNames = list.map((room) =>
        withStableRoomDisplayName(optById.get(room.id), room)
      );

      let mergedFetched: Room[] = [];
      setFetchedRooms((prevFetched) => {
        mergedFetched = mergeFetchedRoomsPreserveNames(prevFetched, listWithOptNames);
        savePersistedRooms(userId, mergedFetched);
        return mergedFetched;
      });

      let nextOptimistic: Room[] = [];
      setOptimisticRooms((prev) => {
        nextOptimistic = prev.filter((p) => !list.some((r) => r.id === p.id));
        return nextOptimistic;
      });

      return mergeRooms(mergedFetched, nextOptimistic);
    } catch (e) {
      console.error("Failed to fetch rooms:", e);
      return [];
    } finally {
      fetchingRef.current = false;
    }
  }, [userId, mergeRooms]);

  const upsertOptimisticRoom = useCallback((room: Room) => {
    setOptimisticRooms((prev) => [room, ...prev.filter((existing) => existing.id !== room.id)]);
  }, []);

  // Hydrate from disk so "Loading rooms…" can skip when we have a
  // prior snapshot for this user. On warm restart, `UserAvatarStore`
  // has already hydrated its entries and kicked off `new Image()`
  // preloads for them during its constructor — so the browser's
  // image cache is already warming up by the time React gets here.
  //
  // We still kick off a short decode wait before clearing
  // `initialLoadComplete` so we don't race the preloads to the
  // first sidebar paint. If the preloads have already finished the
  // decode resolves on the next microtask; if they're still in
  // flight we hold the loading screen briefly rather than flash.
  useLayoutEffect(() => {
    if (!userId) return;
    setOptimisticRooms([]);
    const cached = loadPersistedRooms(userId);
    if (!cached) {
      // Cold start — the async effect below owns the decode wait.
      setInitialLoadComplete(false);
      return;
    }
    setFetchedRooms(cached);
    setInitialLoadComplete(false);
    let cancelled = false;
    // Resolve DM peer avatar paths from the hydrated store (warm
    // restart) or from the cached room rows (the rows were
    // stripped on persist, so this will usually be a no-op, but
    // keep it defensive) and await decode.
    waitForDmAvatarsDecoded(cached, userAvatarStore).then(() => {
      if (!cancelled) setInitialLoadComplete(true);
    });
    return () => {
      cancelled = true;
    };
  }, [userId, userAvatarStore]);

  // Always refresh from the server (parallel + faster on the Rust side; cache is stale-while-revalidate).
  useEffect(() => {
    if (!userId) {
      setFetchedRooms([]);
      setOptimisticRooms([]);
      setInitialLoadComplete(true);
      return;
    }

    let cancelled = false;
    fetchingRef.current = true;

    (async () => {
      try {
        const list = await invoke<Room[]>("get_rooms");
        if (cancelled) return;

        // Prime the avatar store with every DM peer path we just
        // learned about — this is what `<UserAvatar>` looks up on
        // mount, and priming before render means first paint is
        // already store-hit.
        primeDmPeerAvatarsRef.current(list);

        // Wait for the browser to actually fetch + decode every
        // DM avatar the sidebar is about to render. This is the
        // structural fix for the sidebar flash: we'd been flipping
        // `initialLoadComplete` the moment `get_rooms` returned,
        // but that meant React rendered the sidebar with `<img
        // src>` attributes whose bytes hadn't landed yet. The
        // Tauri asset-protocol fetch + PNG decode of a 28px
        // avatar takes a handful of ms, but long enough that the
        // `<img>` paints an empty box on first layout — which on
        // a circular colored container reads visually as the
        // initials fallback even when no initials are actually
        // being rendered. Holding the loading screen for that
        // decode round-trip trades ~100-200ms of "Loading..." for
        // zero flash.
        await waitForDmAvatarsDecoded(list, userAvatarStore);
        if (cancelled) return;

        setFetchedRooms((prev) => {
          const merged = mergeFetchedRoomsPreserveNames(prev, list);
          savePersistedRooms(userId, merged);
          return merged;
        });
      } catch (e) {
        console.error("Failed to fetch rooms:", e);
      } finally {
        fetchingRef.current = false;
        if (!cancelled) setInitialLoadComplete(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, userAvatarStore]);

  // Re-fetch whenever the sync loop signals a change (debounced to coalesce rapid events)
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unlisten = listen("rooms-changed", () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        fetchRooms();
      }, 500);
    });

    return () => {
      unlisten.then((fn) => fn());
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [fetchRooms]);

  const rooms = useMemo(
    () => mergeRooms(fetchedRooms, optimisticRooms),
    [fetchedRooms, optimisticRooms, mergeRooms]
  );

  const spaces = useMemo(() => rooms.filter((r) => r.isSpace), [rooms]);

  const roomsBySpaceMap = useMemo(() => {
    const map = new Map<string, Room[]>();
    const homeRooms: Room[] = [];

    for (const room of rooms) {
      if (room.isSpace) continue;

      if (room.parentSpaceIds.length === 0) {
        homeRooms.push(room);
        continue;
      }

      for (const parentSpaceId of room.parentSpaceIds) {
        const current = map.get(parentSpaceId);
        if (current) {
          current.push(room);
        } else {
          map.set(parentSpaceId, [room]);
        }
      }
    }

    map.set("", homeRooms);
    return map;
  }, [rooms]);

  const roomsBySpace = useCallback(
    (spaceId: string | null) => roomsBySpaceMap.get(spaceId ?? "") ?? [],
    [roomsBySpaceMap]
  );

  const getRoom = (roomId: string) => rooms.find((r) => r.id === roomId) ?? null;

  return {
    rooms,
    spaces,
    roomsBySpace,
    getRoom,
    fetchRooms,
    upsertOptimisticRoom,
    initialLoadComplete,
  };
}