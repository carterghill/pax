import { memo } from "react";
import { useTheme } from "../theme/ThemeContext";
import { fileTypeIconMeta } from "../utils/mediaViewer";

interface MessageFileAttachmentProps {
  fileName: string;
  mimeType: string | null | undefined;
  onOpen: () => void;
  /** When true, the chip is not clickable (e.g. upload still in progress). */
  disabled?: boolean;
}

const MessageFileAttachment = memo(function MessageFileAttachment({
  fileName,
  mimeType,
  onOpen,
  disabled = false,
}: MessageFileAttachmentProps) {
  const { palette, typography, spacing } = useTheme();
  const { Icon, label } = fileTypeIconMeta(mimeType, fileName);

  const chipStyle = {
    display: "inline-flex" as const,
    alignItems: "center" as const,
    gap: spacing.unit * 1.5,
    maxWidth: "100%" as const,
    marginTop: spacing.unit,
    marginBottom: spacing.unit * 0.5,
    padding: `${spacing.unit * 1.25}px ${spacing.unit * 2}px`,
    borderRadius: spacing.unit * 1.5,
    border: `1px solid ${palette.border}`,
    backgroundColor: palette.bgTertiary,
    color: palette.textPrimary,
    cursor: disabled ? ("default" as const) : ("pointer" as const),
    fontFamily: typography.fontFamily,
    fontSize: typography.fontSizeSmall,
    textAlign: "left" as const,
    transition: "background-color 0.12s ease, border-color 0.12s ease",
    opacity: disabled ? 0.92 : 1,
  };

  const inner = (
    <>
      <Icon
        size={18}
        strokeWidth={2}
        style={{ flexShrink: 0, color: palette.textSecondary }}
        aria-hidden
      />
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {fileName}
      </span>
    </>
  );

  if (disabled) {
    return (
      <div
        title={fileName}
        aria-label={`${label}: ${fileName} (uploading)`}
        style={chipStyle}
      >
        {inner}
      </div>
    );
  }

  return (
    <button
      type="button"
      title={fileName}
      aria-label={`Open ${label}: ${fileName}`}
      onClick={onOpen}
      style={chipStyle}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = palette.bgHover;
        e.currentTarget.style.borderColor = palette.border;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = palette.bgTertiary;
      }}
    >
      {inner}
    </button>
  );
});

export default MessageFileAttachment;
