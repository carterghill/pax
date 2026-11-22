import { useRef, useState, type CSSProperties, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTheme } from "../theme/ThemeContext";

type EmailInviteResult = { status: "sent" } | {
  status: "terms";
  service: string;
  policies: { name: string; url: string }[];
};

type ShareLinks = { matrix: string; pax: string };

export default function InviteLinkForm({ roomId, mode }: {
  roomId: string;
  mode: "email" | "link";
}) {
  const { palette, typography } = useTheme();
  const [email, setEmail] = useState("");
  const [terms, setTerms] = useState<Extract<EmailInviteResult, { status: "terms" }> | null>(null);
  const [links, setLinks] = useState<ShareLinks | null>(null);
  const [link, setLink] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");

  const field: CSSProperties = {
    width: "100%", padding: "10px 12px", borderRadius: 8, boxSizing: "border-box",
    background: palette.bgTertiary, color: palette.textPrimary, border: `1px solid ${palette.border}`,
    font: "inherit",
  };
  const button: CSSProperties = {
    padding: "9px 14px", borderRadius: 8, border: 0, background: palette.accent, color: "#fff",
    font: "inherit", cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1,
  };

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setStatus("");
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function shareLinks(): Promise<ShareLinks> {
    return links ? Promise.resolve(links) : invoke<ShareLinks>("room_share_links", { roomId }).then((result) => {
      setLinks(result);
      return result;
    });
  }

  function copy(kind: keyof ShareLinks) {
    void run(async () => {
      const pending = shareLinks().then((result) => {
        setLink(result[kind]);
        return result[kind];
      });
      try {
        if (!links && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
          // WebKit requires starting the clipboard write in the original click.
          const data = pending.then((url) => new Blob([url], { type: "text/plain" }));
          void data.catch(() => {});
          await navigator.clipboard.write([new ClipboardItem({ "text/plain": data })]);
        } else {
          await navigator.clipboard.writeText(await pending);
        }
        setStatus("Room link copied.");
      } catch {
        await pending;
        setError("Select the link to copy it manually.");
      }
    });
  }

  function sendEmail(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const result = await invoke<EmailInviteResult>("invite_by_email", {
        roomId,
        email,
        consent: terms ? { service: terms.service, urls: terms.policies.map(({ url }) => url) } : null,
      });
      setTerms(result.status === "terms" ? result : null);
      if (result.status === "sent") {
        setStatus(`Matrix invitation sent to ${email.trim()}.`);
        setEmail("");
      }
    });
  }

  const feedback = <>
    {error && <p role="alert" style={{ margin: 0, color: "#ed4245" }}>{error}</p>}
    {status && <p role="status" style={{ margin: 0 }}>{status}</p>}
  </>;

  if (mode === "email") {
    return (
      <form onSubmit={sendEmail} style={{ display: "grid", gap: 12, fontSize: typography.fontSizeSmall }}>
        <p style={{ margin: 0, color: palette.textSecondary }}>
          Your Matrix identity service handles email invitations. If the address is linked to an account, Matrix can deliver the invite directly to that account.
        </p>
        <label>
          Email address
          <input type="email" style={{ ...field, marginTop: 4 }} required maxLength={254} autoFocus
            autoComplete="email" disabled={busy} value={email} onChange={(event) => {
              setEmail(event.target.value);
              setTerms(null);
              setError("");
            }}
            placeholder="name@example.com" />
        </label>
        {terms && (
          <section aria-label="Identity service terms">
            <p>Review the terms for {new URL(terms.service).host} before sending this invitation.</p>
            <ul>
              {terms.policies.map(({ name, url }, index) => (
                <li key={`${url}-${index}`}><a href={url} target="_blank" rel="noreferrer" style={{ color: palette.accent }}>{name}</a></li>
              ))}
            </ul>
          </section>
        )}
        {feedback}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="submit" style={button} disabled={busy}>
            {terms ? "Accept terms and invite" : "Send email invitation"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12, fontSize: typography.fontSizeSmall }}>
      <p style={{ margin: 0, color: palette.textSecondary }}>
        Share this room from any homeserver. People still need an invitation for invite-only rooms.
      </p>
      {link && <input aria-label="Room link" style={field} value={link} readOnly
        onFocus={(event) => event.currentTarget.select()} />}
      {feedback}
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" style={button} disabled={busy} onClick={() => copy("matrix")}>Copy Matrix link</button>
        <button type="button" style={button} disabled={busy} onClick={() => copy("pax")}>Copy Pax link</button>
        <button type="button" style={button} disabled={busy} onClick={() => void run(async () => {
          const { matrix, pax } = await shareLinks();
          const subject = encodeURIComponent("Matrix room link");
          const body = encodeURIComponent(`Open in Pax: ${pax}\n\nOpen in a Matrix client: ${matrix}`);
          await openUrl(`mailto:?subject=${subject}&body=${body}`);
        })}>Share by email</button>
      </div>
    </div>
  );
}
