import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme/ThemeContext";
import { ColorModeControl } from "../theme/ColorModeControl";
import { ThemeSelector } from "../theme/ThemeSelector";
import {
  Camera,
  Trash2,
  Check,
  X,
  Pencil,
  User,
  Palette,
  Volume2,
  Bell,
  LogOut,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { VoiceCall } from "../hooks/useVoiceCall";
import VoiceAudioSettingsSection from "./VoiceAudioSettingsSection";
import UserAvatar from "./UserAvatar";
import {
  getSendPublicReceipts,
  setSendPublicReceipts,
} from "../utils/readReceiptPrefs";
import NotificationSettingsPanel from "./NotificationSettingsPanel";

interface SettingsMenuProps {
  onSignOut: () => void;
  userId: string;
  userAvatarUrl: string | null;
  onAvatarChanged: (newUrl: string | null) => void;
  voiceCall: VoiceCall;
}

type SettingsSection =
  | "user"
  | "appearance"
  | "audio"
  | "notifications"
  | "account";

interface SettingsNavItem {
  id: SettingsSection;
  label: string;
  description: string;
  title: string;
  blurb: string;
  icon: LucideIcon;
}

export default function SettingsMenu({
  onSignOut,
  userId,
  userAvatarUrl,
  onAvatarChanged,
  voiceCall,
}: SettingsMenuProps) {
  const { palette, typography, spacing } = useTheme();
  const [activeSection, setActiveSection] = useState<SettingsSection>("user");

  // ---- Notifications ----
  /**
   * Public vs private read receipts.  Stored in localStorage via
   * `readReceiptPrefs`; we mirror it into React state for the checkbox.  We
   * re-read on `storage` events so another tab / profile toggling this stays
   * in sync.
   */
  const [sendPublicReceipts, setSendPublicReceiptsState] = useState<boolean>(
    () => getSendPublicReceipts(),
  );
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === "pax.settings.sendPublicReceipts") {
        setSendPublicReceiptsState(getSendPublicReceipts());
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const handleToggleSendPublicReceipts = useCallback((next: boolean) => {
    setSendPublicReceiptsState(next);
    setSendPublicReceipts(next);
  }, []);

  /** Desktop: remembered close action, or "ask" when the confirmation dialog should show each time. */
  const [closeWindowBehavior, setCloseWindowBehavior] = useState<
    "ask" | "minimize_tray" | "quit" | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    invoke<string | null>("get_close_window_preference")
      .then((p) => {
        if (cancelled) return;
        if (p === "minimize_tray" || p === "quit") setCloseWindowBehavior(p);
        else setCloseWindowBehavior("ask");
      })
      .catch(() => {
        if (!cancelled) setCloseWindowBehavior("ask");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCloseWindowBehaviorChange = useCallback(
    async (next: "ask" | "minimize_tray" | "quit") => {
      setCloseWindowBehavior(next);
      try {
        if (next === "ask") {
          await invoke("clear_close_window_preference");
        } else {
          await invoke("set_close_window_preference", { action: next });
        }
      } catch (e) {
        console.error(e);
      }
    },
    [],
  );

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

  const navItems: SettingsNavItem[] = [
    {
      id: "user",
      label: "Profile",
      description: "Avatar and display name",
      title: "Profile settings",
      blurb: "Update how you appear across Pax with a cleaner profile card and name controls.",
      icon: User,
    },
    {
      id: "appearance",
      label: "Appearance",
      description: "Color mode and theme",
      title: "Appearance",
      blurb: "Choose color mode and, when more themes exist, which palette set to use.",
      icon: Palette,
    },
    {
      id: "audio",
      label: "Audio",
      description: "Voice devices and filters",
      title: "Audio",
      blurb: "Manage your microphone, speakers, and noise suppression settings from one place.",
      icon: Volume2,
    },
    {
      id: "notifications",
      label: "Notifications",
      description: "Read receipts",
      title: "Notifications",
      blurb: "Control what other users can see about when you've read their messages.",
      icon: Bell,
    },
    {
      id: "account",
      label: "Account",
      description: "Session and sign out",
      title: "Account",
      blurb: "Control your current session and sign out safely when you are done.",
      icon: LogOut,
    },
  ];

  const activeNavItem =
    navItems.find((item) => item.id === activeSection) ?? navItems[0];

  const panelStyle = {
    backgroundColor: palette.bgSecondary,
    border: `1px solid ${palette.border}`,
    borderRadius: 14,
    padding: spacing.unit * 5,
    boxShadow: "0 10px 30px rgba(0,0,0,0.16)",
  };
  const sectionHeadingStyle = {
    margin: 0,
    marginBottom: spacing.unit,
    fontSize: typography.fontSizeLarge,
    fontWeight: typography.fontWeightBold,
    color: palette.textHeading,
  };
  const sectionDescriptionStyle = {
    margin: 0,
    color: palette.textSecondary,
    fontSize: typography.fontSizeBase,
    lineHeight: 1.55,
  };
  const fieldLabelStyle = {
    fontSize: typography.fontSizeSmall,
    fontWeight: typography.fontWeightMedium,
    color: palette.textSecondary,
    marginBottom: spacing.unit,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  };
  const textInputStyle = {
    width: "100%",
    padding: `${spacing.unit * 1.75}px ${spacing.unit * 2}px`,
    fontSize: typography.fontSizeBase,
    color: palette.textPrimary,
    backgroundColor: palette.bgTertiary,
    border: `1px solid ${palette.border}`,
    borderRadius: 10,
    outline: "none",
    fontFamily: typography.fontFamily,
    boxSizing: "border-box" as const,
  };
  const smallBtn = {
    padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
    fontSize: typography.fontSizeSmall,
    fontWeight: typography.fontWeightMedium,
    color: palette.textPrimary,
    backgroundColor: palette.bgTertiary,
    border: `1px solid ${palette.border}`,
    borderRadius: 10,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: spacing.unit * 1.5,
  };

  return (
    <div
      style={{
        width: "100%",
        minHeight: 0,
        display: "flex",
        backgroundColor: palette.bgPrimary,
      }}
    >
      <aside
        style={{
          width: 232,
          flexShrink: 0,
          minHeight: 0,
          alignSelf: "stretch",
          overflowY: "auto",
          overflowX: "hidden",
          backgroundColor: palette.bgSecondary,
          borderRight: `1px solid ${palette.border}`,
          padding: spacing.unit * 5,
          display: "flex",
          flexDirection: "column",
          gap: spacing.unit * 4,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: spacing.unit * 2,
          }}
        >
          <div
            style={{
              fontSize: typography.fontSizeSmall,
              fontWeight: typography.fontWeightMedium,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              color: palette.textSecondary,
            }}
          >
            Settings
          </div>
          <div
            style={{
              fontSize: typography.fontSizeLarge,
              fontWeight: typography.fontWeightBold,
              color: palette.textHeading,
            }}
          >
            Preferences
          </div>
          <div
            style={{
              fontSize: typography.fontSizeSmall,
              color: palette.textSecondary,
              lineHeight: 1.5,
            }}
          >
            Manage your profile, appearance, audio, and account from one place.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.unit * 3,
            padding: spacing.unit * 3,
            borderRadius: 12,
            backgroundColor: palette.bgPrimary,
            border: `1px solid ${palette.border}`,
          }}
        >
          <UserAvatar
            userId={userId}
            displayName={displayName}
            avatarUrlHint={userAvatarUrl}
            size={44}
            fontSize={18}
          />
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: typography.fontSizeBase,
                fontWeight: typography.fontWeightMedium,
                color: palette.textHeading,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {displayName || "Your account"}
            </div>
            <div
              style={{
                fontSize: typography.fontSizeSmall,
                color: palette.textSecondary,
                marginTop: 2,
              }}
            >
              Personal preferences and voice setup
            </div>
          </div>
        </div>

        <nav
          style={{
            display: "flex",
            flexDirection: "column",
            gap: spacing.unit,
          }}
        >
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                style={{
                  width: "100%",
                  padding: `${spacing.unit * 2}px ${spacing.unit * 2.5}px`,
                  borderRadius: 12,
                  border: `1px solid ${isActive ? palette.accent : palette.border}`,
                  backgroundColor: isActive ? palette.bgActive : "transparent",
                  color: isActive ? palette.textHeading : palette.textSecondary,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: spacing.unit * 2,
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 10,
                    backgroundColor: isActive ? palette.accent : palette.bgTertiary,
                    color: isActive ? "#fff" : palette.textSecondary,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <Icon size={16} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: typography.fontSizeBase,
                      fontWeight: typography.fontWeightMedium,
                      color: isActive ? palette.textHeading : palette.textPrimary,
                    }}
                  >
                    {item.label}
                  </div>
                  <div
                    style={{
                      fontSize: typography.fontSizeSmall,
                      color: palette.textSecondary,
                      marginTop: 2,
                    }}
                  >
                    {item.description}
                  </div>
                </span>
              </button>
            );
          })}
        </nav>
      </aside>

      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflowY: "auto",
        }}
      >
        <div
          style={{
            maxWidth: 760,
            margin: "0 auto",
            padding: spacing.unit * 6,
            display: "flex",
            flexDirection: "column",
            gap: spacing.unit * 4,
          }}
        >
          <header
            style={{
              ...panelStyle,
              background: `linear-gradient(180deg, ${palette.bgSecondary} 0%, ${palette.bgPrimary} 100%)`,
            }}
          >
            <div
              style={{
                fontSize: typography.fontSizeSmall,
                fontWeight: typography.fontWeightMedium,
                color: palette.textSecondary,
                textTransform: "uppercase",
                letterSpacing: 0.6,
                marginBottom: spacing.unit * 1.5,
              }}
            >
              Settings
            </div>
            <h2 style={sectionHeadingStyle}>{activeNavItem.title}</h2>
            <p style={sectionDescriptionStyle}>{activeNavItem.blurb}</p>
          </header>

          {activeSection === "user" && (
            <>
              <section style={panelStyle}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: spacing.unit * 4,
                    flexWrap: "wrap",
                  }}
                >
                  <UserAvatar
                    userId={userId}
                    displayName={displayName}
                    avatarUrlHint={userAvatarUrl}
                    size={84}
                    fontSize={30}
                  />

                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: spacing.unit * 2,
                      minWidth: 240,
                      flex: 1,
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontSize: typography.fontSizeBase,
                          fontWeight: typography.fontWeightBold,
                          color: palette.textHeading,
                        }}
                      >
                        Profile photo
                      </div>
                      <div
                        style={{
                          marginTop: spacing.unit,
                          fontSize: typography.fontSizeSmall,
                          color: palette.textSecondary,
                          lineHeight: 1.5,
                        }}
                      >
                        Upload an avatar so you are easier to recognize in chats and voice rooms.
                      </div>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: spacing.unit * 2,
                        flexWrap: "wrap",
                      }}
                    >
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
                      e.target.value = "";
                    }}
                  />
                </div>
              </section>

              <section style={panelStyle}>
                <h3 style={sectionHeadingStyle}>Display name</h3>
                <p style={{ ...sectionDescriptionStyle, marginBottom: spacing.unit * 3 }}>
                  This is the name other people will see around the app.
                </p>
                <div>
                  <div style={fieldLabelStyle}>Display Name</div>
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
                        style={{ ...textInputStyle, flex: 1 }}
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
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: spacing.unit * 3,
                        padding: spacing.unit * 3,
                        backgroundColor: palette.bgTertiary,
                        border: `1px solid ${palette.border}`,
                        borderRadius: 12,
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontSize: typography.fontSizeBase,
                            fontWeight: typography.fontWeightMedium,
                            color: palette.textPrimary,
                          }}
                        >
                          {displayName || "Not set"}
                        </div>
                        <div
                          style={{
                            marginTop: spacing.unit / 2,
                            fontSize: typography.fontSizeSmall,
                            color: palette.textSecondary,
                          }}
                        >
                          Keep it simple and recognizable for spaces and DMs.
                        </div>
                      </div>
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
            </>
          )}

          {activeSection === "appearance" && (
            <section style={panelStyle}>
              <h3 style={sectionHeadingStyle}>Appearance</h3>
              <p style={{ ...sectionDescriptionStyle, marginBottom: spacing.unit * 4 }}>
                Color mode picks whether the app uses light colors, dark colors, or follows your system.
                Each theme stores a matching pair of light and dark palettes; switching mode swaps which
                pair is active.
              </p>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: spacing.unit * 3,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: spacing.unit * 2,
                    padding: spacing.unit * 3,
                    borderRadius: 12,
                    backgroundColor: palette.bgTertiary,
                    border: `1px solid ${palette.border}`,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: typography.fontSizeBase,
                        fontWeight: typography.fontWeightMedium,
                        color: palette.textPrimary,
                      }}
                    >
                      Color mode
                    </div>
                    <div
                      style={{
                        marginTop: spacing.unit / 2,
                        fontSize: typography.fontSizeSmall,
                        color: palette.textSecondary,
                      }}
                    >
                      System is the default and tracks light or dark from your OS.
                    </div>
                  </div>
                  <ColorModeControl />
                </div>

                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: spacing.unit * 2,
                    padding: spacing.unit * 3,
                    borderRadius: 12,
                    backgroundColor: palette.bgTertiary,
                    border: `1px solid ${palette.border}`,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: typography.fontSizeBase,
                        fontWeight: typography.fontWeightMedium,
                        color: palette.textPrimary,
                      }}
                    >
                      Theme
                    </div>
                    <div
                      style={{
                        marginTop: spacing.unit / 2,
                        fontSize: typography.fontSizeSmall,
                        color: palette.textSecondary,
                      }}
                    >
                      Each preview shows dark and light primary backgrounds. Color mode still picks which
                      side matches the app right now.
                    </div>
                  </div>
                  <ThemeSelector />
                </div>

                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: spacing.unit * 2,
                    padding: spacing.unit * 3,
                    borderRadius: 12,
                    backgroundColor: palette.bgTertiary,
                    border: `1px solid ${palette.border}`,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: typography.fontSizeBase,
                        fontWeight: typography.fontWeightMedium,
                        color: palette.textPrimary,
                      }}
                    >
                      When closing the window
                    </div>
                    <div
                      style={{
                        marginTop: spacing.unit / 2,
                        fontSize: typography.fontSizeSmall,
                        color: palette.textSecondary,
                      }}
                    >
                      Applies when you click the window close button. You can always quit from the
                      system tray menu.
                    </div>
                  </div>
                  <select
                    value={closeWindowBehavior ?? "ask"}
                    onChange={(e) =>
                      handleCloseWindowBehaviorChange(
                        e.target.value as "ask" | "minimize_tray" | "quit",
                      )
                    }
                    disabled={closeWindowBehavior === null}
                    style={{
                      ...textInputStyle,
                      cursor: closeWindowBehavior === null ? "default" : "pointer",
                      opacity: closeWindowBehavior === null ? 0.6 : 1,
                    }}
                  >
                    <option value="ask">Always ask</option>
                    <option value="minimize_tray">Minimize to tray</option>
                    <option value="quit">Quit completely</option>
                  </select>
                </div>
              </div>
            </section>
          )}

          {activeSection === "audio" && (
            <section style={panelStyle}>
              <h3 style={sectionHeadingStyle}>Voice preferences</h3>
              <p style={{ ...sectionDescriptionStyle, marginBottom: spacing.unit * 4 }}>
                Configure your default input and output devices, plus noise suppression tuning.
              </p>
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
          )}

          {activeSection === "notifications" && (
            <section style={panelStyle}>
              <NotificationSettingsPanel scope="global" />

              <div
                style={{
                  height: 1,
                  backgroundColor: palette.border,
                  margin: `${spacing.unit * 5}px 0`,
                }}
              />

              <h3 style={sectionHeadingStyle}>Read receipts</h3>
              <p style={{ ...sectionDescriptionStyle, marginBottom: spacing.unit * 4 }}>
                Pax always tracks what you&rsquo;ve read so rooms with new messages stand out in
                the sidebar &mdash; this setting controls whether that information is shared with
                other users, not whether it&rsquo;s tracked.
              </p>
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: spacing.unit * 2,
                  padding: `${spacing.unit * 2.5}px ${spacing.unit * 3}px`,
                  borderRadius: 8,
                  border: `1px solid ${palette.border}`,
                  backgroundColor: palette.bgTertiary,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={sendPublicReceipts}
                  onChange={(e) => handleToggleSendPublicReceipts(e.target.checked)}
                  style={{
                    accentColor: palette.accent,
                    width: 16,
                    height: 16,
                    marginTop: 2,
                    cursor: "pointer",
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: typography.fontSizeSmall,
                      fontWeight: typography.fontWeightMedium,
                      color: palette.textHeading,
                    }}
                  >
                    Send read receipts to others
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: palette.textSecondary,
                      marginTop: spacing.unit,
                      lineHeight: 1.4,
                    }}
                  >
                    When enabled, other Matrix users can see which messages you&rsquo;ve read
                    (the small avatar indicators in clients like Element).  When disabled
                    (the default), your read state still syncs across your own devices and
                    clears your unread counts, but is kept private from other users.
                  </div>
                </div>
              </label>
            </section>
          )}

          {activeSection === "account" && (
            <section style={panelStyle}>
              <h3 style={sectionHeadingStyle}>Session</h3>
              <p style={{ ...sectionDescriptionStyle, marginBottom: spacing.unit * 4 }}>
                Sign out of your current account on this device.
              </p>
              <div
                style={{
                  padding: spacing.unit * 3,
                  borderRadius: 12,
                  backgroundColor: palette.bgTertiary,
                  border: `1px solid ${palette.border}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: spacing.unit * 3,
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: typography.fontSizeBase,
                      fontWeight: typography.fontWeightMedium,
                      color: palette.textPrimary,
                    }}
                  >
                    Sign out
                  </div>
                  <div
                    style={{
                      marginTop: spacing.unit / 2,
                      fontSize: typography.fontSizeSmall,
                      color: palette.textSecondary,
                    }}
                  >
                    You can sign back in again at any time.
                  </div>
                </div>
                <button
                  onClick={onSignOut}
                  style={{
                    ...smallBtn,
                    color: "#f23f43",
                    borderColor: "rgba(242,63,67,0.35)",
                  }}
                >
                  <LogOut size={14} />
                  Sign out
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}