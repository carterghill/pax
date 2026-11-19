import { UsersRound } from "lucide-react";
import { useTheme } from "../../../theme/ThemeContext";
import type { MembershipNotice } from "../../../types/matrix";
import { formatMessageTime } from "./MessageRow";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface MembershipNoticeRowProps {
  eventId: string;
  timestamp: number;
  notice: MembershipNotice;
  actorLabel: string;
  targetLabel: string;
}

export default function MembershipNoticeRow({
  eventId,
  timestamp,
  notice,
  actorLabel,
  targetLabel,
}: MembershipNoticeRowProps) {
  const { palette, spacing, typography } = useTheme();
  const actor = <bdi>{actorLabel}</bdi>;
  const target = <bdi>{targetLabel}</bdi>;
  const text = {
    joined: <>{target} joined the room</>,
    left: <>{target} left the room</>,
    invited: <>{actor} invited {target}</>,
    inviteDeclined: <>{target} declined the invitation</>,
    inviteRevoked: <>{actor} withdrew the invitation for {target}</>,
    kicked: <>{actor} removed {target}</>,
    banned: <>{actor} banned {target}</>,
    unbanned: <>{actor} unbanned {target}</>,
    knocked: <>{target} requested to join the room</>,
    knockAccepted: <>{actor} accepted {target}’s join request</>,
    knockRetracted: <>{target} withdrew their join request</>,
    knockDenied: <>{actor} denied {target}’s join request</>,
  }[notice.action];
  const reason = notice.reason?.trim();
  const date = new Date(timestamp);

  return (
    <div
      data-message-event-id={eventId}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "baseline",
        gap: spacing.unit * 3,
        padding: `${spacing.unit}px ${spacing.unit * 2}px ${spacing.unit}px ${spacing.unit * 4}px`,
        color: palette.textSecondary,
        fontSize: typography.fontSizeSmall,
        lineHeight: typography.lineHeight,
      }}
    >
      <span style={{
        display: "flex",
        width: 40,
        flexShrink: 0,
        justifyContent: "center",
        alignSelf: "flex-start",
        paddingTop: 2,
      }}>
        <UsersRound size={14} aria-hidden="true" />
      </span>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
        {text}{reason && <> (<bdi>{reason}</bdi>)</>}
      </span>
      {Number.isFinite(date.getTime()) && (
        <time
          dateTime={date.toISOString()}
          title={formatMessageTime(timestamp)}
          style={{ whiteSpace: "nowrap" }}
        >
          {Date.now() - timestamp > ONE_DAY_MS
            ? date.toLocaleDateString()
            : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      )}
    </div>
  );
}
