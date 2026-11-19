import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import Dialog from "./Dialog";
import { useTheme } from "../theme/ThemeContext";

type Access = "allow_old_members" | "invite_old_members" | "keep";

interface UpgradeOptions {
  currentVersion: string | null;
  targetVersion: string | null;
  inviteOnly: boolean;
  additionalCreators: string[];
  spaces: string[];
}

interface UpgradeResult {
  replacementRoomId: string;
  warnings: string[];
}

export default function RoomUpgradeSettings({
  roomId,
  roomName,
  onDone,
}: {
  roomId: string;
  roomName: string;
  onDone: (roomId: string) => void;
}) {
  const { palette, spacing, typography } = useTheme();
  const [options, setOptions] = useState<UpgradeOptions | null>(null);
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState<Access>("allow_old_members");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UpgradeResult | null>(null);

  useEffect(() => {
    let mounted = true;
    invoke<UpgradeOptions | null>("get_room_upgrade_options", { roomId })
      .then((value) => {
        if (mounted) setOptions(value);
      })
      .catch((reason) => {
        if (mounted) setError(String(reason));
      });
    return () => { mounted = false; };
  }, [roomId]);

  const upgrade = async () => {
    if (!options?.targetVersion || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<UpgradeResult>("upgrade_room", {
        roomId,
        version: options.targetVersion,
        access: options.inviteOnly ? access : "keep",
      });
      setResult(next);
      if (next.warnings.length === 0) onDone(next.replacementRoomId);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!options && !error) return null;
  const button: CSSProperties = {
    border: `1px solid ${palette.border}`,
    borderRadius: spacing.unit,
    padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
    background: palette.bgSecondary,
    color: palette.textPrimary,
    font: "inherit",
    cursor: busy ? "wait" : "pointer",
  };
  return (
    <section style={{ paddingTop: spacing.unit * 3, borderTop: `1px solid ${palette.border}` }}>
      {options?.currentVersion && <p style={{ color: palette.textSecondary, fontSize: typography.fontSizeSmall }}>
        Room version {options.currentVersion}
      </p>}
      {options?.targetVersion && <button type="button" style={button} onClick={() => setOpen(true)}>
        Upgrade room
      </button>}
      {!open && error && <p role="status" style={{ color: palette.textSecondary }}>
        Room upgrade options couldn’t be loaded. {error}
      </p>}
      {open && options && (
        <Dialog aria-label={`Upgrade ${roomName}`} onClose={() => {
          if (busy) return;
          if (result) onDone(result.replacementRoomId);
          else setOpen(false);
        }} style={{ width: "min(480px, calc(100vw - 32px))", padding: spacing.unit * 4 }}>
          <h2 style={{ marginTop: 0 }}>{result ? "Room upgraded" : `Upgrade ${roomName}`}</h2>
          {result ? (
            <>
              <p>The replacement was created. Some setup steps need attention.</p>
              <ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </>
          ) : (
            <>
              <p>The replacement will use room version {options.targetVersion}. Earlier messages stay in the original room.</p>
              {Number(options.targetVersion) >= 12 && <p>
                You will be a creator of the replacement room.
                {options.additionalCreators.length > 0 && ` Existing creators retained: ${options.additionalCreators.join(", ")}.`}
              </p>}
              {options.inviteOnly && <fieldset style={{ padding: spacing.unit * 2, borderColor: palette.border }}>
                <legend>Access to the replacement</legend>
                <label style={{ display: "block", marginBottom: spacing.unit }}>
                  <input type="radio" name="upgrade-access" checked={access === "allow_old_members"} disabled={busy}
                    onChange={() => setAccess("allow_old_members")} /> Allow old-room members to join
                </label>
                <label style={{ display: "block" }}>
                  <input type="radio" name="upgrade-access" checked={access === "invite_old_members"} disabled={busy}
                    onChange={() => setAccess("invite_old_members")} /> Keep invite-only and invite current members
                </label>
              </fieldset>}
              {options.spaces.length > 0 && (
                <p>Both rooms will be listed in {options.spaces.join(", ")}. Pax will show them as one conversation.</p>
              )}
            </>
          )}
          {error && <p role="alert">{error}</p>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: spacing.unit * 2 }}>
            <button type="button" style={button} disabled={busy} onClick={() => result ? onDone(result.replacementRoomId) : setOpen(false)}>
              {result ? "Done" : "Cancel"}
            </button>
            <button type="button" style={{ ...button, background: palette.accent, color: "#fff" }}
              disabled={busy} onClick={() => void upgrade()}>
              {busy ? "Working…" : result ? "Retry setup" : `Upgrade to version ${options.targetVersion}`}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
