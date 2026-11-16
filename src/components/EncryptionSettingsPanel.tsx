import { useId, useState, type CSSProperties } from "react";
import { useEncryption } from "../context/EncryptionContext";
import { useTheme } from "../theme/ThemeContext";

export default function EncryptionSettingsPanel({ compact = false }: { compact?: boolean }) {
  const { palette, typography } = useTheme();
  const encryption = useEncryption();
  const { status, error, busy } = encryption;
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  const [replaceConfirm, setReplaceConfirm] = useState(false);
  const keyInputId = useId();
  const button: CSSProperties = {
    border: `1px solid ${palette.border}`, borderRadius: 8, padding: "9px 14px",
    background: palette.bgTertiary, color: palette.textPrimary, font: "inherit",
    cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1,
  };
  const input: CSSProperties = {
    width: "100%", boxSizing: "border-box", border: `1px solid ${palette.border}`,
    borderRadius: 8, padding: "10px 12px", background: palette.bgPrimary,
    color: palette.textPrimary, font: "inherit",
  };
  const ready = status?.secretStorageExists && status.crossSigningReady && status.backupEnabled;
  const ignore = (promise: Promise<void>) => { void promise.catch(() => {}); };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, color: palette.textPrimary, fontSize: typography.fontSizeBase }}>
      <p style={{ color: palette.textSecondary, lineHeight: 1.5, margin: 0 }}>
        Keep your encrypted conversations when you switch computers or reinstall Pax.
        Your message keys are backed up encrypted, and only your verified devices or recovery key can unlock them.
      </p>
      {!status && !error && <p role="status">Checking encrypted backup…</p>}
      {status && (
        <div style={{ padding: 14, borderRadius: 10, background: palette.bgTertiary, lineHeight: 1.5 }}>
          <strong>{ready ? "Recovery is ready" : status.canSetup ? "Set up recovery" : "Unlock your encrypted history"}</strong>
          <div style={{ color: palette.textSecondary, marginTop: 4 }}>
            {status.backupState === "downloading" ? "Downloading message keys. Older messages will appear as their keys arrive."
              : status.progress.state === "uploading" ? `Backing up ${status.progress.backedUp ?? 0} of ${status.progress.total ?? 0} message keys…`
              : status.progress.state === "error" ? "Some message keys still need to be backed up. Keep Pax open and try again."
              : ready && status.progress.state === "complete" ? "All currently stored message keys have been backed up."
              : ready ? "Message keys are backed up automatically while Pax is open."
              : status.canSetup ? "Save a recovery key so you can restore your history on another device."
              : "Use your recovery key, or verify this device using another device where you are signed in."}
          </div>
        </div>
      )}
      {status?.recoveryKeyNeedsSave && !status.pendingRecoveryKey && ready && (
        <div style={{ lineHeight: 1.5 }}>
          Recovery setup was interrupted before you confirmed saving your key. Enter the key if you saved it,
          or create a new recovery key below and save it now.
        </div>
      )}
      {status?.canSetup && (
        <form onSubmit={(e) => { e.preventDefault(); ignore(encryption.setup(password).then(() => setPassword(""))); }} style={{ display: "grid", gap: 10 }}>
          {!status.crossSigningReady && (
            <label>
              Account password
              <input type="password" autoComplete="current-password" value={password} disabled={!!busy}
                onChange={(e) => setPassword(e.target.value)} style={{ ...input, marginTop: 6 }} />
            </label>
          )}
          <button type="submit" disabled={!!busy} style={{ ...button, background: palette.accent, color: "#fff" }}>
            Set up recovery
          </button>
        </form>
      )}
      {status?.secretStorageExists && (!ready || !compact || status.recoveryKeyNeedsSave) && (
        <form onSubmit={(e) => { e.preventDefault(); ignore(encryption.restore(key).then(() => setKey(""))); }} style={{ display: "grid", gap: 10 }}>
          <label htmlFor={keyInputId}>Recovery key or recovery passphrase</label>
          <input id={keyInputId} type="password" autoComplete="off" spellCheck={false}
            value={key} onChange={(e) => setKey(e.target.value)} style={input} disabled={!!busy} />
          <button type="submit" disabled={!!busy || !key.trim()} style={button}>Restore encrypted history</button>
        </form>
      )}
      {status?.hasIdentity && (!ready || !compact) && (
        <button type="button" disabled={!!busy} style={button} onClick={() => ignore(encryption.requestVerification())}>
          Verify with another device
        </button>
      )}
      {status && !status.canSetup && !status.secretStorageExists && !ready && (
        <p style={{ margin: 0, color: palette.textSecondary, lineHeight: 1.5 }}>
          Recovery has not been set up for this account. Verify with a device that already has your encryption keys,
          then set up recovery here or on that device.
        </p>
      )}
      {status?.backupEnabled && !compact && (
        <button type="button" disabled={!!busy} style={button} onClick={() => ignore(encryption.backUp())}>Back up keys now</button>
      )}
      {ready && (!compact || status?.recoveryKeyNeedsSave) && !replaceConfirm && (
        <button type="button" disabled={!!busy} style={button} onClick={() => setReplaceConfirm(true)}>Create a new recovery key</button>
      )}
      {replaceConfirm && (
        <div style={{ display: "grid", gap: 10 }}>
          <p style={{ margin: 0, lineHeight: 1.5 }}>Your previous recovery key will stop working. Your message history and encryption identity will be preserved.</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" disabled={!!busy} style={button} onClick={() => setReplaceConfirm(false)}>Cancel</button>
            <button type="button" disabled={!!busy} style={button} onClick={() => ignore(encryption.replaceKey().then(() => setReplaceConfirm(false)))}>Create new key</button>
          </div>
        </div>
      )}
      {busy && <p role="status" style={{ margin: 0, color: palette.textSecondary }}>{busy}</p>}
      {(error || status?.progress.error) && <p role="alert" style={{ margin: 0, color: palette.textPrimary, lineHeight: 1.5 }}>{error || status?.progress.error}</p>}
      <button type="button" disabled={!!busy} style={{ ...button, alignSelf: "flex-start" }} onClick={() => ignore(encryption.refresh())}>Check status</button>
    </div>
  );
}
