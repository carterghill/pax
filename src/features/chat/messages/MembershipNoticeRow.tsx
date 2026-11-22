import { UsersRound } from "lucide-react";
import type { MembershipNotice } from "../../../types/matrix";
import TimelineNoticeRow from "./TimelineNoticeRow";

interface MembershipNoticeRowProps {
  eventId: string;
  timestamp: number;
  verticalOffset: number;
  notice: MembershipNotice;
  actorLabel: string;
  targetLabel: string;
}

export default function MembershipNoticeRow({
  eventId,
  timestamp,
  verticalOffset,
  notice,
  actorLabel,
  targetLabel,
}: MembershipNoticeRowProps) {
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

  return (
    <TimelineNoticeRow
      eventId={eventId}
      timestamp={timestamp}
      verticalOffset={verticalOffset}
      icon={<UsersRound size={14} aria-hidden="true" />}
    >
      {text}{reason && <> (<bdi>{reason}</bdi>)</>}
    </TimelineNoticeRow>
  );
}
