import { useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNotificationSettings } from "../hooks/useNotificationSettings";
import { useTheme } from "../theme/ThemeContext";
import type { CallMode } from "../types/notifications";

type Props = { scope: "global" | "room" | "user"; id?: string };

export default function CallPreferenceSelect({ scope, id }: Props) {
  const { notificationSettings, loading } = useNotificationSettings();
  const { palette, spacing, typography } = useTheme();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const descriptionId = useId();
  const calls = notificationSettings.calls;
  const value = scope === "global" ? calls?.global ?? "ring"
    : (scope === "room" ? calls?.rooms : calls?.users)?.[id ?? ""] ?? "";
  const label = scope === "global" ? "Incoming calls" : scope === "room" ? "Calls from this room" : "Calls from this person";
  async function change(mode: CallMode | "") {
    setSaving(true);
    setError("");
    try {
      await invoke("set_call_preference", { scope, id: id ?? null, mode: mode || null });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div style={{ display: "grid", gap: spacing.unit, marginTop: spacing.unit * 2 }}>
      <label style={{ display: "grid", gap: spacing.unit, color: palette.textHeading, fontWeight: typography.fontWeightMedium }}>
        {label}
        <select value={value} aria-describedby={descriptionId} disabled={loading || saving || (scope !== "global" && !id)}
          onChange={(event) => void change(event.target.value as CallMode | "")}
          style={{ color: palette.textPrimary, background: palette.bgTertiary, border: `1px solid ${palette.border}`, padding: spacing.unit * 2, borderRadius: 6, font: "inherit" }}>
          {scope !== "global" && <option value="">Use default</option>}
          <option value="ring">Ring</option>
          <option value="silent">Silent</option>
          <option value="block">Block calls</option>
        </select>
      </label>
      <small id={descriptionId} style={{ color: palette.textSecondary }}>
        {scope === "global" && "Silent calls can be answered in the room. Public rooms are silent by default."}
        {scope === "room" && "Silent calls appear only in this room. Account and caller restrictions still apply."}
        {scope === "user" && "Applies across rooms. Ring includes public rooms, subject to your room and account settings. You can still message and join voice rooms together."}
      </small>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
