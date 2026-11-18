import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useEncryption } from "../context/EncryptionContext";
import { useTheme } from "../theme/ThemeContext";
import Dialog from "./Dialog";
import PaxConversionForm from "./PaxConversionForm";

interface ConversionStatus { paxLogin: boolean; pending: boolean }

export default function AccountSignInPanel({ onOpenEncryption }: { onOpenEncryption: () => void }) {
  const { palette } = useTheme();
  const encryption = useEncryption();
  const [conversion, setConversion] = useState<ConversionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [success, setSuccess] = useState(false);
  const [checking, setChecking] = useState(false);
  async function check() {
    setChecking(true);
    try { setConversion(await invoke<ConversionStatus>("get_account_conversion_status")); }
    catch (e) { setError(String(e)); }
    finally { setChecking(false); }
  }
  useEffect(() => { void check(); }, [encryption.status?.paxLogin]);
  const pax = encryption.status?.paxLogin ?? conversion?.paxLogin;
  const button = { padding: "9px 14px", border: `1px solid ${palette.border}`, borderRadius: 8,
    background: palette.bgTertiary, color: palette.textPrimary, font: "inherit", cursor: "pointer" };
  async function convert(currentPassword: string, newPassword: string) {
    setError(null);
    try {
      await encryption.convertToPax(currentPassword, newPassword);
      setSuccess(true); setOpen(false);
    } catch (e) { setError(String(e)); throw e; }
    finally { await check(); }
  }
  return (
    <div style={{ marginBottom: 28, display: "grid", gap: 12, color: palette.textPrimary }}>
      <h3 style={{ margin: 0 }}>Sign-in method</h3>
      <p style={{ margin: 0, color: palette.textSecondary, lineHeight: 1.5 }}>
        {conversion?.pending ? "Your switch to Pax sign-in is in progress. Finish using the same new Pax password you chose."
          : pax ? "Pax sign-in: your password also unlocks encrypted recovery on other devices."
          : !conversion ? "Checking sign-in method…"
          : "Standard Matrix: restoring encrypted history can require your recovery key or another verified device."}
      </p>
      {!pax && encryption.status && ((encryption.status.hasIdentity && !encryption.status.crossSigningReady)
        || (encryption.status.backupExists && !encryption.status.backupEnabled)) && (
        <p style={{ margin: 0, color: palette.textSecondary, lineHeight: 1.5 }}>
          Unlock recovery or verify this device in Encryption settings before switching.
        </p>
      )}
      {!pax && <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <button type="button" style={button} disabled={!!encryption.busy || checking || !conversion}
          onClick={() => { setError(null); setOpen(true); }}>
          {conversion?.pending ? "Finish switching to Pax sign-in" : "Switch to Pax sign-in"}
        </button>
        <button type="button" style={button} disabled={!!encryption.busy} onClick={onOpenEncryption}>Encryption settings</button>
      </div>}
      {success && <p role="status" style={{ margin: 0 }}>Switched to Pax sign-in. Use your new Pax password next time you sign in.</p>}
      {error && !open && <div role="alert"><p>{error}</p><button type="button" onClick={() => void check()} style={button}>Retry</button></div>}
      {open && <Dialog aria-labelledby="pax-conversion-title" onClose={() => { if (!encryption.busy) setOpen(false); }} style={{ width: 480, padding: 24 }}>
        <PaxConversionForm pending={!!conversion?.pending} busy={!!encryption.busy} error={error}
          onSubmit={convert} onClose={() => setOpen(false)} />
      </Dialog>}
    </div>
  );
}
