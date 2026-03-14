import "./App.css";
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import MainLayout from "./layouts/MainLayout";
import { ThemeProvider } from "./theme/ThemeContext";

function App() {
  const [homeserver, setHomeserver] = useState("https://matrix.currdurr.duckdns.org");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoLoginAttempted, setAutoLoginAttempted] = useState(false);
  const [autoLoggingIn, setAutoLoggingIn] = useState(true);

  async function handleLogin(remember: boolean = rememberMe) {
    setLoading(true);
    setError(null);
    try {
      const id = await invoke<string>("login", { homeserver, username, password });
      await invoke("start_sync");
      setUserId(id);
      if (remember) {
        await invoke("save_credentials", { homeserver, username, password });
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
    setUserId(null);
  }

  useEffect(() => {
    if (autoLoginAttempted || userId) return;
    setAutoLoginAttempted(true);
    invoke<{ homeserver: string; username: string; password: string } | null>("load_credentials")
      .then((creds) => {
        if (creds) {
          setHomeserver(creds.homeserver);
          setUsername(creds.username);
          setPassword(creds.password);
          setRememberMe(true);
          return invoke<string>("login", {
            homeserver: creds.homeserver,
            username: creds.username,
            password: creds.password,
          });
        }
        return null;
      })
      .then((id) => {
        if (id) {
          invoke("start_sync");
          setUserId(id);
        }
      })
      .catch(() => {
        // No saved credentials or login failed
      })
      .finally(() => {
        setAutoLoggingIn(false);
      });
  }, [autoLoginAttempted, userId]);

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
