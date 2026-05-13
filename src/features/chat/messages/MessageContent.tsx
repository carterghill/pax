import { Video } from "lucide-react";
import type { Message } from "../../../types/matrix";
import type { useTheme } from "../../../theme/ThemeContext";
import type { MediaViewerOpenPayload } from "../../../components/MediaViewerModal";
import MessageMarkdown from "../../../components/MessageMarkdown";
import MessageMatrixImage from "../../../components/MessageMatrixImage";
import MessageMatrixVideo from "../../../components/MessageMatrixVideo";
import MessageFileAttachment from "../../../components/MessageFileAttachment";
import CircularUploadRing from "../../../components/CircularUploadRing";
import { inferMediaViewerKind } from "../../../utils/mediaViewer";

const UPLOAD_RING_SIZE = 16;
const UPLOAD_RING_STROKE = 2;

function shouldShowCaptionBelowMedia(msg: Message): boolean {
  const body = msg.body.trim();
  if (!body) return false;
  const fname = (msg.fileDisplayName ?? "").trim();
  if (fname && body === fname) {
    const hasAttachmentUi =
      msg.localImagePreviewObjectUrl != null ||
      msg.imageMediaRequest != null ||
      msg.videoMediaRequest != null ||
      msg.fileMediaRequest != null ||
      msg.localFileUpload != null;
    if (hasAttachmentUi) return false;
  }
  return true;
}

interface MessageContentProps {
  msg: Message;
  spacingUnit: number;
  palette: ReturnType<typeof useTheme>["palette"];
  typography: ReturnType<typeof useTheme>["typography"];
  onOpenMediaViewer: (payload: MediaViewerOpenPayload) => void;
  onOpenDirectImage: (url: string, title: string) => void;
  onOpenSenderProfile?: (senderUserId: string) => void;
  resolveMemberLabel?: (userId: string) => string;
}

export default function MessageContent({
  msg,
  spacingUnit,
  palette,
  typography,
  onOpenMediaViewer,
  onOpenDirectImage,
  onOpenSenderProfile,
  resolveMemberLabel,
}: MessageContentProps) {
  const uploadRing =
    msg.localFileUpload && msg.localFileUpload.phase !== "failed" ? (
      <CircularUploadRing
        progress={msg.localFileUpload.progress}
        size={UPLOAD_RING_SIZE}
        strokeWidth={UPLOAD_RING_STROKE}
      />
    ) : null;

  let mediaElement: React.ReactNode = null;
  let showCaption: boolean;
  let captionBody = msg.body;
  let showUploadError = false;

  if (msg.localImagePreviewObjectUrl && msg.imageMediaRequest == null) {
    mediaElement = (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: spacingUnit * 1.5,
          maxWidth: "100%",
          marginTop: spacingUnit,
          marginBottom: spacingUnit,
        }}
      >
        <img
          src={msg.localImagePreviewObjectUrl}
          alt=""
          draggable={false}
          style={{
            maxWidth: "100%",
            maxHeight: 400,
            height: "auto",
            objectFit: "contain",
            borderRadius: spacingUnit,
            display: "block",
          }}
        />
        {uploadRing}
      </div>
    );
    showCaption = shouldShowCaptionBelowMedia(msg);
    showUploadError = true;
  } else if (msg.imageMediaRequest != null) {
    mediaElement = (
      <MessageMatrixImage
        request={msg.imageMediaRequest}
        metaWidth={msg.imageWidth}
        metaHeight={msg.imageHeight}
        onExpand={() =>
          onOpenMediaViewer({
            kind: "image",
            request: msg.imageMediaRequest,
            fileName: msg.body.trim() || "Image",
            mimeType: null,
          })
        }
      />
    );
    showCaption = msg.body.trim().length > 0;
  } else if (
    msg.fileMime?.startsWith("video/") &&
    msg.localFileUpload &&
    msg.videoMediaRequest == null
  ) {
    mediaElement = (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: spacingUnit * 1.5,
          maxWidth: "100%",
          marginTop: spacingUnit,
          marginBottom: spacingUnit * 0.5,
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: spacingUnit * 1.5,
            minWidth: 0,
            padding: `${spacingUnit * 1.25}px ${spacingUnit * 2}px`,
            borderRadius: spacingUnit * 1.5,
            border: `1px solid ${palette.border}`,
            backgroundColor: palette.bgTertiary,
            color: palette.textPrimary,
            fontFamily: typography.fontFamily,
            fontSize: typography.fontSizeSmall,
          }}
        >
          <Video
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
            {msg.fileDisplayName ?? "Video"}
          </span>
        </div>
        {uploadRing}
      </div>
    );
    showCaption = shouldShowCaptionBelowMedia(msg);
    showUploadError = true;
  } else if (msg.videoMediaRequest != null) {
    mediaElement = (
      <MessageMatrixVideo
        request={msg.videoMediaRequest}
        metaWidth={msg.videoWidth}
        metaHeight={msg.videoHeight}
        mimeType={msg.fileMime}
      />
    );
    showCaption = shouldShowCaptionBelowMedia(msg);
  } else if (msg.fileMediaRequest != null) {
    mediaElement = (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: spacingUnit * 1.5,
          maxWidth: "100%",
        }}
      >
        <MessageFileAttachment
          fileName={msg.fileDisplayName ?? "Attachment"}
          mimeType={msg.fileMime}
          disabled={Boolean(
            msg.localFileUpload && msg.localFileUpload.phase !== "failed",
          )}
          onOpen={() =>
            onOpenMediaViewer({
              kind: inferMediaViewerKind(
                msg.fileMime,
                msg.fileDisplayName ?? "",
              ),
              request: msg.fileMediaRequest,
              fileName: msg.fileDisplayName ?? "Attachment",
              mimeType: msg.fileMime ?? null,
            })
          }
        />
        {uploadRing}
      </div>
    );
    showCaption = shouldShowCaptionBelowMedia(msg);
    showUploadError = true;
  } else if (
    msg.localFileUpload &&
    msg.fileDisplayName &&
    msg.fileMediaRequest == null &&
    !msg.localImagePreviewObjectUrl &&
    !msg.fileMime?.startsWith("video/")
  ) {
    mediaElement = (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: spacingUnit * 1.5,
          maxWidth: "100%",
        }}
      >
        <MessageFileAttachment
          fileName={msg.fileDisplayName}
          mimeType={msg.fileMime}
          disabled={msg.localFileUpload.phase !== "failed"}
          onOpen={() => {}}
        />
        {uploadRing}
      </div>
    );
    showCaption = shouldShowCaptionBelowMedia(msg);
    showUploadError = true;
  } else {
    showCaption = true;
    captionBody = msg.unsupportedMatrixMsgtype?.trim()
      ? `${msg.body} · ${msg.unsupportedMatrixMsgtype.trim()}`
      : msg.body;
  }

  return (
    <>
      {mediaElement}
      {showCaption && (
        <MessageMarkdown
          edited={Boolean(msg.edited)}
          onOpenDirectImage={onOpenDirectImage}
          mentionedUserIds={msg.mentionedUserIds}
          resolveMemberLabel={resolveMemberLabel}
          onMentionClick={onOpenSenderProfile}
        >
          {captionBody}
        </MessageMarkdown>
      )}
      {showUploadError && msg.localFileUpload?.phase === "failed" && (
        <p
          style={{
            margin: `${spacingUnit}px 0 0`,
            color: palette.textSecondary,
            fontSize: typography.fontSizeSmall,
          }}
        >
          {msg.localFileUpload.errorMessage ?? "Could not send file."}
        </p>
      )}
    </>
  );
}
