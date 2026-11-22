import { useId, useState, type CSSProperties } from "react";
import { useEncryption } from "../context/EncryptionContext";
import { useTheme } from "../theme/ThemeContext";
import HistoryBackupPanel from "./HistoryBackupPanel";
import NewRecoveryDialog from "./NewRecoveryDialog";

export default function EncryptionSettingsPanel({ compact = false }: { compact?: boolean }) {
  const { palette, typography } = useTheme();
  const encryption = useEncryption();
  const { status, error, busy, identityChange } = encryption;
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  const [replaceConfirm, setReplaceConfirm] = useState(false);
  const [newRecoveryOpen, setNewRecoveryOpen] = useState(false);
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
  const missingIdentityKeys = status?.hasIdentity && !status.crossSigningReady;
  const missingBackupKey = status?.backupExists && !status.backupEnabled;
  const ignore = (promise: Promise<void>) => { void promise.catch(() => {}); };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, color: palette.textPrimary, fontSize: typography.fontSizeBase }}>
      <p style={{ color: palette.textSecondary, lineHeight: 1.5, margin: 0 }}>
        Keep your encrypted conversations when you switch computers or reinstall Pax.
        {status?.paxLogin ? "Your Pax password unlocks encrypted recovery automatically when you sign in." : "Your message keys are backed up encrypted, and only your verified devices or recovery key can unlock them."}
      </p>
      {!status && !error && <p role="status">Checking encrypted backup…</p>}
      {identityChange && (
        <div style={{ padding: 14, borderRadius: 10, background: palette.bgTertiary, lineHeight: 1.5 }}>
          <strong>Your encryption identity changed</strong>
          <p style={{ margin: "4px 0 10px", color: palette.textSecondary }}>
            {identityChange.deviceVerified
              ? "This device is already verified under the new identity. Continue if you recognize the change."
              : "Verify this device using another device that has the new encryption identity."}
          </p>
          <button type="button" style={button} disabled={!!busy} onClick={() => {
            ignore(identityChange.deviceVerified
              ? encryption.acknowledgeIdentityChange(identityChange.id)
              : encryption.requestVerification());
          }}>{identityChange.deviceVerified ? "Continue" : "Verify this device"}</button>
        </div>
      )}
      {encryption.recoveryKey && encryption.recoveryKeyDismissed && (
        <button type="button" style={button} onClick={encryption.showRecoveryKey}>View and save recovery key</button>
      )}
      {status && (
        <div style={{ padding: 14, borderRadius: 10, background: palette.bgTertiary, lineHeight: 1.5 }}>
          <strong>{ready ? "Recovery is ready" : status.canSetup ? "Set up recovery"
            : !status.secretStorageExists ? "Recovery setup needs your existing encryption keys" : "Unlock your encrypted history"}</strong>
          <div style={{ color: palette.textSecondary, marginTop: 4 }}>
            {status.backupState === "downloading" ? "Downloading message keys. Older messages will appear as their keys arrive."
              : status.progress.state === "uploading" ? `Backing up ${status.progress.backedUp ?? 0} of ${status.progress.total ?? 0} message keys…`
              : status.progress.state === "error" ? "Some message keys still need to be backed up. Keep Pax open and try again."
              : ready && status.progress.state === "complete" ? "All currently stored message keys have been backed up."
              : ready ? "Message keys are backed up automatically while Pax is open."
              : status.canSetup ? "Save a recovery key so you can restore your history on another device."
              : !status.secretStorageExists ? "Recovery has not been configured. This device needs the account’s existing encryption secrets before it can set up recovery."
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
      {status?.canSetup && !status.newRecoveryPending && (
        <form onSubmit={(e) => { e.preventDefault(); ignore(encryption.setup(password).then(() => setPassword(""))); }} style={{ display: "grid", gap: 10 }}>
          <label>
              Account password
              <input type="password" autoComplete="current-password" required value={password} disabled={!!busy}
                onChange={(e) => setPassword(e.target.value)} style={{ ...input, marginTop: 6 }} />
          </label>
          <button type="submit" disabled={!!busy} style={{ ...button, background: palette.accent, color: "#fff" }}>
            Set up recovery
          </button>
        </form>
      )}
      {status?.paxLogin && !ready && !identityChange && <p style={{ margin: 0, lineHeight: 1.5 }}>Sign in again with your Pax password to restore encrypted recovery automatically.</p>}
      {!status?.paxLogin && status?.secretStorageExists && (!ready || !compact || status.recoveryKeyNeedsSave) && (
        <form onSubmit={(e) => { e.preventDefault(); ignore(encryption.restore(key).then(() => setKey(""))); }} style={{ display: "grid", gap: 10 }}>
          <label htmlFor={keyInputId}>Recovery key or recovery passphrase</label>
          <input id={keyInputId} type="password" autoComplete="off" spellCheck={false}
            value={key} onChange={(e) => setKey(e.target.value)} style={input} disabled={!!busy} />
          <button type="submit" disabled={!!busy || !key.trim()} style={button}>Restore encrypted history</button>
        </form>
      )}
      {!identityChange && status?.hasIdentity && (!ready || !compact) && (
        <button type="button" disabled={!!busy} style={button} onClick={() => ignore(encryption.requestVerification())}>
          Verify with another device
        </button>
      )}
      {status && !status.canSetup && !status.secretStorageExists && !ready && (
        <div style={{ color: palette.textSecondary, lineHeight: 1.5 }}>
          {missingIdentityKeys && <p style={{ margin: "0 0 10px" }}>
            An encryption identity already exists for this account, but its private verification keys are missing on this device.
            This can happen even if you have never set up a recovery key. Verify with a device that still has those keys to retrieve them.
          </p>}
          {missingBackupKey && <p style={{ margin: "0 0 10px" }}>
            An encrypted message backup also exists, but this device does not have its decryption key.
            Backups can be created automatically before a recovery key is set up. A new recovery key cannot unlock that existing backup.
          </p>}
          <p style={{ margin: 0 }}>
            If none of your devices has the missing keys, you can set up new recovery using this device’s available history.
            You can also save a backup file below.
          </p>
        </div>
      )}
      {status?.canStartFromDevice && <button type="button" disabled={!!busy} style={button} onClick={() => setNewRecoveryOpen(true)}>
        {status.newRecoveryPending ? "Finish recovery setup on this device" : "Set up recovery from this device"}
      </button>}
      {newRecoveryOpen && <NewRecoveryDialog onClose={() => setNewRecoveryOpen(false)} />}
      {status?.backupEnabled && !compact && (
        <button type="button" disabled={!!busy} style={button} onClick={() => ignore(encryption.backUp())}>Back up keys now</button>
      )}
      {ready && !status?.paxLogin && (!compact || status?.recoveryKeyNeedsSave) && !replaceConfirm && (
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
      <HistoryBackupPanel />
      {busy && <p role="status" style={{ margin: 0, color: palette.textSecondary }}>{busy}</p>}
      {(error || status?.progress.error) && <p role="alert" style={{ margin: 0, color: palette.textPrimary, lineHeight: 1.5 }}>{error || status?.progress.error}</p>}
      <button type="button" disabled={!!busy} style={{ ...button, alignSelf: "flex-start" }} onClick={() => ignore(encryption.refresh())}>Check status</button>
    </div>
  );
}
