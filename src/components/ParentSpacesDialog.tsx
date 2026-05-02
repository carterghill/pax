import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Loader2, Users, Crown } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { paletteDialogShellBorderStyle } from "../theme/paletteBorder";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";
import { avatarSrc } from "../utils/avatarSrc";
import ModalLayer from "./ModalLayer";

interface ParentSpaceInfo {
  id: string;
  name: string;
  topic: string | null;
  avatarUrl: string | null;
  membership: "joined" | "invited" | "none";
  joinRule: string | null;
  numJoinedMembers: number;
  canonical: boolean;
}

interface ParentSpacesDialogProps {
  roomId: string;
  roomName: string;
  onClose: () => void;
}

export default function ParentSpacesDialog({
  roomId,
  roomName,
  onClose,
}: ParentSpacesDialogProps) {
  const { palette, typography } = useTheme();
  const modalRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(modalRef);

  const [loading, setLoading] = useState(true);
  const [spaces, setSpaces] = useState<ParentSpaceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !joiningId) onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, joiningId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await invoke<ParentSpaceInfo[]>("get_room_parent_spaces", { roomId });
        if (!cancelled) {
          setSpaces(result);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget && !joiningId) onClose();
    },
    [onClose, joiningId],
  );

  const handleJoin = useCallback(
    async (spaceId: string) => {
      setJoiningId(spaceId);
      setJoinError(null);
      try {
        await invoke("join_room", { roomId: spaceId });
        // Update the local state to reflect the join
        setSpaces((prev) =>
          prev.map((s) => (s.id === spaceId ? { ...s, membership: "joined" as const } : s)),
        );
      } catch (e) {
        setJoinError(String(e));
      } finally {
        setJoiningId(null);
      }
    },
    [],
  );

  const joinLabel = (joinRule: string | null) => {
    switch (joinRule) {
      case "public":
        return "Join";
      case "knock":
        return "Request to join";
      default:
        return "Join";
    }
  };

  const canAttemptJoin = (s: ParentSpaceInfo) =>
    s.membership === "none" && (s.joinRule === "public" || s.joinRule === "knock");

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
        role="dialog"
        aria-labelledby="parent-spaces-title"
        style={{
          backgroundColor: palette.bgSecondary,
          borderRadius: 12,
          width: "min(440px, calc(100vw - 32px))",
          maxHeight: "75vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
          ...paletteDialogShellBorderStyle(palette),
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            padding: "16px 16px 8px 16px",
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h2
              id="parent-spaces-title"
              style={{
                margin: 0,
                fontSize: typography.fontSizeLarge,
                fontWeight: typography.fontWeightBold,
                color: palette.textHeading,
              }}
            >
              Parent spaces
            </h2>
            <p
              style={{
                margin: "4px 0 0 0",
                fontSize: typography.fontSizeSmall,
                color: palette.textSecondary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              Spaces that contain{" "}
              <strong style={{ color: palette.textPrimary, fontWeight: typography.fontWeightMedium }}>
                {roomName}
              </strong>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={joiningId !== null}
            title="Close"
            style={{
              background: "none",
              border: "none",
              color: palette.textSecondary,
              cursor: joiningId ? "default" : "pointer",
              padding: 4,
              borderRadius: 6,
              display: "flex",
              flexShrink: 0,
              opacity: joiningId ? 0.5 : 1,
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "8px 16px 16px 16px",
            minHeight: 80,
          }}
        >
          {loading ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                padding: 32,
                color: palette.textSecondary,
                fontSize: typography.fontSizeSmall,
              }}
            >
              <Loader2 size={18} style={{ animation: "spin 0.8s linear infinite" }} />
              Loading parent spaces…
            </div>
          ) : error ? (
            <div
              style={{
                color: "#ed4245",
                fontSize: typography.fontSizeSmall,
                textAlign: "center",
                padding: 24,
                lineHeight: 1.5,
              }}
            >
              {error}
            </div>
          ) : spaces.length === 0 ? (
            <div
              style={{
                color: palette.textSecondary,
                fontSize: typography.fontSizeSmall,
                textAlign: "center",
                padding: 24,
                lineHeight: 1.5,
              }}
            >
              This room doesn't have any parent spaces, or none have been made discoverable.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {joinError && (
                <div
                  style={{
                    color: "#ed4245",
                    fontSize: typography.fontSizeSmall,
                    padding: "6px 0",
                    lineHeight: 1.4,
                  }}
                >
                  {joinError}
                </div>
              )}
              {spaces.map((space) => {
                const busy = joiningId === space.id;
                const joined = space.membership === "joined";
                const invited = space.membership === "invited";
                const showJoin = canAttemptJoin(space);
                const isPrivate =
                  space.membership === "none" &&
                  space.joinRule !== "public" &&
                  space.joinRule !== "knock";

                return (
                  <div
                    key={space.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 12px",
                      borderRadius: 8,
                      backgroundColor: palette.bgTertiary,
                    }}
                  >
                    {/* Avatar */}
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 10,
                        flexShrink: 0,
                        overflow: "hidden",
                        backgroundColor: palette.bgActive,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {space.avatarUrl ? (
                        <img
                          src={avatarSrc(space.avatarUrl)}
                          alt=""
                          style={{ width: 40, height: 40, objectFit: "cover" }}
                        />
                      ) : (
                        <span
                          style={{
                            fontSize: 16,
                            fontWeight: typography.fontWeightBold,
                            color: palette.textSecondary,
                          }}
                        >
                          {space.name.charAt(0).toUpperCase()}
                        </span>
                      )}
                    </div>

                    {/* Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <span
                          style={{
                            fontSize: typography.fontSizeBase,
                            fontWeight: typography.fontWeightMedium,
                            color: palette.textPrimary,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {space.name}
                        </span>
                        {space.canonical && (
                          <span title="Canonical parent" style={{ display: "inline-flex", flexShrink: 0 }}>
                            <Crown
                              size={13}
                              color={palette.accent}
                            />
                          </span>
                        )}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          marginTop: 2,
                        }}
                      >
                        {space.numJoinedMembers > 0 && (
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 4,
                              fontSize: typography.fontSizeSmall,
                              color: palette.textSecondary,
                            }}
                          >
                            <Users size={12} />
                            {space.numJoinedMembers}
                          </span>
                        )}
                        {space.topic && (
                          <span
                            style={{
                              fontSize: typography.fontSizeSmall,
                              color: palette.textSecondary,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {space.topic}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Action */}
                    <div style={{ flexShrink: 0 }}>
                      {joined ? (
                        <span
                          style={{
                            fontSize: typography.fontSizeSmall,
                            color: palette.textSecondary,
                            fontWeight: typography.fontWeightMedium,
                            padding: "4px 10px",
                          }}
                        >
                          Joined
                        </span>
                      ) : invited ? (
                        <span
                          style={{
                            fontSize: typography.fontSizeSmall,
                            color: palette.accent,
                            fontWeight: typography.fontWeightMedium,
                            padding: "4px 10px",
                          }}
                        >
                          Invited
                        </span>
                      ) : showJoin ? (
                        <button
                          type="button"
                          disabled={joiningId !== null}
                          onClick={() => handleJoin(space.id)}
                          style={{
                            padding: "5px 14px",
                            borderRadius: 6,
                            border: "none",
                            backgroundColor: palette.accent,
                            color: "#fff",
                            fontSize: typography.fontSizeSmall,
                            fontWeight: typography.fontWeightMedium,
                            cursor: busy || joiningId !== null ? "default" : "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            opacity: joiningId !== null && !busy ? 0.5 : 1,
                          }}
                        >
                          {busy ? (
                            <>
                              <Loader2
                                size={14}
                                style={{ animation: "spin 0.8s linear infinite" }}
                              />
                              Joining…
                            </>
                          ) : (
                            joinLabel(space.joinRule)
                          )}
                        </button>
                      ) : isPrivate ? (
                        <span
                          style={{
                            fontSize: typography.fontSizeSmall,
                            color: palette.textSecondary,
                            fontStyle: "italic",
                            padding: "4px 10px",
                          }}
                        >
                          Private
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    </ModalLayer>
  );
}