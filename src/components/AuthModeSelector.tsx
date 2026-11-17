import { useId, useState } from "react";
import { CircleHelp } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";

export type AccountMode = "pax-password" | "matrix-password";

/** An optional signup preference; the login form detects this automatically. */
export default function AuthModeSelector({ value, onChange, disabled }: {
  value: AccountMode;
  onChange: (value: AccountMode) => void;
  disabled: boolean;
}) {
  const { palette, typography } = useTheme();
  const [helpOpen, setHelpOpen] = useState(false);
  const helpId = useId();
  return (
    <div style={{ color: palette.textSecondary, fontSize: typography.fontSizeSmall }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          Sign-in:
          <select aria-label="Account sign-in method" value={value} disabled={disabled}
            onChange={(e) => onChange(e.target.value as AccountMode)}
            style={{ font: "inherit", color: palette.textSecondary, background: palette.bgPrimary,
              border: "none", borderRadius: 4, padding: "4px 2px", maxWidth: "100%", cursor: "pointer" }}>
            <option value="pax-password">Pax (recommended)</option>
            <option value="matrix-password">Standard Matrix</option>
          </select>
        </label>
        <button type="button" aria-label="About sign-in methods" aria-expanded={helpOpen}
          aria-controls={helpId} onClick={() => setHelpOpen((open) => !open)}
          style={{ display: "inline-flex", padding: 4, border: "none", borderRadius: 4,
            color: palette.textSecondary, background: "transparent", cursor: "pointer" }}>
          <CircleHelp size={15} aria-hidden="true" />
        </button>
      </div>
      {helpOpen && (
        <div id={helpId} role="region" aria-label="Sign-in methods explained"
          style={{ marginTop: 8, padding: 14, border: `1px solid ${palette.border}`, borderRadius: 8,
            background: palette.bgSecondary, lineHeight: 1.5 }}>
          <p style={{ margin: "0 0 10px" }}><strong style={{ color: palette.textPrimary }}>Pax sign-in</strong> restores
            your backed-up encrypted history with your password when you switch computers or reinstall.
            You won’t need to enter a separate recovery key.</p>
          <p style={{ margin: "0 0 10px" }}>Choose a strong password of at least 12 characters.
            If you forget it and have no unlocked device or emergency recovery information, your encrypted history may be lost.</p>
          <p style={{ margin: "0 0 10px" }}><strong style={{ color: palette.textPrimary }}>Standard Matrix</strong> is
            useful if you want to sign in to other Matrix apps with this same password.
            Restoring encrypted history may require a recovery key or verification from another device.</p>
          <p style={{ margin: "0 0 10px" }}>Pax sign-in uses a different underlying Matrix password, so your
            memorable password won’t sign in to other Matrix apps. Credential export and switching existing accounts are not available yet.</p>
          <p style={{ margin: 0 }}>Pax currently trusts your homeserver to report account sign-in settings correctly.
            Use a homeserver you trust. Either choice lets you chat with other Matrix users.</p>
        </div>
      )}
    </div>
  );
}
