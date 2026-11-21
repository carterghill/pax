import { useState } from "react";
import { useIgnoredUsers } from "../context/IgnoredUsersContext";
import { useTheme } from "../theme/ThemeContext";

export default function IgnoredUsersSettings() {
  const { palette, spacing, typography } = useTheme();
  const { userIds, loading, loadError, reload, setIgnored } = useIgnoredUsers();
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function unignore(userId: string) {
    setSaving(userId);
    setError(null);
    try {
      await setIgnored(userId, false);
    } catch (cause) {
      setError(`Couldn’t unignore ${userId}. ${String(cause)}`);
    } finally {
      setSaving(null);
    }
  }

  const buttonStyle = {
    padding: `${spacing.unit * 1.5}px ${spacing.unit * 2.5}px`,
    border: `1px solid ${palette.border}`,
    borderRadius: 6,
    font: "inherit",
    color: palette.textPrimary,
    backgroundColor: palette.bgSecondary,
    cursor: "pointer",
  };

  return (
    <div style={{ marginBottom: spacing.unit * 5 }}>
      <h3 style={{ color: palette.textHeading, fontSize: typography.fontSizeLarge, margin: 0 }}>Ignored users</h3>
      <p style={{ color: palette.textSecondary, margin: `${spacing.unit}px 0 ${spacing.unit * 3}px` }}>
        Messages and room invites from these users are hidden across your Matrix account.
      </p>
      {loading && <p role="status">Loading ignored users…</p>}
      {loadError && (
        <div role="alert">
          <p>Couldn’t load ignored users. {loadError}</p>
          <button type="button" style={buttonStyle} onClick={() => void reload()}>Retry</button>
        </div>
      )}
      {!loading && !loadError && !userIds.size && (
        <p style={{ color: palette.textSecondary }}>You haven’t ignored anyone.</p>
      )}
      {userIds.size > 0 && (
        <ul style={{ padding: 0, margin: 0, listStyle: "none", display: "grid", gap: spacing.unit * 2 }}>
          {[...userIds].map((id) => (
            <li key={id} style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: spacing.unit * 3,
              padding: spacing.unit * 2,
              border: `1px solid ${palette.border}`,
              borderRadius: 8,
              backgroundColor: palette.bgTertiary,
            }}>
              <bdi style={{ overflowWrap: "anywhere" }}>{id}</bdi>
              <button type="button" style={buttonStyle} disabled={saving !== null} onClick={() => void unignore(id)}>
                {saving === id ? "Unignoring…" : "Unignore"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
