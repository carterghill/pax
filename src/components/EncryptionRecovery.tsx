import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useEncryption, type EncryptionStatus } from "../context/EncryptionContext";
import { useTheme } from "../theme/ThemeContext";
import Dialog from "./Dialog";
import EncryptionSettingsPanel from "./EncryptionSettingsPanel";

function RecoveryDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { typography } = useTheme();
  const titleId = useId();
  return (
    <Dialog onClose={onClose} aria-labelledby={titleId}
      style={{ width: "min(520px, calc(100vw - 32px))", overflowY: "auto", padding: 24 }}>
      <h2 id={titleId} style={{ fontSize: typography.fontSizeLarge, margin: "0 0 16px" }}>{title}</h2>
      {children}
    </Dialog>
  );
}

export function EncryptionSignOut({ onCancel, onSignOut }: { onCancel: () => void; onSignOut: () => void }) {
  const { palette } = useTheme();
  const { status, busy } = useEncryption();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showRecovery, setShowRecovery] = useState(false);
  const active = useRef(true);
  const finish = useRef(onSignOut);
  finish.current = onSignOut;
  useEffect(() => {
    let cancelled = false;
    active.current = true;
    void (async () => {
      try {
        const status = await invoke<EncryptionStatus>("get_encryption_status");
        if (!status.backupEnabled || !status.secretStorageExists || !status.crossSigningReady || status.recoveryKeyNeedsSave) {
          if (!cancelled) setChecking(false);
          return;
        }
        await invoke("sync_encryption_backup");
        if (!cancelled && active.current) finish.current();
      } catch (e) {
        if (!cancelled) { setError(String(e)); setChecking(false); }
      }
    })();
    return () => { cancelled = true; active.current = false; };
  }, []);
  const button = { border: `1px solid ${palette.border}`, borderRadius: 8, padding: "9px 14px",
    background: palette.bgTertiary, color: palette.textPrimary, cursor: "pointer", font: "inherit" };
  const cancel = () => { active.current = false; onCancel(); };
  return (
    <RecoveryDialog onClose={cancel} title={checking ? "Backing up before sign-out" : "Protect your history before signing out"}>
      {checking ? <p role="status">Checking recovery and backing up your message keys…</p> : <>
        <p style={{ lineHeight: 1.5 }}>Signing out removes this device’s local encryption keys. Set up or unlock recovery, or save an encrypted file of this device’s available message keys first.</p>
        {error && <p role="alert">{error}</p>}
        {showRecovery ? <EncryptionSettingsPanel compact />
          : <button type="button" style={button} onClick={() => setShowRecovery(true)}>Recovery and file backup options</button>}
      </>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 20 }}>
        <button type="button" style={button} onClick={cancel}>Stay signed in</button>
        {!checking && status?.backupEnabled && status.secretStorageExists && status.crossSigningReady && !status.recoveryKeyNeedsSave &&
          <button type="button" disabled={!!busy} style={button} onClick={() => {
            setChecking(true);
            void invoke("sync_encryption_backup").then(() => {
              if (active.current) finish.current();
            }).catch((e) => {
              if (active.current) { setError(String(e)); setChecking(false); }
            });
          }}>Back up and sign out</button>}
        {!checking && <button type="button" disabled={!!busy} style={button} onClick={onSignOut}>Sign out anyway</button>}
      </div>
    </RecoveryDialog>
  );
}

/** Mounted once per signed-in account, including when Settings is closed. */
export default function EncryptionRecovery({ userId }: { userId: string }) {
  const encryption = useEncryption();
  const { status, recoveryKey, verification, busy, error } = encryption;
  const { palette } = useTheme();
  const preferenceKey = `pax:hide-encryption-recovery-prompt:${userId}`;
  const [snoozed, setSnoozed] = useState(() => {
    try { return localStorage.getItem(preferenceKey) === "true"; }
    catch { return false; }
  });
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setSaved(false); setCopied(false); }, [recoveryKey]);
  const ignore = (promise: Promise<void>) => { void promise.catch(() => {}); };
  const button = { border: `1px solid ${palette.border}`, borderRadius: 8, padding: "9px 14px",
    background: palette.bgTertiary, color: palette.textPrimary, cursor: "pointer", font: "inherit" };
  const ready = status?.secretStorageExists && status.crossSigningReady && status.backupEnabled;

  if (recoveryKey && !encryption.recoveryKeyDismissed) return (
    <RecoveryDialog title="Save your recovery key" onClose={() => {
      setSnoozed(true);
      encryption.dismissRecoveryKey();
    }}>
      <p style={{ lineHeight: 1.5 }}>Keep this key in your password manager or somewhere safe. You will need it to restore encrypted history if you lose access to your devices.</p>
      <textarea aria-label="Your recovery key" readOnly value={recoveryKey} rows={3} spellCheck={false}
        style={{ width: "100%", boxSizing: "border-box", resize: "none", padding: 12, borderRadius: 8,
          background: palette.bgPrimary, color: palette.textPrimary, border: `1px solid ${palette.border}`, fontFamily: "monospace", fontSize: 16 }} />
      <button type="button" style={{ ...button, marginTop: 8 }} onClick={() => {
        void navigator.clipboard.writeText(recoveryKey).then(() => setCopied(true)).catch(() => setCopied(false));
      }}>{copied ? "Copied" : "Copy key"}</button>
      <label style={{ display: "flex", alignItems: "center", gap: 10, margin: "20px 0", lineHeight: 1.5 }}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have saved my recovery key
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="button" style={{ ...button, opacity: saved ? 1 : 0.5 }} disabled={!saved || !!busy}
        onClick={() => ignore(encryption.acknowledgeKey())}>Continue</button>
    </RecoveryDialog>
  );

  if (verification) return (
    <RecoveryDialog onClose={() => {
      setSnoozed(true);
      encryption.dismissVerification();
    }} title={verification.state === "done" ? "Device verified" : "Verify your device"}>
      {verification.state === "requested" ? <>
        <p style={{ lineHeight: 1.5 }}>Another device signed in to your account wants to verify. Accept only if you started this on your other device.</p>
        <button type="button" style={button} disabled={!!busy} onClick={() => ignore(encryption.respondVerification("accept"))}>Accept verification</button>
      </> : verification.state === "comparing" ? <>
        <p>Check that both devices show the same emojis or numbers, in the same order.</p>
        {verification.emojis.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 12, margin: "20px 0" }}>
          {verification.emojis.map(([symbol, description], index) => <div key={index} style={{ textAlign: "center", width: 82 }}>
            <div style={{ fontSize: 32 }}>{symbol}</div><small>{description}</small>
          </div>)}
        </div>}
        {verification.decimals && <p style={{ fontFamily: "monospace", fontSize: 24, textAlign: "center" }}>{verification.decimals.join(" · ")}</p>}
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" disabled={!!busy} style={button} onClick={() => ignore(encryption.respondVerification("confirm"))}>They match</button>
          <button type="button" disabled={!!busy} style={button} onClick={() => ignore(encryption.respondVerification("mismatch"))}>They don’t match</button>
        </div>
      </> : <p role="status" style={{ lineHeight: 1.5 }}>
        {verification.state === "done" ? "This device is verified. Available message keys will restore automatically."
          : verification.state === "cancelled" ? "Verification was cancelled. You can try again from Encryption settings."
          : verification.state === "confirmed" ? "Waiting for confirmation on your other device…"
          : "Open your other signed-in device and accept the verification request…"}
      </p>}
      {error && <p role="alert">{error}</p>}
      <div style={{ marginTop: 20 }}>
        {["done", "cancelled"].includes(verification.state)
          ? <button type="button" style={button} onClick={encryption.dismissVerification}>Continue</button>
          : <button type="button" style={button} disabled={!!busy} onClick={() => ignore(encryption.respondVerification("cancel"))}>Cancel verification</button>}
      </div>
    </RecoveryDialog>
  );

  if (snoozed || recoveryKey || (ready && !status?.recoveryKeyNeedsSave) || !status) return null;
  return (
    <RecoveryDialog onClose={() => setSnoozed(true)} title={status.canSetup ? "Protect your encrypted history" : "Restore your encrypted history"}>
      <EncryptionSettingsPanel compact />
      <label style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 20, cursor: "pointer" }}>
        <input type="checkbox" checked={dontShowAgain} onChange={(event) => {
          const checked = event.target.checked;
          setDontShowAgain(checked);
          try {
            if (checked) localStorage.setItem(preferenceKey, "true");
            else localStorage.removeItem(preferenceKey);
          } catch { /* Keep the dialog usable when browser storage is unavailable. */ }
        }} style={{ width: 16, height: 16, accentColor: palette.accent }} />
        Don’t show me again
      </label>
      <button type="button" style={{ ...button, marginTop: 16 }} onClick={() => setSnoozed(true)}>Later</button>
      <p style={{ fontSize: 13, color: palette.textSecondary, marginBottom: 0 }}>You can return to Settings → Encryption at any time.</p>
    </RecoveryDialog>
  );
}
