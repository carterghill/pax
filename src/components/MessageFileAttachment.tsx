import { memo } from "react";
import { useTheme } from "../theme/ThemeContext";
import { fileTypeIconMeta } from "../utils/mediaViewer";

interface MessageFileAttachmentProps {
  fileName: string;
  mimeType: string | null | undefined;
  onOpen: () => void;
}

const MessageFileAttachment = memo(function MessageFileAttachment({
  fileName,
  mimeType,
  onOpen,
}: MessageFileAttachmentProps) {
  const { palette, typography, spacing } = useTheme();
  const { Icon, label } = fileTypeIconMeta(mimeType, fileName);

  return (
    <button
      type="button"
      title={fileName}
      aria-label={`Open ${label}: ${fileName}`}
      onClick={onOpen}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: spacing.unit * 1.5,
        maxWidth: "100%",
        marginTop: spacing.unit,
        marginBottom: spacing.unit * 0.5,
        padding: `${spacing.unit * 1.25}px ${spacing.unit * 2}px`,
        borderRadius: spacing.unit * 1.5,
        border: `1px solid ${palette.border}`,
        backgroundColor: palette.bgTertiary,
        color: palette.textPrimary,
        cursor: "pointer",
        fontFamily: typography.fontFamily,
        fontSize: typography.fontSizeSmall,
        textAlign: "left",
        transition: "background-color 0.12s ease, border-color 0.12s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = palette.bgHover;
        e.currentTarget.style.borderColor = palette.border;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = palette.bgTertiary;
      }}
    >
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
    </button>
  );
});

export default MessageFileAttachment;
