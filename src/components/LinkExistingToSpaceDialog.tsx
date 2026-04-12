import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type MouseEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Loader2, Search } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { paletteDialogShellBorderStyle } from "../theme/paletteBorder";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";
import ModalLayer from "./ModalLayer";
import type { Room } from "../types/matrix";

export type LinkExistingKind = "room" | "space";

interface LinkExistingToSpaceDialogProps {
  kind: LinkExistingKind;
  parentSpaceId: string;
  candidates: Room[];
  onClose: () => void;
  onLinked: () => void | Promise<void>;
}

export default function LinkExistingToSpaceDialog({
  kind,
  parentSpaceId,
  candidates,
  onClose,
  onLinked,
}: LinkExistingToSpaceDialogProps) {
  const { palette, typography } = useTheme();
  const modalRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(modalRef);

  const [query, setQuery] = useState("");
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((r) => r.name.toLowerCase().includes(q));
  }, [candidates, query]);

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  const handlePick = useCallback(
    async (roomId: string) => {
      setLinkingId(roomId);
      setError(null);
      try {
        await invoke("link_room_to_space", {
          parentSpaceId,
          childRoomId: roomId,
        });
        await onLinked();
        onClose();
      } catch (e) {
        setError(String(e));
      } finally {
        setLinkingId(null);
      }
    },
    [parentSpaceId, onLinked, onClose]
  );

  const title = kind === "room" ? "Add existing room" : "Add existing space";

  return (
    <ModalLayer
      onBackdropClick={handleBackdropClick}
      backdropStyle={{
        backgroundColor: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        ref={modalRef}
        style={{
          backgroundColor: palette.bgSecondary,
          borderRadius: 8,
          width: 420,
          maxHeight: "75vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          ...paletteDialogShellBorderStyle(palette),
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 16px 12px 16px",
            flexShrink: 0,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: typography.fontSizeLarge,
              fontWeight: typography.fontWeightBold,
              color: palette.textHeading,
            }}
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={linkingId !== null}
            style={{
              background: "none",
              border: "none",
              color: palette.textSecondary,
              cursor: linkingId !== null ? "default" : "pointer",
              padding: 4,
              borderRadius: 4,
              display: "flex",
            }}
          >
            <X size={20} />
          </button>
        </div>

        <div style={{ padding: "0 16px 12px 16px", flexShrink: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              borderRadius: 6,
              backgroundColor: palette.bgTertiary,
              border: `1px solid ${palette.border}`,
            }}
          >
            <Search size={16} color={palette.textSecondary} />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              autoFocus
              style={{
                flex: 1,
                minWidth: 0,
                border: "none",
                background: "transparent",
                color: palette.textPrimary,
                fontSize: typography.fontSizeSmall,
                fontFamily: typography.fontFamily,
                outline: "none",
              }}
            />
          </div>
        </div>

        {error && (
          <div
            style={{
              padding: "0 16px 8px 16px",
              color: "#f38ba8",
              fontSize: typography.fontSizeSmall,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "0 16px 16px 16px",
            minHeight: 120,
          }}
        >
          {candidates.length === 0 ? (
            <div
              style={{
                color: palette.textSecondary,
                fontSize: typography.fontSizeSmall,
                textAlign: "center",
                padding: "24px 8px",
              }}
            >
              No {kind === "room" ? "rooms" : "spaces"} without a parent space. Create one first,
              or leave a space to make it available here.
            </div>
          ) : filtered.length === 0 ? (
            <div
              style={{
                color: palette.textSecondary,
                fontSize: typography.fontSizeSmall,
                textAlign: "center",
                padding: "24px 8px",
              }}
            >
              No matches.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {filtered.map((r) => {
                const busy = linkingId === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    disabled={linkingId !== null}
                    onClick={() => handlePick(r.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 12px",
                      borderRadius: 6,
                      border: "none",
                      backgroundColor: palette.bgTertiary,
                      color: palette.textPrimary,
                      fontSize: typography.fontSizeSmall,
                      fontFamily: typography.fontFamily,
                      textAlign: "left",
                      cursor: busy || linkingId !== null ? "default" : "pointer",
                      opacity: linkingId !== null && !busy ? 0.5 : 1,
                    }}
                  >
                    {busy ? (
                      <Loader2
                        size={16}
                        style={{ animation: "spin 1s linear infinite", flexShrink: 0 }}
                      />
                    ) : null}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.name}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </ModalLayer>
  );
}
