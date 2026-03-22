import "./App.css";
import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import MainLayout from "./layouts/MainLayout";
import { ThemeProvider } from "./theme/ThemeContext";
import { clearMessageCache } from "./hooks/useMessages";

function App() {
  const [homeserver, setHomeserver] = useState("https://matrix.currdurr.duckdns.org");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const autoLoginAttemptedRef = useRef(false);
  const syncStartedRef = useRef(false);
  const [autoLoggingIn, setAutoLoggingIn] = useState(true);

  async function handleLogin(remember: boolean = rememberMe) {
    setLoading(true);
    setError(null);
    try {
      const id = await invoke<string>("login", { homeserver, username, password });
      if (!syncStartedRef.current) {
        syncStartedRef.current = true;
        await invoke("start_sync");
      }
      setUserId(id);
      if (remember) {
        // Only persist the homeserver URL — session tokens are saved
        // separately by the Rust backend after successful login.
        await invoke("save_credentials", { homeserver });
      }
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
    setUserId(null);
  }

  useEffect(() => {
    if (autoLoginAttemptedRef.current || userId) return;
    autoLoginAttemptedRef.current = true;

    (async () => {
      // Restore a previous session from SQLite store (no password needed).
      // If the token has expired, the user will see the login screen.
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

      // Pre-fill the homeserver field if we have saved credentials
      try {
        const creds = await invoke<{ homeserver: string } | null>("load_credentials");
        if (creds) {
          setHomeserver(creds.homeserver);
          setRememberMe(true);
        }
      } catch {
        // No saved credentials
      }
    })().finally(() => {
      setAutoLoggingIn(false);
    });
  }, [userId]);

  if (userId) {
    return (
      <ThemeProvider>
        <MainLayout userId={userId} onSignOut={handleSignOut} />
      </ThemeProvider>
    );
  }

  if (autoLoggingIn) {
    return (
      <div style={{ padding: "20px", maxWidth: "400px", margin: "0 auto", textAlign: "center" }}>
        <h1>Pax</h1>
        <p>Signing in...</p>
      </div>
    );
  }

  return (
    <div style={{ padding: "20px", maxWidth: "400px", margin: "0 auto" }}>
      <h1>Pax</h1>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <input
          placeholder="Homeserver URL"
          value={homeserver}
          onChange={(e) => setHomeserver(e.target.value)}
        />
        <input
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
          />
          <span>Remember me</span>
        </label>
        <button onClick={() => handleLogin()} disabled={loading}>
          {loading ? "Logging in..." : "Login"}
        </button>
        {error && <p style={{ color: "red" }}>{error}</p>}
      </div>
    </div>
  );
}

export default App;