import { useId, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useEncryption } from "../context/EncryptionContext";
import { useTheme } from "../theme/ThemeContext";

// The SDK reads archives into memory. Matches history_backup.rs.
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** File recovery is available even when account recovery/status is unavailable. */
export default function HistoryBackupPanel() {
  const { palette } = useTheme();
  const { busy, historyExport, historyImport, exportHistory, importHistory } = useEncryption();
  const [action, setAction] = useState<"export" | "import" | null>(null);
  const [exportPassword, setExportPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const id = useId();
  const disabled = !!busy || reading;
  const button: CSSProperties = {
    border: `1px solid ${palette.border}`, borderRadius: 8, padding: "9px 14px",
    background: palette.bgTertiary, color: palette.textPrimary, font: "inherit",
    cursor: disabled ? "wait" : "pointer", opacity: disabled ? 0.6 : 1,
  };
  const input: CSSProperties = {
    width: "100%", boxSizing: "border-box", border: `1px solid ${palette.border}`,
    borderRadius: 8, padding: "10px 12px", background: palette.bgPrimary,
    color: palette.textPrimary, font: "inherit", marginTop: 6,
  };

  async function save() {
    if (disabled || submitting.current) return;
    setError(null);
    if (Array.from(exportPassword).length < 12) { setError("Choose a backup password of at least 12 characters."); return; }
    if (exportPassword !== confirmation) { setError("The backup passwords do not match."); return; }
    submitting.current = true;
    try {
      const result = await exportHistory(exportPassword);
      if (result) { setExportPassword(""); setConfirmation(""); setAction(null); }
    } catch { /* Shared encryption controls display the native error. */ }
    finally { submitting.current = false; }
  }

  async function restore() {
    if (disabled || submitting.current || !file || !importPassword) return;
    setError(null);
    if (file.size > MAX_ARCHIVE_BYTES) { setError("Choose an encrypted backup file smaller than 64 MiB."); return; }
    submitting.current = true;
    setReading(true);
    try {
      let contents: string;
      try { contents = await file.text(); }
      catch { setError("Could not read this backup file. Select it again and try again."); return; }
      const result = await importHistory(contents, importPassword);
      if (result) {
        setImportPassword(""); setFile(null); setAction(null);
        if (fileInput.current) fileInput.current.value = "";
      }
    } catch { /* Shared encryption controls display the native error. */ }
    finally { setReading(false); submitting.current = false; }
  }

  function choose(next: "export" | "import" | null) {
    setAction(next); setError(null);
    setExportPassword(""); setConfirmation(""); setImportPassword(""); setFile(null);
  }

  return (
    <section aria-labelledby={`${id}-heading`} style={{ display: "grid", gap: 12, borderTop: `1px solid ${palette.border}`, paddingTop: 16 }}>
      <strong id={`${id}-heading`}>Back up available history</strong>
      <p style={{ margin: 0, color: palette.textSecondary, lineHeight: 1.5 }}>
        Save an encrypted file of the message keys this device still has, even if you don’t have your recovery key.
        Keep the file and its backup password somewhere safe; you’ll need both to restore it on another device.
      </p>
      <p style={{ margin: 0, color: palette.textSecondary, lineHeight: 1.5 }}>
        This is a snapshot. It doesn’t include future keys, account verification, or the messages and attachments themselves.
        Messages still need to be available on your homeserver. Your existing account recovery stays in place.
      </p>
      {!action && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" disabled={disabled} style={button} onClick={() => choose("export")}>Back up this device’s history</button>
          <button type="button" disabled={disabled} style={button} onClick={() => choose("import")}>Restore from backup file</button>
        </div>
      )}
      {action === "export" && (
        <form style={{ display: "grid", gap: 10 }} onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label htmlFor={`${id}-export-password`}>Choose a backup file password
            <input id={`${id}-export-password`} type="password" autoComplete="new-password" disabled={disabled}
              value={exportPassword} onChange={(e) => setExportPassword(e.target.value)} style={input} />
          </label>
          <label htmlFor={`${id}-confirm`}>Confirm backup file password
            <input id={`${id}-confirm`} type="password" autoComplete="new-password" disabled={disabled}
              value={confirmation} onChange={(e) => setConfirmation(e.target.value)} style={input} />
          </label>
          <p style={{ margin: 0, color: palette.textSecondary, lineHeight: 1.5 }}>Use at least 12 characters and save this password in your password manager. The encrypted file will be saved to Downloads.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="submit" disabled={disabled || !exportPassword || !confirmation} style={button}>Save encrypted backup</button>
            <button type="button" disabled={disabled} style={button} onClick={() => choose(null)}>Cancel</button>
          </div>
        </form>
      )}
      {action === "import" && (
        <form style={{ display: "grid", gap: 10 }} onSubmit={(e) => { e.preventDefault(); void restore(); }}>
          <label htmlFor={`${id}-file`}>Encrypted message-key backup file
            <input ref={fileInput} id={`${id}-file`} type="file" disabled={disabled} style={input}
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} />
          </label>
          <label htmlFor={`${id}-import-password`}>Password for this backup file
            <input id={`${id}-import-password`} type="password" autoComplete="off" disabled={disabled}
              value={importPassword} onChange={(e) => setImportPassword(e.target.value)} style={input} />
          </label>
          <p style={{ margin: 0, color: palette.textSecondary, lineHeight: 1.5 }}>Supports encrypted message-key exports from Pax and other Matrix apps. This adds available keys to this device.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="submit" disabled={disabled || !file || !importPassword} style={button}>Restore available history</button>
            <button type="button" disabled={disabled} style={button} onClick={() => choose(null)}>Cancel</button>
          </div>
        </form>
      )}
      {historyExport && (
        <div role="status" style={{ lineHeight: 1.5 }}>
          <p style={{ margin: 0 }}>Saved {historyExport.keyCount} message {historyExport.keyCount === 1 ? "key" : "keys"}. Keep this file and your backup password.</p>
          <p style={{ margin: "4px 0 8px", overflowWrap: "anywhere", color: palette.textSecondary }}>{historyExport.savedPath}</p>
          <button type="button" disabled={disabled} style={button}
            onClick={() => { void invoke("open_containing_folder", { filePath: historyExport.savedPath }).catch(() => setError("Could not open the folder. Find the encrypted file in Downloads.")); }}>Show backup file</button>
        </div>
      )}
      {historyImport && (
        <p role="status" style={{ margin: 0, lineHeight: 1.5 }}>
          {historyImport.importedCount > 0
            ? `Restored ${historyImport.importedCount} of ${historyImport.totalCount} message keys. Open the corresponding conversations to read the available history.`
            : historyImport.totalCount > 0 ? "This device already has all the keys in this backup." : "This backup file contains no message keys."}
        </p>
      )}
      {reading && !busy && <p role="status" style={{ margin: 0 }}>Reading backup file…</p>}
      {error && <p role="alert" style={{ margin: 0, lineHeight: 1.5 }}>{error}</p>}
    </section>
  );
}
