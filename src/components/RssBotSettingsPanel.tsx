import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme/ThemeContext";
import type { RssBotSettings } from "./RssFeedStatus";

interface SaveResult {
  settings: RssBotSettings;
  setupError: string | null;
}

export default function RssBotSettingsPanel({ roomId }: { roomId: string }) {
  const { palette, typography, spacing } = useTheme();
  const [settings, setSettings] = useState<RssBotSettings | null>(null);
  const [botUserId, setBotUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaved(false);
    invoke<RssBotSettings>("get_rss_bot_settings", { roomId }).then((feed) => {
      if (cancelled) return;
      setSettings(feed);
      setBotUserId(feed.botUserId);
    }).catch((e) => {
      if (!cancelled) setError(String(e));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [roomId, reload]);

  async function save() {
    if (!settings || !canSave) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await invoke<SaveResult>("save_rss_bot_settings", {
        roomId,
        botUserId: botUserId.trim(),
        revision: settings.revision,
      });
      setSettings(result.settings);
      setBotUserId(result.settings.botUserId);
      setSaved(true);
      setError(result.setupError);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const canEdit = !!settings?.canEdit && !loading && !saving;
  const changed = botUserId.trim() !== settings?.botUserId;
  const canSave = canEdit && !!botUserId.trim() && (changed || settings?.invitationCancelled);
  const inputStyle: CSSProperties = {
    boxSizing: "border-box",
    width: "100%",
    padding: "8px 10px",
    border: `1px solid ${palette.border}`,
    borderRadius: 6,
    background: palette.bgPrimary,
    color: palette.textPrimary,
    font: "inherit",
  };
  const buttonStyle: CSSProperties = { ...inputStyle, width: "auto", cursor: "pointer" };

  return (
    <form onSubmit={(event) => { event.preventDefault(); void save(); }} style={{
      display: "flex", flexDirection: "column", gap: spacing.unit * 3,
      color: palette.textPrimary, fontSize: typography.fontSizeSmall,
    }}>
      {loading && <div role="status">Loading RSS bot settings…</div>}
      {settings && !loading && (
        <>
          <label style={{ display: "grid", gap: 6 }}>
            RSS bot
            <input type="text" value={botUserId} onChange={(e) => { setBotUserId(e.target.value); setSaved(false); }}
              required readOnly={!canEdit} spellCheck={false} autoCapitalize="off" style={inputStyle} />
          </label>
          <div style={{ color: palette.textSecondary }}>
            {settings.invitationCancelled
              ? "Invitation cancelled. Save these settings to resume feed setup."
              : "Manage subscriptions from RSS feeds in the room menu."}
          </div>
          {changed && !settings.invitationCancelled && <div style={{ color: palette.textSecondary }}>
            To stop an earlier subscription, remove it with the bot that manages it.
          </div>}
          {!settings.canEdit && <div style={{ color: palette.textSecondary }}>You need room permission to change the RSS bot.</div>}
          {settings.canEdit && <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button type="submit" disabled={!canSave} style={{ ...buttonStyle, opacity: canSave ? 1 : 0.5 }}>
              {saving ? "Saving…" : settings.invitationCancelled ? "Save and resume" : "Save RSS bot"}
            </button>
            {saved && <span role="status">RSS bot settings saved</span>}
          </div>}
        </>
      )}
      {error && <div role="alert" style={{ color: palette.textPrimary }}>{error}</div>}
      {error && !loading && !saving && !saved && <button type="button" onClick={() => setReload((n) => n + 1)}
        style={{ ...buttonStyle, alignSelf: "flex-start" }}>Reload saved settings</button>}
    </form>
  );
}
