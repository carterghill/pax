import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "../theme/ThemeContext";
import type { FeedSettings } from "./RssFeedStatus";

interface SaveResult {
  settings: FeedSettings;
  setupError: string | null;
}

export default function RssFeedSettingsPanel({ roomId }: { roomId: string }) {
  const { palette, typography, spacing } = useTheme();
  const [settings, setSettings] = useState<FeedSettings | null>(null);
  const [url, setUrl] = useState("");
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
    invoke<FeedSettings>("get_rss_feed_settings", { roomId }).then((feed) => {
      if (cancelled) return;
      setSettings(feed);
      setUrl(feed.url);
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
      const result = await invoke<SaveResult>("save_rss_feed_settings", {
        roomId,
        feed: { url: url.trim(), botUserId: botUserId.trim() },
        revision: settings.revision,
      });
      setSettings(result.settings);
      setUrl(result.settings.url);
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
  const changed = settings && (url.trim() !== settings.url || botUserId.trim() !== settings.botUserId);
  const canSave = canEdit && !!url.trim() && !!botUserId.trim() && (changed || settings?.invitationCancelled);
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
      {loading && <div role="status">Loading feed settings…</div>}
      {settings && !loading && (
        <>
          <label style={{ display: "grid", gap: 6 }}>
            Feed URL
            <input type="url" value={url} onChange={(e) => { setUrl(e.target.value); setSaved(false); }}
              required readOnly={!canEdit} style={inputStyle} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            Provider bot
            <input type="text" value={botUserId} onChange={(e) => { setBotUserId(e.target.value); setSaved(false); }}
              required readOnly={!canEdit} spellCheck={false} autoCapitalize="off" style={inputStyle} />
          </label>
          <div style={{ color: palette.textSecondary }}>
            {settings.invitationCancelled
              ? "Invitation cancelled. Save these settings to resume feed setup."
              : "Pax uses a provider already in this room or invites it if needed."}
          </div>
          {changed && !settings.invitationCancelled && <div style={{ color: palette.textSecondary }}>
            To stop an earlier subscription, remove it with the bot that manages it.
          </div>}
          {!settings.canEdit && <div style={{ color: palette.textSecondary }}>You need permission to edit this room’s feed settings.</div>}
          {settings.canEdit && <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button type="submit" disabled={!canSave} style={{ ...buttonStyle, opacity: canSave ? 1 : 0.5 }}>
              {saving ? "Saving…" : settings.invitationCancelled ? "Save and resume" : "Save feed settings"}
            </button>
            {saved && <span role="status">Feed settings saved</span>}
          </div>}
        </>
      )}
      {error && <div role="alert" style={{ color: palette.textPrimary }}>{error}</div>}
      {error && !loading && !saving && !saved && <button type="button" onClick={() => setReload((n) => n + 1)}
        style={{ ...buttonStyle, alignSelf: "flex-start" }}>Reload saved settings</button>}
    </form>
  );
}
