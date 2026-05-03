import "./App.css";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import MainLayout from "./layouts/MainLayout";
import { UserAvatarStoreProvider } from "./context/UserAvatarStore";
import { RoomDownloadsProvider } from "./context/RoomDownloadsContext";
import { useTheme } from "./theme/ThemeContext";
import { useRooms } from "./hooks/useRooms";
import { clearMessageCache } from "./hooks/useMessages";
import { clearPersistedSpaceHomeCache } from "./utils/spaceHomeCache";
import { clearPersistedRoomsList } from "./utils/roomsCache";
import { useExternalLinkInterceptor } from "./hooks/useExternalLinks";
import { listen } from "@tauri-apps/api/event";
import QuitConfirmDialog from "./components/QuitConfirmDialog";
import { homeserverUrlToHostname, sanitizeSignupUsernameInput } from "./utils/matrix";
import { usePushNotifications } from "./hooks/usePushNotifications";

if (import.meta.env.DEV) {
  const w = window as unknown as { invoke: typeof invoke; listen: typeof listen };
  w.invoke = invoke;
  w.listen = listen;
}

interface AuthConfig {
  default_homeserver: string | null;
  registration_token: string | null;
  hide_server_config: boolean;
}

function App() {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();

  useEffect(() => {
    const root = document.getElementById("root");
    document.documentElement.style.backgroundColor = palette.bgPrimary;
    document.body.style.backgroundColor = palette.bgPrimary;
    document.body.style.color = palette.textPrimary;
    document.body.style.fontFamily = typography.fontFamily;
    document.body.style.fontSize = `${typography.fontSizeBase}px`;
    if (root) {
      root.style.backgroundColor = palette.bgPrimary;
      root.style.color = palette.textPrimary;
    }
  }, [palette.bgPrimary, palette.textPrimary, typography.fontFamily, typography.fontSizeBase]);

  const authStyles = useMemo(
    () => ({
      container: {
        display: "flex",
        flexDirection: "column" as const,
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        width: "100%",
        padding: spacing.unit * 5,
        gap: spacing.unit * 4,
        backgroundColor: palette.bgPrimary,
        color: palette.textPrimary,
        fontFamily: typography.fontFamily,
      },
      logoWrap: {
        width: 80,
        height: 80,
        borderRadius: "50%",
        backgroundColor: palette.accent,
        marginBottom: spacing.unit,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      },
      logoImg: {
        width: "100%",
        height: "100%",
        objectFit: "contain" as const,
        display: "block",
      },
      signingIn: {
        color: palette.textSecondary,
        fontSize: typography.fontSizeBase,
      },
      tabRow: {
        display: "flex",
        gap: 0,
        borderRadius: spacing.unit * 2,
        overflow: "hidden",
        border: `1px solid ${palette.border}`,
      },
      tab: {
        padding: `${spacing.unit * 2}px ${spacing.unit * 6}px`,
        background: "transparent",
        color: palette.textSecondary,
        border: "none",
        cursor: "pointer",
        fontSize: typography.fontSizeBase,
        fontWeight: typography.fontWeightMedium,
        transition: "background 0.15s, color 0.15s",
      },
      tabActive: {
        padding: `${spacing.unit * 2}px ${spacing.unit * 6}px`,
        background: palette.accent,
        color: "#fff",
        border: "none",
        cursor: "pointer",
        fontSize: typography.fontSizeBase,
        fontWeight: typography.fontWeightBold,
      },
      form: {
        display: "flex",
        flexDirection: "column" as const,
        gap: spacing.unit * 2 + spacing.unit / 2,
        width: "100%",
        maxWidth: 340,
      },
      input: {
        padding: `${spacing.unit * 2 + spacing.unit / 2}px ${spacing.unit * 3}px`,
        borderRadius: spacing.unit * 1.5,
        border: `1px solid ${palette.border}`,
        background: palette.bgTertiary,
        color: palette.textPrimary,
        fontSize: typography.fontSizeBase,
        outline: "none",
      },
      checkboxLabel: {
        display: "flex",
        alignItems: "center",
        gap: spacing.unit * 2,
        cursor: "pointer",
        color: palette.textSecondary,
        fontSize: typography.fontSizeSmall,
      },
      button: {
        padding: `${spacing.unit * 2 + spacing.unit / 2}px`,
        borderRadius: spacing.unit * 1.5,
        border: "none",
        background: palette.accent,
        color: "#fff",
        fontSize: typography.fontSizeBase,
        fontWeight: typography.fontWeightBold,
        cursor: "pointer",
        marginTop: spacing.unit,
        transition: "background-color 0.15s, opacity 0.15s",
      },
      error: {
        color: resolvedColorScheme === "dark" ? "#f38ba8" : "#c62828",
        fontSize: typography.fontSizeSmall,
        textAlign: "center" as const,
        marginTop: spacing.unit,
      },
      usernameHint: {
        color: palette.textSecondary,
        fontSize: typography.fontSizeSmall,
        lineHeight: 1.45,
        margin: 0,
      },
      usernamePreview: {
        color: palette.textSecondary,
        fontSize: typography.fontSizeSmall,
        lineHeight: 1.45,
        margin: 0,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        wordBreak: "break-all" as const,
      },
    }),
    [palette, typography, spacing, resolvedColorScheme],
  );

  const [homeserver, setHomeserver] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [registrationToken, setRegistrationToken] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const autoLoginAttemptedRef = useRef(false);
  const syncStartedRef = useRef(false);
  const [autoLoggingIn, setAutoLoggingIn] = useState(true);

  const [tab, setTab] = useState<"login" | "signup">("login");
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [quitConfirmOpen, setQuitConfirmOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen("app-close-request", async () => {
      try {
        const pref = await invoke<string | null>("get_close_window_preference");
        if (pref === "minimize_tray") {
          await invoke("hide_main_window");
          return;
        }
        if (pref === "quit") {
          await invoke("exit_app");
          return;
        }
      } catch (e) {
        console.error(e);
      }
      if (!cancelled) setQuitConfirmOpen(true);
    }).then((fn) => {
      if (!cancelled) unlisten = fn;
      else fn();
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Open all external (http/https) link clicks in the system browser.
  useExternalLinkInterceptor();

  // Fetch auth config from backend (env-driven defaults)
  useEffect(() => {
    invoke<AuthConfig>("get_auth_config").then((cfg) => {
      setAuthConfig(cfg);
      if (cfg.default_homeserver) {
        setHomeserver(cfg.default_homeserver);
      }
      if (cfg.registration_token) {
        setRegistrationToken(cfg.registration_token);
      }
    }).catch(() => {
      setAuthConfig({ default_homeserver: null, registration_token: null, hide_server_config: false });
    });
  }, []);

  // Whether to hide the homeserver + token fields
  const hideServerConfig =
    authConfig?.hide_server_config &&
    !!authConfig.default_homeserver &&
    (tab === "login" || !!authConfig.registration_token);

  async function handleLogin() {
    setLoading(true);
    setError(null);
    try {
      // No credentials file access before the server accepts login; optional persist after success.
      const id = await invoke<string>("login", {
        homeserver,
        username,
        password,
        persistSession: rememberMe,
      });
      if (!syncStartedRef.current) {
        syncStartedRef.current = true;
        await invoke("start_sync");
      }
      setUserId(id);
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  }

  async function handleRegister() {
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (!password) {
      setError("Password is required");
      return;
    }
    if (!username) {
      setError("Username is required");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await invoke("save_credentials", { homeserver });
      const id = await invoke<string>("register", {
        homeserver,
        username,
        password,
        registrationToken,
      });
      if (!syncStartedRef.current) {
        syncStartedRef.current = true;
        await invoke("start_sync");
      }
      setUserId(id);
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  }

  async function handleSignOut() {
    try {
      await invoke("logout");
      await invoke("clear_saved_credentials");
    } catch {
      // Ignore errors during sign out
    }
    syncStartedRef.current = false;
    clearMessageCache();
    clearPersistedSpaceHomeCache();
    clearPersistedRoomsList();
    setUserId(null);
  }

  useEffect(() => {
    if (autoLoginAttemptedRef.current || userId || !authConfig) return;
    autoLoginAttemptedRef.current = true;

    (async () => {
      try {
        const id = await invoke<string>("restore_session");
        if (!syncStartedRef.current) {
          syncStartedRef.current = true;
          invoke("start_sync");
        }
        setUserId(id);
        return;
      } catch {
        // No saved session or token expired — show login screen
      }

      try {
        const creds = await invoke<{ homeserver: string } | null>("load_credentials");
        if (creds) {
          // Only restore the saved homeserver if no compile-time default is
          // configured — PAX_HOMESERVER is the source of truth when set.
          if (!authConfig?.default_homeserver) {
            setHomeserver(creds.homeserver);
          }
          setRememberMe(true);
        }
      } catch {
        // No saved credentials
      }
    })().finally(() => {
      setAutoLoggingIn(false);
    });
  }, [userId, authConfig]);

  function switchTab(newTab: "login" | "signup") {
    setTab(newTab);
    setError(null);
    if (newTab === "signup") {
      setUsername((u) => sanitizeSignupUsernameInput(u));
    }
  }

  const signupHomeserverHost = useMemo(
    () => (tab === "signup" ? homeserverUrlToHostname(homeserver) : null),
    [tab, homeserver],
  );

  const quitOverlay =
    quitConfirmOpen ? (
      <QuitConfirmDialog onClose={() => setQuitConfirmOpen(false)} />
    ) : null;

  if (userId) {
    // `useRooms` primes the `UserAvatarStore` from the get_rooms
    // response, so it MUST run inside `<UserAvatarStoreProvider>` —
    // `useUserAvatarStoreOptional()` in App's own scope returns null
    // (the provider doesn't exist yet at that level) and the
    // priming path silently no-ops. Split out into a child
    // component so hooks run in the right context.
    return (
      <>
        <UserAvatarStoreProvider>
          <RoomDownloadsProvider>
            <AuthedApp
              userId={userId}
              onSignOut={handleSignOut}
              loadingStyles={authStyles}
            />
          </RoomDownloadsProvider>
        </UserAvatarStoreProvider>
        {quitOverlay}
      </>
    );
  }

  if (autoLoggingIn) {
    return (
      <>
        <div style={authStyles.container}>
          <div style={authStyles.logoWrap}>
            <img src="/logoIrisWhite.png" alt="Pax" style={authStyles.logoImg} />
          </div>
          <p style={authStyles.signingIn}>Signing in...</p>
        </div>
        {quitOverlay}
      </>
    );
  }

  return (
    <>
    <div style={authStyles.container}>
      <div style={authStyles.logoWrap}>
        <img src="/logoIrisWhite.png" alt="Pax" style={authStyles.logoImg} />
      </div>

      {/* Tab switcher */}
      <div style={authStyles.tabRow}>
        <button
          type="button"
          style={tab === "login" ? authStyles.tabActive : authStyles.tab}
          onClick={() => switchTab("login")}
        >
          Login
        </button>
        <button
          type="button"
          style={tab === "signup" ? authStyles.tabActive : authStyles.tab}
          onClick={() => switchTab("signup")}
        >
          Sign Up
        </button>
      </div>

      <div style={authStyles.form}>
        {/* Homeserver — hidden when env says so */}
        {!hideServerConfig && (
          <input
            style={authStyles.input}
            placeholder="Homeserver URL"
            value={homeserver}
            onChange={(e) => setHomeserver(e.target.value)}
          />
        )}

        <input
          style={authStyles.input}
          placeholder={
            tab === "signup"
              ? "Username (one word — e.g. janedoe)"
              : "Username"
          }
          value={username}
          onChange={(e) =>
            setUsername(
              tab === "signup"
                ? sanitizeSignupUsernameInput(e.target.value)
                : e.target.value,
            )
          }
          onKeyDown={(e) => {
            if (tab === "signup" && e.key === " ") {
              e.preventDefault();
              return;
            }
            if (e.key === "Enter" && tab === "login") handleLogin();
          }}
        />
        {tab === "signup" && (
          <>
            <p style={authStyles.usernameHint}>
              One word, lowercased as you type. Space is disabled; only letters, numbers, and{" "}
              <span style={authStyles.usernamePreview}>. _ = - /</span> are kept.
            </p>
            {username ? (
              <p style={authStyles.usernamePreview}>
                Your account ID: @{username}:{signupHomeserverHost ?? "your-homeserver"}
              </p>
            ) : null}
          </>
        )}
        <input
          style={authStyles.input}
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && tab === "login") handleLogin();
          }}
        />

        {tab === "signup" && (
          <>
            <input
              style={authStyles.input}
              type="password"
              placeholder="Confirm Password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRegister();
              }}
            />
            {/* Registration token — hidden when env says so */}
            {!hideServerConfig && (
              <input
                style={authStyles.input}
                placeholder="Registration Token (if required)"
                value={registrationToken}
                onChange={(e) => setRegistrationToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRegister();
                }}
              />
            )}
          </>
        )}

        {tab === "login" && (
          <label style={authStyles.checkboxLabel}>
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
            />
            <span>Remember me</span>
          </label>
        )}

        <button
          type="button"
          style={{
            ...authStyles.button,
            opacity: loading ? 0.7 : 1,
            cursor: loading ? "default" : "pointer",
          }}
          onClick={() => (tab === "login" ? handleLogin() : handleRegister())}
          disabled={loading}
          onMouseEnter={(e) => {
            if (!loading) e.currentTarget.style.backgroundColor = palette.accentHover;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = palette.accent;
          }}
        >
          {loading
            ? tab === "login"
              ? "Logging in..."
              : "Creating account..."
            : tab === "login"
              ? "Login"
              : "Create Account"}
        </button>

        {error && <p style={authStyles.error}>{error}</p>}
      </div>
    </div>
    {quitOverlay}
    </>
  );
}

type LoadingStyles = {
  container: React.CSSProperties;
  logoWrap: React.CSSProperties;
  logoImg: React.CSSProperties;
  signingIn: React.CSSProperties;
};

/**
 * Authenticated-session shell.
 *
 * This component exists so `useRooms` runs inside
 * `<UserAvatarStoreProvider>` — the provider is rendered by `App`,
 * which means hooks in `App` itself live *outside* the provider's
 * context. Without this split, `useUserAvatarStoreOptional()` in
 * `useRooms` returns null and the `primeDmPeerAvatars` fast-path
 * silently does nothing; every DM avatar then has to go through the
 * `requestFetch` fallback, which causes the frame-or-two initials
 * flash on every warm restart.
 */
function AuthedApp({
  userId,
  onSignOut,
  loadingStyles,
}: {
  userId: string;
  onSignOut: () => void;
  loadingStyles: LoadingStyles;
}) {
  const {
    spaces,
    roomsBySpace,
    getRoom,
    fetchRooms,
    upsertOptimisticRoom,
    initialLoadComplete,
  } = useRooms(userId);

  // Register FCM push token with the homeserver (Android only; no-op on desktop).
  const { unregisterPush } = usePushNotifications({ userId });

  // Wrap the sign-out handler to unregister the pusher first.
  const handleSignOut = useCallback(async () => {
    await unregisterPush();
    onSignOut();
  }, [onSignOut, unregisterPush]);

  if (!initialLoadComplete) {
    return (
      <div style={loadingStyles.container}>
        <div style={loadingStyles.logoWrap}>
          <img src="/logoIrisWhite.png" alt="Pax" style={loadingStyles.logoImg} />
        </div>
        <p style={loadingStyles.signingIn}>Loading rooms...</p>
      </div>
    );
  }

  return (
    <MainLayout
      userId={userId}
      onSignOut={handleSignOut}
      rooms={{ spaces, roomsBySpace, getRoom, fetchRooms, upsertOptimisticRoom }}
    />
  );
}

export default App;