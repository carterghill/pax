import "./App.css";
import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import MainLayout from "./layouts/MainLayout";
import { ThemeProvider } from "./theme/ThemeContext";
import { useRooms } from "./hooks/useRooms";
import { clearMessageCache } from "./hooks/useMessages";
import { clearPersistedSpaceHomeCache } from "./utils/spaceHomeCache";
import { useExternalLinkInterceptor } from "./hooks/useExternalLinks";

interface AuthConfig {
  default_homeserver: string | null;
  registration_token: string | null;
  hide_server_config: boolean;
}

function App() {
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
      <div style={styles.container}>
        <img src="/logoBlurple.png" alt="Pax" style={styles.logo} />
        <p style={styles.signingIn}>Loading rooms...</p>
      </div>
    );
  }

  if (userId) {
    return (
      <ThemeProvider>
        <MainLayout
          userId={userId}
          onSignOut={handleSignOut}
          rooms={{ spaces, roomsBySpace, getRoom, fetchRooms, upsertOptimisticRoom }}
        />
      </ThemeProvider>
    );
  }

  if (autoLoggingIn) {
    return (
      <div style={styles.container}>
        <img src="/logoBlurple.png" alt="Pax" style={styles.logo} />
        <p style={styles.signingIn}>Signing in...</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <img src="/logoBlurple.png" alt="Pax" style={styles.logo} />

      {/* Tab switcher */}
      <div style={styles.tabRow}>
        <button
          style={tab === "login" ? styles.tabActive : styles.tab}
          onClick={() => switchTab("login")}
        >
          Login
        </button>
        <button
          style={tab === "signup" ? styles.tabActive : styles.tab}
          onClick={() => switchTab("signup")}
        >
          Sign Up
        </button>
      </div>

      <div style={styles.form}>
        {/* Homeserver — hidden when env says so */}
        {!hideServerConfig && (
          <input
            style={styles.input}
            placeholder="Homeserver URL"
            value={homeserver}
            onChange={(e) => setHomeserver(e.target.value)}
          />
        )}

        <input
          style={styles.input}
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && tab === "login") handleLogin();
          }}
        />
        <input
          style={styles.input}
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
              style={styles.input}
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
                style={styles.input}
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
          <label style={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
            />
            <span>Remember me</span>
          </label>
        )}

        <button
          style={styles.button}
          onClick={() => (tab === "login" ? handleLogin() : handleRegister())}
          disabled={loading}
        >
          {loading
            ? tab === "login"
              ? "Logging in..."
              : "Creating account..."
            : tab === "login"
              ? "Login"
              : "Create Account"}
        </button>

        {error && <p style={styles.error}>{error}</p>}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    padding: "20px",
    gap: "16px",
  },
  logo: {
    width: "80px",
    height: "80px",
    marginBottom: "4px",
  },
  signingIn: {
    color: "#b5bac1",
    fontSize: "14px",
  },
  tabRow: {
    display: "flex",
    gap: "0px",
    borderRadius: "8px",
    overflow: "hidden",
    border: "1px solid #3f4147",
  },
  tab: {
    padding: "8px 24px",
    background: "transparent",
    color: "#b5bac1",
    border: "none",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 500,
    transition: "background 0.15s, color 0.15s",
  },
  tabActive: {
    padding: "8px 24px",
    background: "#5865f2",
    color: "#fff",
    border: "none",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 600,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    width: "100%",
    maxWidth: "340px",
  },
  input: {
    padding: "10px 12px",
    borderRadius: "6px",
    border: "none",
    background: "#1e1f22",
    color: "#dbdee1",
    fontSize: "14px",
    outline: "none",
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    cursor: "pointer",
    color: "#b5bac1",
    fontSize: "13px",
  },
  button: {
    padding: "10px",
    borderRadius: "6px",
    border: "none",
    background: "#5865f2",
    color: "#fff",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    marginTop: "4px",
  },
  error: {
    color: "#f38ba8",
    fontSize: "13px",
    textAlign: "center" as const,
    marginTop: "4px",
  },
};

export default App;