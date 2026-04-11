import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  X,
  Plus,
  Loader2,
  Hash,
  Volume2,
  Users,
  Globe,
  Lock,
} from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { useOverlayObstruction } from "../hooks/useOverlayObstruction";
import ModalLayer from "./ModalLayer";
import { VOICE_ROOM_TYPE } from "../utils/matrix";
import type { Room } from "../types/matrix";
import type { RoomsChangedPayload } from "../types/roomsChanged";

type RoomKind = "text" | "voice";
type HistoryVisibility = "shared" | "joined" | "invited" | "world_readable";
type SpaceRoomAccess = "space_members" | "public" | "invite";

interface CreateRoomDialogProps {
  spaceId: string;
  onClose: () => void;
  onCreated: (payload?: RoomsChangedPayload) => void | Promise<void>;
}

export default function CreateRoomDialog({
  spaceId,
  onClose,
  onCreated,
}: CreateRoomDialogProps) {
  const { palette, typography } = useTheme();
  const modalRef = useRef<HTMLDivElement>(null);
  useOverlayObstruction(modalRef);

  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [roomKind, setRoomKind] = useState<RoomKind>("text");
  const [roomAccess, setRoomAccess] = useState<SpaceRoomAccess>("space_members");
  const [historyVisibility, setHistoryVisibility] =
    useState<HistoryVisibility>("shared");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  const handleCreate = useCallback(async () => {
    if (!name.trim()) {
      setError("Room name is required.");
      return;
    }
    setCreating(true);
    setError(null);

    try {
      const roomType = roomKind === "voice" ? VOICE_ROOM_TYPE : null;
      const trimmedName = name.trim();
      const trimmedTopic = topic.trim() || null;
      const roomId = await invoke<string>("create_room_in_space", {
        spaceId,
        name: trimmedName,
        topic: trimmedTopic,
        spaceRoomAccess: roomAccess,
        roomType,
        roomAlias: null,
        historyVisibility,
      });
      const optimisticRoom: Room = {
        id: roomId,
        name: trimmedName,
        avatarUrl: null,
        isSpace: false,
        parentSpaceIds: [spaceId],
        roomType,
        membership: "joined",
      };
      await onCreated({
        optimisticRoom,
        newSpaceChildTopic: trimmedTopic,
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }, [name, topic, roomKind, roomAccess, historyVisibility, spaceId, onCreated, onClose]);

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: typography.fontSizeSmall,
    fontWeight: typography.fontWeightMedium,
    color: palette.textSecondary,
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 12px",
    fontSize: typography.fontSizeBase,
    fontFamily: typography.fontFamily,
    backgroundColor: palette.bgTertiary,
    border: `1px solid ${palette.border}`,
    borderRadius: 4,
    color: palette.textPrimary,
    outline: "none",
    boxSizing: "border-box",
  };

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
          width: 440,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
      >
        {/* Header */}
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
            Create Room
          </h2>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: palette.textSecondary,
              cursor: "pointer",
              padding: 4,
              borderRadius: 4,
              display: "flex",
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 16px 16px 16px" }}>
          {/* Room type selector */}
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Room Type</label>
            <div style={{ display: "flex", gap: 8 }}>
              <KindButton
                icon={<Hash size={18} />}
                label="Text"
                description="A channel for text messages"
                selected={roomKind === "text"}
                onClick={() => setRoomKind("text")}
                palette={palette}
                typography={typography}
              />
              <KindButton
                icon={<Volume2 size={18} />}
                label="Voice"
                description="A room for voice calls"
                selected={roomKind === "voice"}
                onClick={() => setRoomKind("voice")}
                palette={palette}
                typography={typography}
              />
            </div>
          </div>

          {/* Name */}
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>
              Room Name <span style={{ color: "#ed4245" }}>*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={roomKind === "voice" ? "General Voice" : "general"}
              maxLength={255}
              style={inputStyle}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim() && !creating) handleCreate();
              }}
            />
          </div>

          {/* Topic */}
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Topic</label>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What is this room about?"
              maxLength={512}
              style={inputStyle}
            />
          </div>

          {/* Access */}
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Who can find and join</label>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                width: "100%",
              }}
            >
              <KindButton
                icon={<Users size={18} />}
                label="Space members"
                description="Not listed in the public directory. Anyone already in this space can see it and join without an invite."
                selected={roomAccess === "space_members"}
                onClick={() => setRoomAccess("space_members")}
                palette={palette}
                typography={typography}
                fullWidth
              />
              <KindButton
                icon={<Globe size={18} />}
                label="Public"
                description="Listed in the server's public directory. Anyone can join."
                selected={roomAccess === "public"}
                onClick={() => setRoomAccess("public")}
                palette={palette}
                typography={typography}
                fullWidth
              />
              <KindButton
                icon={<Lock size={18} />}
                label="Invite only"
                description="Not in the public directory. Only people you invite can join."
                selected={roomAccess === "invite"}
                onClick={() => setRoomAccess("invite")}
                palette={palette}
                typography={typography}
                fullWidth
              />
            </div>
          </div>

          {/* History Visibility */}
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>History Visibility</label>
            <select
              value={historyVisibility}
              onChange={(e) =>
                setHistoryVisibility(e.target.value as HistoryVisibility)
              }
              style={{
                ...inputStyle,
                cursor: "pointer",
                WebkitAppearance: "none",
                MozAppearance: "none",
                appearance: "none",
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                backgroundRepeat: "no-repeat",
                backgroundPosition: "right 10px center",
                paddingRight: 32,
              }}
            >
              <option value="shared">Members only (full history)</option>
              <option value="joined">Members only (since they joined)</option>
              <option value="invited">Members only (since they were invited)</option>
              <option value="world_readable">Anyone</option>
            </select>
          </div>

          {/* Error */}
          {error && (
            <div
              style={{
                padding: "8px 12px",
                backgroundColor: "rgba(237,66,69,0.15)",
                border: "1px solid rgba(237,66,69,0.3)",
                borderRadius: 4,
                color: "#ed4245",
                fontSize: typography.fontSizeSmall,
                marginBottom: 8,
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 16px",
            borderTop: `1px solid ${palette.border}`,
            flexShrink: 0,
          }}
        >
          <button
            onClick={onClose}
            disabled={creating}
            style={{
              padding: "8px 16px",
              fontSize: typography.fontSizeBase,
              fontFamily: typography.fontFamily,
              fontWeight: typography.fontWeightMedium,
              backgroundColor: "transparent",
              border: `1px solid ${palette.border}`,
              borderRadius: 4,
              color: palette.textPrimary,
              cursor: creating ? "not-allowed" : "pointer",
              opacity: creating ? 0.5 : 1,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !name.trim()}
            style={{
              padding: "8px 20px",
              fontSize: typography.fontSizeBase,
              fontFamily: typography.fontFamily,
              fontWeight: typography.fontWeightMedium,
              backgroundColor:
                creating || !name.trim()
                  ? palette.accent + "80"
                  : palette.accent,
              border: "none",
              borderRadius: 4,
              color: "#fff",
              cursor: creating || !name.trim() ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {creating ? (
              <>
                <Loader2
                  size={16}
                  style={{ animation: "spin 1s linear infinite" }}
                />
                Creating…
              </>
            ) : (
              <>
                <Plus size={16} />
                Create Room
              </>
            )}
          </button>
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </ModalLayer>
  );
}

function KindButton({
  icon,
  label,
  description,
  selected,
  onClick,
  palette,
  typography,
  fullWidth,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  selected: boolean;
  onClick: () => void;
  palette: import("../theme/types").ThemePalette;
  typography: import("../theme/types").ThemeTypography;
  fullWidth?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: fullWidth ? undefined : 1,
        width: fullWidth ? "100%" : undefined,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 4,
        padding: 12,
        backgroundColor: selected ? palette.bgActive : palette.bgTertiary,
        border: selected
          ? `2px solid ${palette.accent}`
          : `2px solid ${palette.border}`,
        borderRadius: 8,
        cursor: "pointer",
        textAlign: "left",
        transition: "border-color 0.15s, background-color 0.15s",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: selected ? palette.accent : palette.textPrimary,
          fontWeight: typography.fontWeightMedium,
          fontSize: typography.fontSizeBase,
        }}
      >
        {icon} {label}
      </div>
      <div
        style={{
          fontSize: typography.fontSizeSmall - 1,
          color: palette.textSecondary,
          lineHeight: 1.3,
        }}
      >
        {description}
      </div>
    </button>
  );
}