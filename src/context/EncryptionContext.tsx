import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface EncryptionStatus {
  paxLogin: boolean;
  recoveryState: string;
  backupState: string;
  backupExists: boolean;
  backupEnabled: boolean;
  secretStorageExists: boolean;
  crossSigningReady: boolean;
  hasIdentity: boolean;
  canSetup: boolean;
  canStartFromDevice: boolean;
  newRecoveryPending: boolean;
  pendingRecoveryKey: boolean;
  recoveryKeyNeedsSave: boolean;
  progress: { state: string; backedUp: number | null; total: number | null; error: string | null };
}

export interface VerificationStatus {
  flowId: string;
  state: "requested" | "waiting" | "comparing" | "confirmed" | "done" | "cancelled";
  emojis: [string, string][];
  decimals: [number, number, number] | null;
}

export interface HistoryExport {
  savedPath: string;
  keyCount: number;
}

export interface HistoryImport {
  importedCount: number;
  totalCount: number;
}

interface EncryptionContextValue {
  status: EncryptionStatus | null;
  error: string | null;
  busy: string | null;
  recoveryKey: string | null;
  recoveryKeyDismissed: boolean;
  dismissRecoveryKey: () => void;
  showRecoveryKey: () => void;
  verification: VerificationStatus | null;
  refresh: () => Promise<void>;
  setup: (password?: string) => Promise<void>;
  startRecoveryFromDevice: (password: string) => Promise<void>;
  restore: (key: string) => Promise<void>;
  acknowledgeKey: () => Promise<void>;
  replaceKey: () => Promise<void>;
  backUp: () => Promise<void>;
  convertToPax: (currentPassword: string, newPassword: string) => Promise<void>;
  historyExport: HistoryExport | null;
  historyImport: HistoryImport | null;
  exportHistory: (passphrase: string) => Promise<HistoryExport | null>;
  importHistory: (contents: string, passphrase: string) => Promise<HistoryImport | null>;
  requestVerification: () => Promise<void>;
  respondVerification: (action: "accept" | "confirm" | "mismatch" | "cancel") => Promise<void>;
  dismissVerification: () => void;
}

const EncryptionContext = createContext<EncryptionContextValue | null>(null);

export function EncryptionProvider({ children, userId }: { children: ReactNode; userId: string }) {
  const [status, setStatus] = useState<EncryptionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [recoveryKeyDismissed, setRecoveryKeyDismissed] = useState(false);
  const [verification, setVerification] = useState<VerificationStatus | null>(null);
  const [historyExport, setHistoryExport] = useState<HistoryExport | null>(null);
  const [historyImport, setHistoryImport] = useState<HistoryImport | null>(null);
  const mounted = useRef(true);
  const refreshing = useRef(false);
  const operating = useRef(false);
  const dismissedFlow = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const next = await invoke<EncryptionStatus>("get_encryption_status");
      if (mounted.current) {
        setStatus(next);
        setConnectionError(null);
        if (next.paxLogin) { setRecoveryKey(null); setRecoveryKeyDismissed(false); }
        // Keep an unacknowledged generated key available after a webview reload.
        if (next.pendingRecoveryKey && !next.paxLogin) {
          const key = await invoke<string | null>("get_pending_encryption_recovery_key");
          if (mounted.current) setRecoveryKey(key);
        }
      }
    } catch (e) {
      if (mounted.current) setConnectionError(String(e));
    } finally {
      refreshing.current = false;
    }
  }, []);

  const refreshVerification = useCallback(async () => {
    const next = await invoke<VerificationStatus | null>("get_encryption_verification");
    if (mounted.current && next?.flowId !== dismissedFlow.current) setVerification(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const listeners = [
      listen("encryption-status-changed", () => {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => void refresh(), 300);
      }),
      listen("encryption-verification-request", () => {
        void refreshVerification().catch((e) => { if (mounted.current) setError(String(e)); });
      }),
    ];
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      clearTimeout(refreshTimer);
      for (const listener of listeners) void listener.then((unlisten) => unlisten());
    };
  }, [refresh, refreshVerification]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refreshVerification(); }
      catch (e) { if (!cancelled && mounted.current) setError(String(e)); }
      if (!cancelled) timer = setTimeout(poll, verification && !["done", "cancelled"].includes(verification.state) ? 700 : 5_000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [refreshVerification, verification?.state]);

  const run = useCallback(async (label: string, action: () => Promise<void>, refreshAfter = true) => {
    if (operating.current) return;
    operating.current = true;
    setBusy(label);
    setError(null);
    try {
      await action();
      if (refreshAfter) await refresh();
    } catch (e) {
      if (mounted.current) setError(String(e));
      throw e;
    } finally {
      operating.current = false;
      if (mounted.current) setBusy(null);
    }
  }, [refresh]);

  const setup = (password?: string) => run("Setting up recovery…", async () => {
    const key = await invoke<string>("setup_encryption_recovery", { password: password || null });
    if (mounted.current) { setRecoveryKey(key); setRecoveryKeyDismissed(false); }
  });
  const startRecoveryFromDevice = (password: string) => run("Setting up recovery from this device…", async () => {
    try {
      const key = await invoke<string>("start_encryption_recovery_from_device", { password, expectedUserId: userId, confirmed: true });
      if (mounted.current) { setRecoveryKey(key); setRecoveryKeyDismissed(false); }
    } finally { await invoke("start_sync"); await refresh(); }
  }, false);
  const replaceKey = () => run("Creating recovery key…", async () => {
    const key = await invoke<string>("replace_encryption_recovery_key");
    if (mounted.current) { setRecoveryKey(key); setRecoveryKeyDismissed(false); }
  });
  const restore = (key: string) => run("Restoring encryption keys…", async () => {
    await invoke("restore_encryption_recovery", { recoveryKey: key });
  });
  const acknowledgeKey = () => run("Saving…", async () => {
    await invoke("acknowledge_encryption_recovery_key");
    if (mounted.current) setRecoveryKey(null);
  });
  const backUp = () => run("Backing up message keys…", async () => {
    await invoke("sync_encryption_backup");
  });
  const convertToPax = (currentPassword: string, newPassword: string) => run("Switching to Pax sign-in…", async () => {
    try {
      await invoke("convert_account_to_pax", { currentPassword, newPassword, expectedUserId: userId });
    } finally {
      // Reauthentication may replace the SDK client, including on a recoverable
      // error after the password change. Restart sync against the current one.
      await invoke("start_sync");
      await refresh();
    }
  });
  const exportHistory = async (passphrase: string): Promise<HistoryExport | null> => {
    let result: HistoryExport | null = null;
    await run("Saving this device’s encrypted history backup…", async () => {
      if (mounted.current) setHistoryExport(null);
      result = await invoke<HistoryExport>("export_available_history", { passphrase, expectedUserId: userId });
      if (mounted.current) setHistoryExport(result);
    }, false);
    return result;
  };
  const importHistory = async (contents: string, passphrase: string): Promise<HistoryImport | null> => {
    let result: HistoryImport | null = null;
    await run("Restoring message keys from your backup file…", async () => {
      if (mounted.current) setHistoryImport(null);
      result = await invoke<HistoryImport>("import_available_history", { contents, passphrase, expectedUserId: userId });
      if (mounted.current) setHistoryImport(result);
    }, false);
    return result;
  };
  const requestVerification = () => run("Requesting verification…", async () => {
    dismissedFlow.current = null;
    await invoke("request_encryption_verification");
    await refreshVerification();
  });
  const respondVerification = (action: "accept" | "confirm" | "mismatch" | "cancel") => run("Updating verification…", async () => {
    if (!verification) return;
    await invoke("respond_encryption_verification", { flowId: verification.flowId, action });
    await refreshVerification();
  });

  return (
    <EncryptionContext.Provider value={{ status, error: error ?? connectionError, busy, recoveryKey, verification, refresh,
      recoveryKeyDismissed, dismissRecoveryKey: () => setRecoveryKeyDismissed(true), showRecoveryKey: () => setRecoveryKeyDismissed(false),
      setup, startRecoveryFromDevice, restore, acknowledgeKey, replaceKey, backUp, convertToPax, historyExport, historyImport, exportHistory, importHistory,
      requestVerification, respondVerification,
      dismissVerification: () => { dismissedFlow.current = verification?.flowId ?? null; setVerification(null); void refresh(); },
    }}>
      {children}
    </EncryptionContext.Provider>
  );
}

export function useEncryption() {
  const value = useContext(EncryptionContext);
  if (!value) throw new Error("EncryptionProvider is missing");
  return value;
}
