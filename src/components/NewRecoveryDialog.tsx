import { useId, useState } from "react";
import { useEncryption } from "../context/EncryptionContext";
import { useTheme } from "../theme/ThemeContext";
import Dialog from "./Dialog";

export default function NewRecoveryDialog({ onClose }: { onClose: () => void }) {
  const encryption = useEncryption();
  const { palette } = useTheme();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const pending = encryption.status?.newRecoveryPending;
  const busy = !!encryption.busy;
  const button = { padding: "9px 14px", borderRadius: 8, border: `1px solid ${palette.border}`,
    background: palette.bgTertiary, color: palette.textPrimary, font: "inherit", cursor: busy ? "wait" : "pointer" };
  return <Dialog onClose={() => { if (!busy) onClose(); }} aria-labelledby={`${id}-title`} style={{ width: 460, padding: 24 }}>
    <form style={{ display: "grid", gap: 16, lineHeight: 1.5 }} onSubmit={(e) => {
      e.preventDefault(); setError(null);
      void encryption.startRecoveryFromDevice(password).then(() => { setPassword(""); onClose(); }).catch((e) => setError(String(e)));
    }}>
      <h2 id={`${id}-title`} style={{ margin: 0, fontSize: 20 }}>{pending ? "Finish recovery setup" : "Set up recovery from this device"}</h2>
      <p style={{ margin: 0 }}>Use this when you cannot retrieve the missing keys from another device.</p>
      <p style={{ margin: 0 }}>Pax will protect the encrypted history this device can currently decrypt.
        It cannot recover messages whose keys are missing. Older server backups are kept, but this action cannot unlock them.</p>
      <p style={{ margin: 0 }}>If the account’s verification keys are missing, its encryption identity will change.
        Other devices and people may need to verify you again. Your account and rooms stay the same.</p>
      {pending && <p style={{ margin: 0 }}>An earlier setup was interrupted. Continue on this device to finish it.</p>}
      <label htmlFor={`${id}-password`}>Current Matrix password</label>
      <input id={`${id}-password`} type="password" autoComplete="current-password" required value={password} disabled={busy}
        onChange={(e) => setPassword(e.target.value)} style={{ padding: "10px 12px", borderRadius: 8,
          border: `1px solid ${palette.border}`, background: palette.bgPrimary, color: palette.textPrimary, font: "inherit" }} />
      {error && <p role="alert" style={{ margin: 0, color: "#f23f43" }}>{error}</p>}
      <div style={{ display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 10 }}>
        <button type="button" disabled={busy} style={button} onClick={onClose}>Cancel</button>
        <button type="submit" disabled={busy || !password} style={{ ...button, background: palette.accent, color: "#fff" }}>
          {busy ? "Setting up recovery…" : pending ? "Finish setup" : "Create recovery from this device"}
        </button>
      </div>
    </form>
  </Dialog>;
}
