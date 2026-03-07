import "./App.css";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import MainLayout from "./layouts/MainLayout";

function App() {
  const [homeserver, setHomeserver] = useState("https://matrix.currdurr.duckdns.org");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  // const [rooms, setRooms] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    setLoading(true);
    setError(null);
    try {
      const id = await invoke<string>("login", { homeserver, username, password });
      setUserId(id);
      // const roomList = await invoke<any[]>("get_rooms");
      // setRooms(roomList);
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  }

  if (userId) {
    return (
      <MainLayout userId={userId} />
      // <div style={{ padding: "20px" }}>
      //   <h2>Logged in as {userId}</h2>
      //   <h3>Rooms ({rooms.length})</h3>
      //   <ul>
      //     {rooms.map((room) => (
      //       <li key={room.id}>{room.name} <small>({room.id})</small></li>
      //     ))}
      //   </ul>
      // </div>
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
        <button onClick={handleLogin} disabled={loading}>
          {loading ? "Logging in..." : "Login"}
        </button>
        {error && <p style={{ color: "red" }}>{error}</p>}
      </div>
    </div>
  );
}

export default App;