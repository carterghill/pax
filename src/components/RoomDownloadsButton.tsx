import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FolderOpen, X } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useTheme } from "../theme/ThemeContext";
import { useRoomDownloads, type RoomDownloadItem } from "../context/RoomDownloadsContext";

/** Last segment of a Windows or POSIX path (on-disk name after uniquify). */
function basenameFromFsPath(p: string): string {
  const s = p.replace(/[/\\]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function listTitle(item: RoomDownloadItem): string {
  if (item.savedPath) return basenameFromFsPath(item.savedPath);
  return item.fileName;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const DONE_GREEN = "#23a55a";

function progressPercent(item: RoomDownloadItem): number | null {
  if (item.status === "complete") return 100;
  if (
    item.totalBytes != null &&
    item.totalBytes > 0 &&
    item.bytesReceived >= 0
  ) {
    return Math.min(100, (item.bytesReceived / item.totalBytes) * 100);
  }
  return null;
}

/** Combined progress for all active downloads in this room (icon strip). */
function iconAggregateBar(
  active: RoomDownloadItem[],
): { widthPct: number; indeterminate: boolean } {
  if (active.length === 0) return { widthPct: 0, indeterminate: false };
  let sum = 0;
  let anyRunningUnknown = false;
  let anyQueued = false;
  for (const i of active) {
    if (i.status === "queued") {
      anyQueued = true;
      continue;
    }
    const p = progressPercent(i);
    if (p == null) anyRunningUnknown = true;
    else sum += p;
  }
  if (anyRunningUnknown) return { widthPct: 100, indeterminate: true };
  if (anyQueued && sum === 0) return { widthPct: 100, indeterminate: true };
  const avg = sum / active.length;
  return { widthPct: avg, indeterminate: false };
}

export default function RoomDownloadsButton({ roomId }: { roomId: string }) {
  const { palette, typography, spacing } = useTheme();
  const { itemsForRoom, dismissDownload } = useRoomDownloads();
  const [open, setOpen] = useState(false);
  /** Icon turns green when active downloads just finished; cleared when opening the menu. */
  const [doneHighlight, setDoneHighlight] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const prevHadActiveRef = useRef(false);
  const items = itemsForRoom(roomId);

  const activeItems = useMemo(
    () => items.filter((i) => i.status === "queued" || i.status === "running"),
    [items],
  );
  const hasActive = activeItems.length > 0;
  const iconBar = useMemo(
    () => iconAggregateBar(activeItems),
    [activeItems],
  );

  useEffect(() => {
    if (hasActive) {
      setDoneHighlight(false);
    } else if (
      prevHadActiveRef.current &&
      items.some((i) => i.status === "complete")
    ) {
      setDoneHighlight(true);
    }
    prevHadActiveRef.current = hasActive;
  }, [hasActive, items]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const el = rootRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const iconColor = (() => {
    if (hasActive) return open ? palette.textHeading : palette.textSecondary;
    if (doneHighlight) return DONE_GREEN;
    return open ? palette.textHeading : palette.textSecondary;
  })();

  const handleToggleOpen = () => {
    setOpen((wasOpen) => {
      if (!wasOpen) setDoneHighlight(false);
      return !wasOpen;
    });
  };

  if (items.length === 0) return null;

  return (
    <div
      ref={rootRef}
      style={{ position: "relative", flexShrink: 0, marginRight: spacing.unit }}
    >
      <button
        type="button"
        title="Downloads from this chat"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={handleToggleOpen}
        style={{
          background: open ? palette.bgActive : "none",
          border: "none",
          cursor: "pointer",
          padding: 0,
          borderRadius: spacing.unit,
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          lineHeight: 0,
          minWidth: spacing.unit * 7,
        }}
      >
        <div
          style={{
            padding: spacing.unit,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: iconColor,
            transition: "color 0.2s ease",
          }}
        >
          <Download size={20} strokeWidth={2} aria-hidden />
        </div>
        {hasActive ? (
          <div
            style={{
              height: 3,
              marginLeft: spacing.unit * 0.75,
              marginRight: spacing.unit * 0.75,
              marginBottom: spacing.unit * 0.5,
              borderRadius: 2,
              backgroundColor: palette.bgTertiary,
              overflow: "hidden",
            }}
          >
            {iconBar.indeterminate ? (
              <div
                style={{
                  height: "100%",
                  width: "100%",
                  backgroundColor: DONE_GREEN,
                  animation: "paxIconDlPulse 1s ease-in-out infinite",
                }}
              />
            ) : (
              <div
                style={{
                  height: "100%",
                  width: `${iconBar.widthPct}%`,
                  backgroundColor: DONE_GREEN,
                  transition: "width 0.2s ease",
                }}
              />
            )}
          </div>
        ) : null}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Downloads"
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: spacing.unit,
            width: Math.min(360, typeof window !== "undefined" ? window.innerWidth - 32 : 360),
            maxHeight: spacing.unit * 70,
            overflowY: "auto",
            zIndex: 14_000,
            backgroundColor: palette.bgSecondary,
            border: `1px solid ${palette.border}`,
            borderRadius: spacing.unit * 1.5,
            boxShadow:
              "0 8px 24px rgba(0,0,0,0.28), 0 0 0 1px rgba(0,0,0,0.04)",
            padding: `${spacing.unit * 2}px 0`,
          }}
        >
          {items.map((item, i) => {
              const pct = progressPercent(item);
              const indeterminate =
                item.status === "running" &&
                (item.totalBytes == null || item.totalBytes === 0);
              const title = listTitle(item);
              const showOriginalLabel =
                item.status === "complete" &&
                item.savedPath &&
                item.fileName !== title;
              return (
                <div
                  key={item.id}
                  style={{
                    padding: `${spacing.unit * 2}px ${spacing.unit * 4}px`,
                    borderBottom:
                      i < items.length - 1 ? `1px solid ${palette.border}` : "none",
                    fontFamily: typography.fontFamily,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: spacing.unit,
                      marginBottom: spacing.unit,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        title={title}
                        style={{
                          fontSize: typography.fontSizeSmall,
                          fontWeight: typography.fontWeightMedium,
                          color: palette.textPrimary,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {title}
                      </div>
                      {showOriginalLabel ? (
                        <div
                          title={item.fileName}
                          style={{
                            marginTop: spacing.unit * 0.5,
                            fontSize: typography.fontSizeSmall - 1,
                            color: palette.textSecondary,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          Original name: {item.fileName}
                        </div>
                      ) : null}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: spacing.unit * 0.5,
                        flexShrink: 0,
                      }}
                    >
                      {item.status === "complete" && item.savedPath ? (
                        <button
                          type="button"
                          title="Show in folder"
                          aria-label="Show in folder"
                          onClick={(e) => {
                            e.stopPropagation();
                            revealItemInDir(item.savedPath!).catch((err) =>
                              console.error("[downloads] revealItemInDir:", err),
                            );
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            padding: spacing.unit * 0.75,
                            border: "none",
                            borderRadius: spacing.unit,
                            backgroundColor: "transparent",
                            color: palette.textSecondary,
                            cursor: "pointer",
                            lineHeight: 0,
                          }}
                        >
                          <FolderOpen size={16} strokeWidth={2} aria-hidden />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        title="Remove from list"
                        aria-label="Remove from list"
                        onClick={(e) => {
                          e.stopPropagation();
                          dismissDownload(item.id);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: spacing.unit * 0.75,
                          border: "none",
                          borderRadius: spacing.unit,
                          backgroundColor: "transparent",
                          color: palette.textSecondary,
                          cursor: "pointer",
                          lineHeight: 0,
                        }}
                      >
                        <X size={16} strokeWidth={2} aria-hidden />
                      </button>
                    </div>
                  </div>
                  <div
                    style={{
                      height: 4,
                      borderRadius: 2,
                      backgroundColor: palette.bgTertiary,
                      overflow: "hidden",
                      marginBottom: spacing.unit,
                    }}
                  >
                    {item.status === "error" ? (
                      <div
                        style={{
                          height: "100%",
                          width: "100%",
                          backgroundColor: "#f23f43",
                          opacity: 0.85,
                        }}
                      />
                    ) : pct != null && !indeterminate ? (
                      <div
                        style={{
                          height: "100%",
                          width: `${pct}%`,
                          backgroundColor:
                            item.status === "complete"
                              ? "#23a55a"
                              : palette.accent,
                          transition: "width 0.2s ease",
                        }}
                      />
                    ) : item.status === "running" || item.status === "queued" ? (
                      <div
                        style={{
                          height: "100%",
                          width: "100%",
                          backgroundColor: palette.accent,
                          animation: "paxDlPulse 1.2s ease-in-out infinite",
                        }}
                      />
                    ) : null}
                  </div>
                  <div
                    style={{
                      fontSize: typography.fontSizeSmall - 1,
                      color: palette.textSecondary,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: spacing.unit * 2,
                    }}
                  >
                    <span>
                      {item.status === "complete" && item.savedPath
                        ? "Saved to Downloads"
                        : item.status === "error"
                          ? item.error ?? "Failed"
                          : item.status === "queued"
                            ? "Queued…"
                            : pct != null
                              ? `${Math.round(pct)}% · ${formatBytes(item.bytesReceived)}`
                              : `Downloading… ${formatBytes(item.bytesReceived)}`}
                    </span>
                  </div>
                </div>
              );
            })}
          <style>{`
            @keyframes paxDlPulse {
              0%, 100% { opacity: 0.25; }
              50% { opacity: 0.9; }
            }
            @keyframes paxIconDlPulse {
              0%, 100% { opacity: 0.35; }
              50% { opacity: 1; }
            }
          `}</style>
        </div>
      )}
    </div>
  );
}
