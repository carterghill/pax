import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type RoomDownloadItem = {
  id: string;
  roomId: string;
  fileName: string;
  status: "queued" | "running" | "complete" | "error";
  bytesReceived: number;
  totalBytes: number | null;
  savedPath: string | null;
  error: string | null;
  startedAt: number;
};

type RoomDownloadProgressPayload = {
  jobId: string;
  roomId: string;
  fileName: string;
  status: string;
  bytesReceived: number;
  totalBytes: number | null;
  savedPath: string | null;
  error: string | null;
};

export type StartRoomDownloadParams = {
  roomId: string;
  fileName: string;
  source: { kind: "copy"; sourcePath: string } | { kind: "http"; url: string };
};

type RoomDownloadsContextValue = {
  startDownload: (params: StartRoomDownloadParams) => Promise<void>;
  itemsForRoom: (roomId: string) => RoomDownloadItem[];
  dismissDownload: (jobId: string) => void;
};

const RoomDownloadsContext = createContext<RoomDownloadsContextValue | null>(null);

const MAX_ITEMS = 200;

function mergePayload(
  prev: RoomDownloadItem | undefined,
  p: RoomDownloadProgressPayload,
  startedAt: number,
): RoomDownloadItem {
  const status =
    p.status === "complete"
      ? "complete"
      : p.status === "error"
        ? "error"
        : "running";
  return {
    id: p.jobId,
    roomId: p.roomId,
    fileName: p.fileName,
    status,
    bytesReceived: p.bytesReceived,
    totalBytes: p.totalBytes,
    savedPath: p.savedPath,
    error: p.error,
    startedAt: prev?.startedAt ?? startedAt,
  };
}

export function RoomDownloadsProvider({ children }: { children: ReactNode }) {
  const [byId, setById] = useState<Record<string, RoomDownloadItem>>({});
  /** Job IDs removed from the UI — ignore further progress events so rows don't reappear. */
  const dismissedJobIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const unlisten = listen<RoomDownloadProgressPayload>(
      "room-download-progress",
      (event) => {
        if (cancelled) return;
        const p = event.payload;
        if (dismissedJobIdsRef.current.has(p.jobId)) return;
        const now = Date.now();
        setById((prev) => {
          const next = { ...prev };
          const existing = next[p.jobId];
          next[p.jobId] = mergePayload(existing, p, now);
          const keys = Object.keys(next);
          if (keys.length > MAX_ITEMS) {
            const sorted = keys.sort(
              (a, b) => (next[b]?.startedAt ?? 0) - (next[a]?.startedAt ?? 0),
            );
            for (let i = MAX_ITEMS; i < sorted.length; i++) {
              delete next[sorted[i]!];
            }
          }
          return next;
        });
      },
    );
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  const startDownload = useCallback(async (params: StartRoomDownloadParams) => {
    const jobId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    setById((prev) => ({
      ...prev,
      [jobId]: {
        id: jobId,
        roomId: params.roomId,
        fileName: params.fileName,
        status: "queued",
        bytesReceived: 0,
        totalBytes: null,
        savedPath: null,
        error: null,
        startedAt: now,
      },
    }));

    const base = {
      jobId,
      roomId: params.roomId,
      fileName: params.fileName,
    };
    try {
      if (params.source.kind === "copy") {
        await invoke("start_room_download", {
          args: {
            ...base,
            sourceKind: "copy",
            sourcePath: params.source.sourcePath,
            url: null,
          },
        });
      } else {
        await invoke("start_room_download", {
          args: {
            ...base,
            sourceKind: "http",
            sourcePath: null,
            url: params.source.url,
          },
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setById((prev) => {
        const cur = prev[jobId];
        if (!cur) return prev;
        return {
          ...prev,
          [jobId]: { ...cur, status: "error", error: message },
        };
      });
    }
  }, []);

  const itemsForRoom = useCallback(
    (roomId: string) => {
      return Object.values(byId)
        .filter((x) => x.roomId === roomId)
        .sort((a, b) => b.startedAt - a.startedAt);
    },
    [byId],
  );

  const dismissDownload = useCallback((jobId: string) => {
    dismissedJobIdsRef.current.add(jobId);
    setById((prev) => {
      if (!(jobId in prev)) return prev;
      const next = { ...prev };
      delete next[jobId];
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ startDownload, itemsForRoom, dismissDownload }),
    [startDownload, itemsForRoom, dismissDownload],
  );

  return (
    <RoomDownloadsContext.Provider value={value}>
      {children}
    </RoomDownloadsContext.Provider>
  );
}

export function useRoomDownloads(): RoomDownloadsContextValue {
  const ctx = useContext(RoomDownloadsContext);
  if (!ctx) {
    throw new Error("useRoomDownloads must be used within RoomDownloadsProvider");
  }
  return ctx;
}
