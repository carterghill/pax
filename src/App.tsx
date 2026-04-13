import "./App.css";
import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import MainLayout from "./layouts/MainLayout";
import { useTheme } from "./theme/ThemeContext";
import { useRooms } from "./hooks/useRooms";
import { clearMessageCache } from "./hooks/useMessages";
import { clearPersistedSpaceHomeCache } from "./utils/spaceHomeCache";
import { clearPersistedRoomsList } from "./utils/roomsCache";
import { useExternalLinkInterceptor } from "./hooks/useExternalLinks";

interface AuthConfig {
  default_homeserver: string | null;
  registration_token: string | null;
  hide_server_config: boolean;
}

function App() {
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();

  useEffect(() => {
    const root = document.getElementById("root");
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
      logo: {
        width: 80,
        height: 80,
        marginBottom: spacing.unit,
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

  const {
    spaces,
    roomsBySpace,
    getRoom,
    fetchRooms,
    upsertOptimisticRoom,
    initialLoadComplete,
  } = useRooms(userId);

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
  }

  if (userId && !initialLoadComplete) {
    return (
      <div style={authStyles.container}>
        <img src="/logoIris.png" alt="Pax" style={authStyles.logo} />
        <p style={authStyles.signingIn}>Loading rooms...</p>
      </div>
    );
  }

  if (userId) {
    return (
      <MainLayout
        userId={userId}
        onSignOut={handleSignOut}
        rooms={{ spaces, roomsBySpace, getRoom, fetchRooms, upsertOptimisticRoom }}
      />
    );
  }

  if (autoLoggingIn) {
    return (
      <div style={authStyles.container}>
        <img src="/logoIris.png" alt="Pax" style={authStyles.logo} />
        <p style={authStyles.signingIn}>Signing in...</p>
      </div>
    );
  }

  return (
    <div style={authStyles.container}>
      <img src="/logoIris.png" alt="Pax" style={authStyles.logo} />

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
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && tab === "login") handleLogin();
          }}
        />
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
  );
}

export default App;