import type { ReactNode } from "react";
import { useTheme } from "../../../theme/ThemeContext";
import { formatMessageTime } from "./MessageRow";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface TimelineNoticeRowProps {
  eventId: string;
  incomingCallId?: string;
  timestamp: number;
  timeLabel?: string;
  icon: ReactNode;
  children: ReactNode;
}

export default function TimelineNoticeRow({ eventId, incomingCallId, timestamp, timeLabel, icon, children }: TimelineNoticeRowProps) {
  const { palette, spacing, typography } = useTheme();
  const date = new Date(timestamp);

  return (
    <div
      data-message-event-id={eventId}
      data-incoming-call-id={incomingCallId}
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
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
        {children}
      </span>
      {Number.isFinite(date.getTime()) && (
        <time
          dateTime={date.toISOString()}
          title={[timeLabel, formatMessageTime(timestamp)].filter(Boolean).join(" ")}
          style={{ whiteSpace: "nowrap" }}
        >
          {timeLabel && `${timeLabel} `}
          {Date.now() - timestamp > ONE_DAY_MS
            ? date.toLocaleDateString()
            : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      )}
    </div>
  );
}
