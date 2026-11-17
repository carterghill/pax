import { useId, useState, type CSSProperties, type FormEvent } from "react";
import { useTheme } from "../theme/ThemeContext";

/** Shared by Account settings and the exceptional interrupted-login repair. */
export default function PaxConversionForm({ pending, busy, error, onSubmit, onClose }: {
  pending: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: (currentPassword: string, newPassword: string) => Promise<void>;
  onClose: () => void;
}) {
  const { palette } = useTheme();
  const id = useId();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const input: CSSProperties = { width: "100%", boxSizing: "border-box", padding: "10px 12px", marginTop: 6,
    border: `1px solid ${palette.border}`, borderRadius: 8, background: palette.bgPrimary, color: palette.textPrimary, font: "inherit" };
  const button: CSSProperties = { padding: "9px 14px", borderRadius: 8, border: `1px solid ${palette.border}`,
    background: palette.bgTertiary, color: palette.textPrimary, font: "inherit", cursor: busy ? "wait" : "pointer" };
  async function submit(event: FormEvent) {
    event.preventDefault();
    setValidation(null);
    if (Array.from(newPassword).length < 12) { setValidation("Choose a Pax password of at least 12 characters."); return; }
    if (newPassword !== confirm) { setValidation("The new passwords do not match."); return; }
    if (newPassword === oldPassword) { setValidation("Choose a different password from your current Matrix password."); return; }
    try {
      await onSubmit(oldPassword, newPassword);
      setOldPassword(""); setNewPassword(""); setConfirm("");
    } catch { /* The parent owns operation errors; keep inputs for a retry. */ }
  }
  return (
    <form onSubmit={(e) => void submit(e)} style={{ display: "grid", gap: 16, lineHeight: 1.5 }}>
      <h2 id="pax-conversion-title" style={{ margin: 0, fontSize: 20 }}>{pending ? "Finish switching to Pax sign-in" : "Switch to Pax sign-in"}</h2>
      <p style={{ margin: 0, color: palette.textSecondary }}>
        {pending ? "Enter the same new Pax password you chose when you started. If the password change has already completed, your old password can be left blank."
          : "Your new Pax password will sign you in and unlock your backed-up encrypted history on other computers. Pax creates and protects the recovery key for you."}
      </p>
      {!pending && <p style={{ margin: 0, color: palette.textSecondary }}>
        Your account, rooms, and encryption identity stay the same. Only history with available message keys can be restored;
        this cannot recover keys you have already lost. Other Matrix apps will require a different underlying password,
        which Pax cannot export yet. Switching back to Standard Matrix sign-in is not available yet.
        Keep your old recovery key if you have one.
      </p>}
      <label htmlFor={`${id}-old`}>{pending ? "Old Matrix password (if still needed)" : "Current Matrix password"}
        <input id={`${id}-old`} type="password" autoComplete="current-password" value={oldPassword} required={!pending}
          disabled={busy} onChange={(e) => setOldPassword(e.target.value)} style={input} />
      </label>
      <label htmlFor={`${id}-new`}>{pending ? "Your new Pax password" : "New Pax password"}
        <input id={`${id}-new`} type="password" autoComplete={pending ? "current-password" : "new-password"} value={newPassword}
          required disabled={busy} onChange={(e) => setNewPassword(e.target.value)} style={input} />
      </label>
      <label htmlFor={`${id}-confirm`}>Confirm Pax password
        <input id={`${id}-confirm`} type="password" autoComplete="new-password" value={confirm}
          required disabled={busy} onChange={(e) => setConfirm(e.target.value)} style={input} />
      </label>
      <p style={{ margin: 0, color: palette.textSecondary, fontSize: 13 }}>
        Use a strong, unique password of at least 12 characters. If you forget it and lose access to all unlocked devices,
        your encrypted history may be lost. Keep Pax open until the switch finishes; retry with this same new password if interrupted.
      </p>
      {(validation || error) && <p role="alert" style={{ margin: 0, color: "#f23f43" }}>{validation || error}</p>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <button type="button" disabled={busy} onClick={onClose} style={button}>Close</button>
        <button type="submit" disabled={busy} style={{ ...button, background: palette.accent, color: "#fff", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Switching sign-in…" : pending ? "Finish switching" : "Switch to Pax sign-in"}
        </button>
      </div>
    </form>
  );
}
