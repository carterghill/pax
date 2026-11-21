import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface IgnoredUsersSnapshot {
  revision: number;
  userIds: string[];
}

interface IgnoredUsers {
  userIds: ReadonlySet<string>;
  revision: number | null;
  loading: boolean;
  loadError: string | null;
  reload: () => Promise<void>;
  setIgnored: (userId: string, ignored: boolean) => Promise<void>;
}

const Context = createContext<IgnoredUsers | null>(null);

export function IgnoredUsersProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<IgnoredUsersSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const apply = useCallback((next: IgnoredUsersSnapshot) => {
    setSnapshot((current) => current && current.revision >= next.revision ? current : next);
    setLoadError(null);
  }, []);

  const reload = useCallback(async () => {
    try {
      apply(await invoke<IgnoredUsersSnapshot>("get_ignored_users"));
    } catch (error) {
      setLoadError(String(error));
    }
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    const update = () => { if (!cancelled) void reload(); };
    const subscriptions = [
      listen<IgnoredUsersSnapshot>("ignored-users-changed", ({ payload }) => {
        if (!cancelled) apply(payload);
      }),
      listen("sync-ready", update),
    ];
    void Promise.allSettled(subscriptions).then(update);
    return () => {
      cancelled = true;
      for (const sub of subscriptions) void sub.then((stop) => stop(), () => {});
    };
  }, [apply, reload]);

  const setIgnored = useCallback(async (targetUserId: string, ignored: boolean) => {
    apply(await invoke<IgnoredUsersSnapshot>("set_user_ignored", {
      userId: targetUserId,
      ignored,
      expectedUserId: userId,
    }));
  }, [apply, userId]);

  const userIds = useMemo(() => new Set(snapshot?.userIds), [snapshot]);
  const previousUserIds = useRef(userIds);
  useEffect(() => {
    const unignored = [...previousUserIds.current].filter((id) => !userIds.has(id));
    previousUserIds.current = userIds;
    if (unignored.length) {
      void invoke("sync_presence", { userIds: unignored, expectedUserId: userId }).catch((e) =>
        console.error("Failed to refresh unignored users’ presence:", e)
      );
    }
  }, [userId, userIds]);

  const value = useMemo<IgnoredUsers>(() => ({
    userIds,
    revision: snapshot?.revision ?? null,
    loading: snapshot === null && loadError === null,
    loadError,
    reload,
    setIgnored,
  }), [userIds, snapshot, loadError, reload, setIgnored]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useIgnoredUsers() {
  const context = useContext(Context);
  if (!context) throw new Error("Ignored users require IgnoredUsersProvider");
  return context;
}
