import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, RefreshCw, Rss } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import type { Message } from "../types/matrix";

export interface FeedStatus {
  url: string;
  botUserId: string;
  membership: string;
  roomSynced: boolean;
  canManage: boolean;
  canInvite: boolean;
  autoSetup: boolean;
  subscriptionEventId: string | null;
  subscriptionConfirmed: boolean;
  confirmationError: string | null;
}

type Action = "check" | "setup" | "invite";

export default function RssFeedStatus({ roomId, messages }: { roomId: string; messages: Message[] }) {
  const { palette, typography, spacing } = useTheme();
  const [status, setStatus] = useState<FeedStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [waitingLong, setWaitingLong] = useState(false);
  const runRef = useRef<(action: Action) => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let running = false;
    let setupFailed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    setStatus(null);
    setError(null);
    setCheckError(null);
    setWaitingLong(false);

    const run = async (action: Action = "check") => {
      if (cancelled || running) return;
      running = true;
      clearTimeout(timer);
      setChecking(true);
      let latest: FeedStatus | null = null;
      let operation: Action = "check";
      try {
        latest = await invoke<FeedStatus>("get_rss_feed_status", { roomId });
        if (cancelled) return;
        setStatus(latest);
        setCheckError(null);
        if (latest.subscriptionEventId) {
          setupFailed = false;
          setError(null);
        }
        if (action === "invite" && latest.canInvite && !["join", "ban"].includes(latest.membership)) {
          operation = "invite";
          await invoke("invite_user", { roomId, userId: latest.botUserId });
          if (cancelled) return;
          setError(null);
          operation = "check";
          latest = await invoke<FeedStatus>("get_rss_feed_status", { roomId });
          if (cancelled) return;
          setStatus(latest);
        }
        if (action === "setup") setupFailed = false;
        if (latest.membership === "join" && latest.roomSynced && latest.canManage
          && !latest.subscriptionEventId && !setupFailed && (latest.autoSetup || action === "setup")) {
          operation = "setup";
          setSending(true);
          await invoke("setup_rss_feed", { roomId });
          if (cancelled) return;
          setError(null);
          operation = "check";
          latest = await invoke<FeedStatus>("get_rss_feed_status", { roomId });
          if (cancelled) return;
          setStatus(latest);
        }
        setWaitingLong(latest.membership === "invite" && Date.now() - started >= 60_000);
      } catch (e) {
        if (cancelled) return;
        if (operation !== "check") {
          if (operation === "setup") setupFailed = true;
          setError(String(e));
        } else {
          setCheckError(String(e));
        }
      } finally {
        running = false;
        if (!cancelled) {
          setChecking(false);
          setSending(false);
          timer = setTimeout(() => { void run(); }, latest?.subscriptionEventId ? 30_000 : 5_000);
        }
      }
    };
    runRef.current = (action) => { void run(action); };
    void run();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [roomId]);

  // A loaded timeline can reflect the acknowledgement before the next status poll.
  const command = status?.subscriptionEventId
    ? messages.find((m) => m.eventId === status.subscriptionEventId) : undefined;
  const confirmed = status?.subscriptionConfirmed || command?.reactions?.some(
    (r) => r.key === "✅" && r.reactedBy?.includes(status!.botUserId),
  );
  const providerReply = status?.subscriptionEventId && messages.find(
    (m) => m.sender === status.botUserId && m.replyTo?.eventId === status.subscriptionEventId,
  );
  const joined = status?.membership === "join";
  let title = "Checking feed provider…";
  let detail = "";
  if (status) {
    switch (status.membership) {
      case "invite":
        title = "Waiting for provider to join";
        detail = "Invitation sent. Pax will continue setup when the provider joins.";
        if (waitingLong) detail += " A long delay can indicate a provider or federation problem. You can retry the invitation below.";
        break;
      case "join":
        if (confirmed) {
          title = "Feed subscribed";
          detail = "The provider confirmed the subscription. New feed entries will appear here.";
        } else if (status.subscriptionEventId) {
          title = providerReply ? "Provider replied to setup" : "Subscription sent · awaiting confirmation";
          detail = providerReply
            ? "Check the provider’s message below for the result or any feed errors."
            : "The provider has joined and Pax sent the feed URL. Its response will appear here.";
        } else if (!status.roomSynced) {
          title = "Provider joined · syncing room";
          detail = "Pax will send the subscription once this room finishes syncing.";
        } else {
          title = sending ? "Setting up subscription…" : "Provider joined";
          detail = status.canManage
            ? "The feed subscription is ready to send."
            : "A room moderator with permission to manage feed settings needs to finish setup.";
        }
        break;
      case "leave":
        title = "Provider is not in the room";
        detail = "The provider left or declined its invitation. You can invite it again.";
        break;
      case "ban":
        title = "Provider is banned";
        detail = "A room moderator must unban the provider before it can join.";
        break;
      case "none":
        title = "Provider has not been invited";
        detail = "Invite the provider to finish setting up this feed.";
        break;
      case "knock":
        title = "Provider is requesting to join";
        detail = "Invite the provider to let it into this room.";
        break;
      default:
        title = "Provider membership is unknown";
        detail = "The homeserver returned an unrecognized membership status. Check again in a moment.";
    }
  }
  if (checkError) title = "Could not refresh feed status";
  const buttonStyle = {
    padding: "5px 9px", border: `1px solid ${palette.border}`, borderRadius: 4,
    color: palette.textPrimary, background: palette.bgPrimary, cursor: checking ? "default" : "pointer",
    fontSize: typography.fontSizeSmall, fontFamily: typography.fontFamily, opacity: checking ? 0.6 : 1,
  };
  return (
    <section aria-label="RSS feed status" style={{
      padding: `${spacing.unit * 3}px ${spacing.unit * 4}px`, background: palette.bgSecondary,
      borderBottom: `1px solid ${palette.border}`, flexShrink: 0, maxHeight: "45%", overflowY: "auto",
      color: palette.textPrimary, fontSize: typography.fontSizeSmall,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: spacing.unit * 2 }}>
        {confirmed && joined ? <CheckCircle2 size={17} color={palette.accent} /> : <Rss size={17} color={palette.textSecondary} />}
        <strong role="status" style={{ color: palette.textHeading }}>{title}</strong>
      </div>
      {status && <div style={{ marginTop: 6, color: palette.textSecondary, overflowWrap: "anywhere" }}>
        <div>{status.url}</div>
        <div style={{ marginTop: 3 }}>
          {status.botUserId} · {joined ? "Joined" : status.membership === "invite" ? "Invited" : "Not joined"}
        </div>
      </div>}
      {detail && <p style={{ margin: "8px 0", lineHeight: 1.4 }}>{detail}</p>}
      {(error || checkError || status?.confirmationError) && <p role="alert" style={{ margin: "8px 0", lineHeight: 1.4 }}>
        {checkError || error || status?.confirmationError}
      </p>}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 8 }}>
        <button type="button" disabled={checking} onClick={() => runRef.current("check")} style={buttonStyle}>
          <RefreshCw size={12} style={{ marginRight: 5, verticalAlign: "-2px" }} />
          {checking ? "Checking…" : "Check status"}
        </button>
        {status?.canManage && joined && status.roomSynced && !status.subscriptionEventId && (
          <button type="button" disabled={checking} onClick={() => runRef.current("setup")} style={buttonStyle}>
            {error ? "Retry setup" : "Finish setup"}
          </button>
        )}
        {status?.canInvite && !joined && status.membership !== "ban" && (
          <button type="button" disabled={checking} onClick={() => runRef.current("invite")} style={buttonStyle}>
            {status.membership === "invite" ? "Retry invitation" : "Invite provider"}
          </button>
        )}
      </div>
    </section>
  );
}
