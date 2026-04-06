import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme/ThemeContext";
import { ThemeToggle } from "../theme/ThemeToggle";
import { Camera, Trash2, Check, X, Pencil } from "lucide-react";
import type { VoiceCall } from "../hooks/useVoiceCall";
import VoiceAudioSettingsSection from "./VoiceAudioSettingsSection";

interface SettingsMenuProps {
  onSignOut: () => void;
  userAvatarUrl: string | null;
  onAvatarChanged: (newUrl: string | null) => void;
  voiceCall: VoiceCall;
}

export default function SettingsMenu({
  onSignOut,
  userAvatarUrl,
  onAvatarChanged,
  voiceCall,
}: SettingsMenuProps) {
  const { palette, typography, spacing } = useTheme();

  const reconnectVoiceAfterDeviceChange = useCallback(async () => {
    const rid = voiceCall.connectedRoomId;
    if (rid && !voiceCall.isConnecting) {
      await voiceCall.connect(rid, { forceReconnect: true });
    }
  }, [voiceCall.connectedRoomId, voiceCall.isConnecting, voiceCall.connect]);

  // ---- Display name ----
  const [displayName, setDisplayName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<string | null>("get_display_name").then((name) => {
      if (!cancelled && name) {
        setDisplayName(name);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function startEditingName() {
    setDraftName(displayName);
    setEditingName(true);
    setNameError(null);
    setTimeout(() => nameInputRef.current?.focus(), 0);
  }

  function cancelEditingName() {
    setEditingName(false);
    setNameError(null);
  }

  async function saveName() {
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === displayName) {
      setEditingName(false);
      return;
    }
    setNameSaving(true);
    setNameError(null);
    try {
      await invoke("set_display_name", { name: trimmed });
      setDisplayName(trimmed);
      setEditingName(false);
    } catch (e) {
      setNameError(String(e));
    } finally {
      setNameSaving(false);
    }
  }

  // ---- Avatar ----
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleAvatarFile(file: File) {
    setAvatarUploading(true);
    setAvatarError(null);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      // Convert to base64
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const b64 = btoa(binary);

      const dataUrl = await invoke<string>("set_user_avatar", {
        data: b64,
        mime: file.type || "image/png",
      });
      onAvatarChanged(dataUrl);
    } catch (e) {
      setAvatarError(String(e));
    } finally {
      setAvatarUploading(false);
    }
  }

  async function handleRemoveAvatar() {
    setAvatarUploading(true);
    setAvatarError(null);
    try {
      await invoke("remove_user_avatar");
      onAvatarChanged(null);
    } catch (e) {
      setAvatarError(String(e));
    } finally {
      setAvatarUploading(false);
    }
  }

  // ---- Shared styles ----
  const sectionStyle: React.CSSProperties = {
    marginBottom: spacing.unit * 6,
    padding: spacing.unit * 4,
    backgroundColor: palette.bgSecondary,
    borderRadius: 8,
    border: `1px solid ${palette.border}`,
  };
  const sectionHeading: React.CSSProperties = {
    margin: 0,
    marginBottom: spacing.unit * 3,
    fontSize: typography.fontSizeBase,
    fontWeight: typography.fontWeightMedium,
    color: palette.textSecondary,
  };
  const smallBtn: React.CSSProperties = {
    padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
    fontSize: typography.fontSizeSmall,
    fontWeight: typography.fontWeightMedium,
    color: palette.textPrimary,
    backgroundColor: palette.bgTertiary,
    border: `1px solid ${palette.border}`,
    borderRadius: 6,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: spacing.unit * 1.5,
  };

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        padding: spacing.unit * 6,
        maxWidth: 480,
        overflowY: "auto",
      }}
    >
      <h2
        style={{
          margin: 0,
          marginBottom: spacing.unit * 4,
          fontSize: typography.fontSizeLarge,
          fontWeight: typography.fontWeightBold,
          color: palette.textHeading,
        }}
      >
        Settings
      </h2>

      {/* ── User ── */}
      <section style={sectionStyle}>
        <h3 style={sectionHeading}>User</h3>

        {/* Avatar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit * 4,
            marginBottom: spacing.unit * 4,
          }}
        >
          <div style={{ position: "relative", flexShrink: 0 }}>
            {userAvatarUrl ? (
              <img
                src={userAvatarUrl}
                alt="Your avatar"
                style={{
                  display: "block",
                  width: 64,
                  height: 64,
                  borderRadius: "50%",
                  objectFit: "cover",
                }}
              />
            ) : (
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: "50%",
                  backgroundColor: palette.accent,
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 24,
                  fontWeight: typography.fontWeightBold,
                }}
              >
                {displayName ? displayName.charAt(0).toUpperCase() : "?"}
              </div>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: spacing.unit * 2 }}>
            <div style={{ display: "flex", gap: spacing.unit * 2 }}>
              <button
                style={smallBtn}
                disabled={avatarUploading}
                onClick={() => fileInputRef.current?.click()}
              >
                <Camera size={14} />
                {avatarUploading ? "Uploading..." : "Change Avatar"}
              </button>
              {userAvatarUrl && (
                <button
                  style={{ ...smallBtn, color: "#f23f43" }}
                  disabled={avatarUploading}
                  onClick={handleRemoveAvatar}
                >
                  <Trash2 size={14} />
                  Remove
                </button>
              )}
            </div>
            {avatarError && (
              <span
                style={{
                  fontSize: typography.fontSizeSmall,
                  color: "#f23f43",
                }}
              >
                {avatarError}
              </span>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleAvatarFile(file);
              // Reset so the same file can be re-selected
              e.target.value = "";
            }}
          />
        </div>

        {/* Display name */}
        <div>
          <div
            style={{
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightMedium,
              color: palette.textSecondary,
              marginBottom: spacing.unit,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Display Name
          </div>
          {editingName ? (
            <div style={{ display: "flex", alignItems: "center", gap: spacing.unit * 2 }}>
              <input
                ref={nameInputRef}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                disabled={nameSaving}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveName();
                  if (e.key === "Escape") cancelEditingName();
                }}
                style={{
                  flex: 1,
                  padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
                  fontSize: typography.fontSizeBase,
                  color: palette.textPrimary,
                  backgroundColor: palette.bgTertiary,
                  border: `1px solid ${palette.border}`,
                  borderRadius: 4,
                  outline: "none",
                  fontFamily: typography.fontFamily,
                }}
              />
              <button
                style={{
                  ...smallBtn,
                  color: "#23a55a",
                  padding: `${spacing.unit * 1.5}px`,
                }}
                disabled={nameSaving}
                onClick={saveName}
                title="Save"
              >
                <Check size={16} />
              </button>
              <button
                style={{
                  ...smallBtn,
                  padding: `${spacing.unit * 1.5}px`,
                }}
                disabled={nameSaving}
                onClick={cancelEditingName}
                title="Cancel"
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: spacing.unit * 2 }}>
              <span
                style={{
                  fontSize: typography.fontSizeBase,
                  color: palette.textPrimary,
                }}
              >
                {displayName || "Not set"}
              </span>
              <button
                style={{
                  ...smallBtn,
                  padding: `${spacing.unit * 1.5}px`,
                }}
                onClick={startEditingName}
                title="Edit display name"
              >
                <Pencil size={14} />
              </button>
            </div>
          )}
          {nameError && (
            <span
              style={{
                fontSize: typography.fontSizeSmall,
                color: "#f23f43",
                marginTop: spacing.unit,
                display: "block",
              }}
            >
              {nameError}
            </span>
          )}
        </div>
      </section>

      {/* ── Appearance ── */}
      <section style={sectionStyle}>
        <h3 style={sectionHeading}>Appearance</h3>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit * 3,
          }}
        >
          <span
            style={{
              fontSize: typography.fontSizeBase,
              color: palette.textPrimary,
            }}
          >
            Theme
          </span>
          <ThemeToggle />
        </div>
      </section>

      {/* ── Audio (voice chat) ── */}
      <section style={sectionStyle}>
        <h3 style={sectionHeading}>Audio</h3>
        <VoiceAudioSettingsSection
          active
          listAudioDevices={voiceCall.listAudioDevices}
          getNoiseSuppressionConfig={voiceCall.getNoiseSuppressionConfig}
          setNoiseSuppressionConfig={voiceCall.setNoiseSuppressionConfig}
          toggleNoiseSuppression={voiceCall.toggleNoiseSuppression}
          isNoiseSuppressed={voiceCall.isNoiseSuppressed}
          onAfterDevicePreferenceChange={reconnectVoiceAfterDeviceChange}
        />
      </section>

      {/* ── Account ── */}
      <section
        style={{
          ...sectionStyle,
          marginTop: "auto",
          marginBottom: 0,
        }}
      >
        <h3 style={sectionHeading}>Account</h3>
        <button
          onClick={onSignOut}
          style={{
            padding: `${spacing.unit * 2}px ${spacing.unit * 4}px`,
            fontSize: typography.fontSizeBase,
            fontWeight: typography.fontWeightMedium,
            color: palette.textPrimary,
            backgroundColor: palette.bgTertiary,
            border: `1px solid ${palette.border}`,
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Sign out
        </button>
      </section>
    </div>
  );
}