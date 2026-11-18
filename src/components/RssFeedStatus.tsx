import { useEffect, useRef, useState, type Ref } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CheckCircle2, RefreshCw, Rss } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import type { Message } from "../types/matrix";

export interface FeedSettings {
  url: string;
  botUserId: string;
  revision: string | null;
  invitationCancelled: boolean;
  canEdit: boolean;
}

interface FeedStatus extends FeedSettings {
  membership: string;
  roomSynced: boolean;
  canManage: boolean;
  canInvite: boolean;
  canCancelInvitation: boolean;
  autoSetup: boolean;
  subscriptionEventId: string | null;
  subscriptionConfirmed: boolean;
  confirmationError: string | null;
}

type Action = "check" | "setup" | "invite" | "cancel";

export function useRssFeedStatus(roomId: string | null, messages: Message[]) {
  const [trackedRoomId, setTrackedRoomId] = useState<string | null>(null);
  const [status, setStatus] = useState<FeedStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [waitingLong, setWaitingLong] = useState(false);
  const [panelOverride, setPanelOverride] = useState<{
    roomId: string;
    revision: string | null | undefined;
    expanded: boolean;
  } | null>(null);
  const runRef = useRef<(action: Action, displayedRevision?: string | null) => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let running = false;
    let refreshQueued = false;
    let setupFailed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let revision: string | null | undefined;
    let started = Date.now();
    setTrackedRoomId(roomId);
    setStatus(null);
    setChecking(false);
    setSending(false);
    setError(null);
    setCheckError(null);
    setWaitingLong(false);
    if (!roomId) return;

    const run = async (action: Action = "check", displayedRevision?: string | null) => {
      if (cancelled || running) return;
      running = true;
      clearTimeout(timer);
      setChecking(true);
      let latest: FeedStatus | null = null;
      let operation: Action = "check";
      try {
        latest = await invoke<FeedStatus>("get_rss_feed_status", { roomId });
        if (cancelled) return;
        if (revision !== latest.revision) {
          revision = latest.revision;
          started = Date.now();
          setupFailed = false;
          setError(null);
          setWaitingLong(false);
        }
        setStatus(latest);
        setCheckError(null);
        if (action !== "check" && displayedRevision !== latest.revision) {
          setError("Feed settings changed. Check the current provider and try again.");
          return;
        }
        if (latest.invitationCancelled) return;
        if (latest.subscriptionEventId) {
          setupFailed = false;
          setError(null);
        }
        if (action === "invite" || action === "cancel") {
          operation = action;
          await invoke(action === "invite" ? "invite_rss_feed_provider" : "cancel_rss_feed_invitation", {
            roomId, revision: latest.revision,
          });
          if (cancelled) return;
          setError(null);
          if (action === "cancel") {
            latest = { ...latest, invitationCancelled: true };
            setPanelOverride(null);
            setStatus(latest);
            return;
          }
          operation = "check";
          latest = await invoke<FeedStatus>("get_rss_feed_status", { roomId });
          if (cancelled) return;
          setStatus(latest);
          if (latest.invitationCancelled) return;
        }
        if (action === "setup") setupFailed = false;
        if (latest.membership === "join" && latest.roomSynced && latest.canManage
          && !latest.subscriptionEventId && !setupFailed && (latest.autoSetup || action === "setup")) {
          operation = "setup";
          setSending(true);
          await invoke("setup_rss_feed", { roomId, revision: latest.revision });
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
          if (refreshQueued) {
            refreshQueued = false;
            timer = setTimeout(() => { void run(); }, 0);
          } else if (!latest?.invitationCancelled) {
            timer = setTimeout(() => { void run(); }, latest?.subscriptionEventId ? 30_000 : 5_000);
          }
        }
      }
    };
    runRef.current = (action, displayedRevision) => { void run(action, displayedRevision); };
    const unlisten = listen<string>("rss-feed-changed", ({ payload }) => {
      if (cancelled || payload !== roomId) return;
      if (running) refreshQueued = true;
      else void run();
    });
    void unlisten.catch(() => {});
    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void unlisten.then((stop) => stop(), () => {});
    };
  }, [roomId]);

  if (!roomId || trackedRoomId !== roomId) return null;

  // A loaded timeline can reflect the acknowledgement before the next status poll.
  const command = status?.subscriptionEventId
    ? messages.find((m) => m.eventId === status.subscriptionEventId) : undefined;
  const confirmed = status?.subscriptionConfirmed || command?.reactions?.some(
    (r) => r.key === "✅" && r.reactedBy?.includes(status!.botUserId),
  );
  const providerReply = status?.subscriptionEventId && messages.find(
    (m) => m.sender === status.botUserId && m.replyTo?.eventId === status.subscriptionEventId,
  );
  const paused = !!status?.invitationCancelled;
  const joined = !paused && status?.membership === "join";
  let title = "Checking feed provider…";
  let label = "Checking…";
  let detail = "";
  if (paused) {
    title = "Feed setup paused";
    label = "Paused";
    detail = "The provider invitation was cancelled. You can resume setup in Room Settings → RSS Feed.";
  } else if (status) {
    switch (status.membership) {
      case "invite":
        title = "Waiting for provider to join";
        label = "Invited";
        detail = "Invitation sent. Pax will continue setup when the provider joins.";
        if (waitingLong) detail += " A long delay can indicate a provider or federation problem. You can retry the invitation below.";
        break;
      case "join":
        if (confirmed) {
          title = "Feed subscribed";
          label = "Subscribed";
          detail = "The provider confirmed the subscription. New feed entries will appear here.";
        } else if (status.subscriptionEventId) {
          title = providerReply ? "Provider replied to setup" : "Subscription sent · awaiting confirmation";
          label = providerReply ? "Replied" : "Awaiting reply";
          detail = providerReply
            ? "Check the provider’s message below for the result or any feed errors."
            : "The provider has joined and Pax sent the feed URL. Its response will appear here.";
        } else if (!status.roomSynced) {
          title = "Provider joined · syncing room";
          label = "Syncing…";
          detail = "Pax will send the subscription once this room finishes syncing.";
        } else {
          title = sending ? "Setting up subscription…" : "Provider joined";
          label = sending ? "Setting up…" : "Joined";
          detail = status.canManage
            ? "The feed subscription is ready to send."
            : "A room moderator with permission to manage feed settings needs to finish setup.";
        }
        break;
      case "leave":
        title = "Provider is not in the room";
        label = "Not joined";
        detail = "The provider left or declined its invitation. You can invite it again.";
        break;
      case "ban":
        title = "Provider is banned";
        label = "Banned";
        detail = "A room moderator must unban the provider before it can join.";
        break;
      case "none":
        title = "Provider has not been invited";
        label = "Not invited";
        detail = "Invite the provider to finish setting up this feed.";
        break;
      case "knock":
        title = "Provider is requesting to join";
        label = "Requested to join";
        detail = "Invite the provider to let it into this room.";
        break;
      default:
        title = "Provider membership is unknown";
        label = "Unknown";
        detail = "The homeserver returned an unrecognized membership status. Check again in a moment.";
    }
  }
  const panelError = checkError || error || status?.confirmationError;
  if (checkError) title = "Could not refresh feed status";
  if (panelError) label = "Check status";

  // Keep the setup controls visible while a provider still needs to join or receive the command.
  const defaultExpanded = !paused && (status ? !joined || !status.subscriptionEventId : !!checkError);
  const hasOverride = panelOverride?.roomId === roomId
    && (panelOverride.revision === undefined || panelOverride.revision === status?.revision);
  const expanded = hasOverride ? panelOverride.expanded : defaultExpanded;

  return {
    status, checking, title, label, detail, panelError, expanded, joined, confirmed, paused,
    setExpanded: (value: boolean) => setPanelOverride({ roomId, revision: status?.revision, expanded: value }),
    run: (action: Action) => runRef.current(action, status?.revision),
  };
}

type RssFeedView = NonNullable<ReturnType<typeof useRssFeedStatus>>;

export function RssFeedStatusToggle({ feed, panelId, buttonRef }: {
  feed: RssFeedView;
  panelId: string;
  buttonRef: Ref<HTMLButtonElement>;
}) {
  const { palette, typography, spacing } = useTheme();
  const { status, expanded, label, joined, confirmed, panelError } = feed;
  const ellipsis = { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" } as const;
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-expanded={expanded}
      aria-controls={panelId}
      title={[status?.url, status?.botUserId, feed.title].filter(Boolean).join("\n")}
      onClick={() => feed.setExpanded(!expanded)}
      style={{
        background: expanded ? palette.bgActive : "transparent", color: palette.textPrimary,
        border: "none", borderRadius: 4, cursor: "pointer", minWidth: 0,
        padding: `3px ${spacing.unit}px`, display: "flex", alignItems: "center", gap: spacing.unit * 2,
        fontFamily: typography.fontFamily, fontSize: typography.fontSizeSmall, lineHeight: 1.3, textAlign: "left",
      }}
    >
      <span style={{ display: "grid", minWidth: 0 }}>
        <span style={ellipsis}>{status?.url.replace(/^https?:\/\//, "") || "RSS feed"}</span>
        {status && <span style={{ ...ellipsis, color: palette.textSecondary }}>{status.botUserId}</span>}
      </span>
      <span style={{ ...ellipsis, flexShrink: 0, maxWidth: "60%", color: confirmed && joined && !panelError ? palette.accent : palette.textSecondary }}>
        {label}
      </span>
    </button>
  );
}

export function RssFeedStatusPanel({ feed, id, onHide }: { feed: RssFeedView; id: string; onHide: () => void }) {
  const { palette, typography, spacing } = useTheme();
  const { status, checking, title, detail, panelError, expanded, joined, confirmed, paused, run } = feed;
  const buttonStyle = {
    padding: "5px 9px", border: `1px solid ${palette.border}`, borderRadius: 4,
    color: palette.textPrimary, background: palette.bgPrimary, cursor: checking ? "default" : "pointer",
    fontSize: typography.fontSizeSmall, fontFamily: typography.fontFamily, opacity: checking ? 0.6 : 1,
  };
  return (
    <section id={id} hidden={!expanded} aria-label="RSS feed status" style={{
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
          {status.botUserId} · {paused ? "Paused" : joined ? "Joined" : status.membership === "invite" ? "Invited" : "Not joined"}
        </div>
      </div>}
      {detail && <p style={{ margin: "8px 0", lineHeight: 1.4 }}>{detail}</p>}
      {panelError && <p role="alert" style={{ margin: "8px 0", lineHeight: 1.4 }}>
        {panelError}
      </p>}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 8 }}>
        <button type="button" disabled={checking} onClick={() => run("check")} style={buttonStyle}>
          <RefreshCw size={12} style={{ marginRight: 5, verticalAlign: "-2px" }} />
          {checking ? "Checking…" : "Check status"}
        </button>
        <button type="button" onClick={onHide} style={{ ...buttonStyle, cursor: "pointer", opacity: 1 }}>
          Hide
        </button>
        {status?.canManage && joined && status.roomSynced && !status.subscriptionEventId && (
          <button type="button" disabled={checking} onClick={() => run("setup")} style={buttonStyle}>
            {panelError ? "Retry setup" : "Finish setup"}
          </button>
        )}
        {!paused && status?.canInvite && !joined && status.membership !== "ban" && (
          <button type="button" disabled={checking} onClick={() => run("invite")} style={buttonStyle}>
            {status.membership === "invite" ? "Retry invitation" : "Invite provider"}
          </button>
        )}
        {!paused && status?.canCancelInvitation && status.membership === "invite" && (
          <button type="button" disabled={checking} onClick={() => run("cancel")} style={buttonStyle}>
            Cancel invitation
          </button>
        )}
      </div>
    </section>
  );
}
