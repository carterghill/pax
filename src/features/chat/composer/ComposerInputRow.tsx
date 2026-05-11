import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  RefObject,
} from "react";
import { Paperclip, Send, Smile } from "lucide-react";
import type { ThemePalette, ThemeSpacing, ThemeTypography } from "../../../theme/types";
import { EMOJI_ONLY_DISPLAY_SCALE } from "../../../utils/emojifyTwemoji";
import type { EditingMessageRef } from "../../../components/MessageInput";
import { ComposerFormattingToggle } from "./ComposerFormattingToolbar";
import type { PendingAttachment } from "./fileUpload";

interface ComposerInputRowProps {
  fileInputRef: RefObject<HTMLInputElement | null>;
  editorRef: RefObject<HTMLDivElement | null>;
  pickerAnchorRef: RefObject<HTMLButtonElement | null>;
  pendingFile: PendingAttachment | null;
  draftDmPeerUserId?: string | null;
  interactionLocked: boolean;
  plainText: string;
  hasComposerMedia: boolean;
  emojiOnlyComposer: boolean;
  placeholderText: string;
  composerMaxHeightPx: number;
  pickerOpen: boolean;
  formatOpen: boolean;
  canSend: boolean;
  editingMessage: EditingMessageRef | null;
  palette: ThemePalette;
  typography: ThemeTypography;
  spacing: ThemeSpacing;
  inputToolBtnSize: number;
  inputToolBtnRadius: number;
  inputToolIconSize: number;
  onFileSelected: (event: ChangeEvent<HTMLInputElement>) => void;
  onEditorInput: (event: FormEvent<HTMLDivElement>) => void;
  onEditorKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onEditorPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  onPickerToggle: () => void;
  onFormatToggle: () => void;
  onSend: () => void;
  onHoverToolButton: (
    event: MouseEvent<HTMLButtonElement>,
    active: boolean,
    entering: boolean,
  ) => void;
}

export default function ComposerInputRow({
  fileInputRef,
  editorRef,
  pickerAnchorRef,
  pendingFile,
  draftDmPeerUserId = null,
  interactionLocked,
  plainText,
  hasComposerMedia,
  emojiOnlyComposer,
  placeholderText,
  composerMaxHeightPx,
  pickerOpen,
  formatOpen,
  canSend,
  editingMessage,
  palette,
  typography,
  spacing,
  inputToolBtnSize,
  inputToolBtnRadius,
  inputToolIconSize,
  onFileSelected,
  onEditorInput,
  onEditorKeyDown,
  onEditorPaste,
  onPickerToggle,
  onFormatToggle,
  onSend,
  onHoverToolButton,
}: ComposerInputRowProps) {
  const uploadDisabled = !!pendingFile || !!draftDmPeerUserId || interactionLocked;
  const composerFontSize = emojiOnlyComposer
    ? typography.fontSizeBase * EMOJI_ONLY_DISPLAY_SCALE
    : typography.fontSizeBase;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        minHeight: spacing.unit * 11,
        minWidth: 0,
        flexWrap: "nowrap",
        overflowX: "auto",
        overflowY: "hidden",
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: "none" }}
        onChange={onFileSelected}
      />
      <button
        type="button"
        title={
          draftDmPeerUserId
            ? "Send a message first to create the conversation"
            : pendingFile
              ? "File attached"
              : "Upload file"
        }
        aria-label={
          draftDmPeerUserId
            ? "Upload disabled until conversation exists"
            : pendingFile
              ? "File attached"
              : "Upload file"
        }
        disabled={uploadDisabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => fileInputRef.current?.click()}
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: inputToolBtnSize,
          height: inputToolBtnSize,
          padding: 0,
          marginLeft: spacing.unit * 2,
          marginRight: 0,
          border: "none",
          borderRadius: inputToolBtnRadius,
          backgroundColor: "transparent",
          color: palette.textSecondary,
          cursor: uploadDisabled ? "default" : "pointer",
          opacity: uploadDisabled ? 0.35 : 1,
        }}
        onMouseEnter={(e) => {
          if (uploadDisabled) return;
          e.currentTarget.style.backgroundColor = palette.bgHover;
          e.currentTarget.style.color = palette.textPrimary;
        }}
        onMouseLeave={(e) => {
          if (uploadDisabled) return;
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.color = palette.textSecondary;
        }}
      >
        <Paperclip size={inputToolIconSize} strokeWidth={2} />
      </button>

      <div
        style={{
          position: "relative",
          flex: 1,
          minWidth: 0,
          alignSelf: "stretch",
        }}
      >
        {((!plainText.trim() && !hasComposerMedia) || interactionLocked) && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              right: 0,
              padding: `${spacing.unit * 3}px ${spacing.unit * 2}px ${spacing.unit * 3}px ${spacing.unit * 2}px`,
              pointerEvents: "none",
              color: palette.textSecondary,
              fontSize: composerFontSize,
              fontFamily: `${typography.fontFamily}, var(--pax-twemoji-font-stack)`,
              lineHeight: typography.lineHeight,
              whiteSpace: "nowrap",
              overflow: "hidden",
              boxSizing: "border-box",
              WebkitMaskImage: `linear-gradient(to right, #fff 0%, #fff calc(100% - ${spacing.unit * 5}px), transparent 100%)`,
              maskImage: `linear-gradient(to right, #fff 0%, #fff calc(100% - ${spacing.unit * 5}px), transparent 100%)`,
            }}
          >
            {placeholderText}
          </div>
        )}
        <div
          ref={editorRef}
          data-pax-composer
          contentEditable={!interactionLocked}
          role="textbox"
          aria-multiline="true"
          aria-label={placeholderText}
          suppressContentEditableWarning
          onInput={onEditorInput}
          onKeyDown={onEditorKeyDown}
          onPaste={onEditorPaste}
          style={{
            minWidth: 0,
            width: "100%",
            background: "none",
            border: "none",
            outline: "none",
            color: palette.textPrimary,
            fontSize: composerFontSize,
            fontFamily: `${typography.fontFamily}, var(--pax-twemoji-font-stack)`,
            lineHeight: typography.lineHeight,
            padding: `${spacing.unit * 3}px ${spacing.unit * 2}px ${spacing.unit * 3}px ${spacing.unit * 2}px`,
            maxHeight: composerMaxHeightPx,
            overflowY: "hidden",
            boxSizing: "border-box",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            opacity: interactionLocked ? 0.65 : 1,
            cursor: interactionLocked ? "default" : "text",
          }}
        />
      </div>

      <div
        style={{
          flexShrink: 0,
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
      >
        <div style={{ position: "relative", flexShrink: 0 }}>
          <button
            ref={pickerAnchorRef}
            type="button"
            title="Emoji & GIF"
            aria-label="Emoji & GIF"
            aria-expanded={pickerOpen}
            aria-haspopup="dialog"
            disabled={interactionLocked}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onPickerToggle}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: inputToolBtnSize,
              height: inputToolBtnSize,
              padding: 0,
              margin: spacing.unit,
              marginRight: spacing.unit * 0.75,
              border: "none",
              borderRadius: inputToolBtnRadius,
              backgroundColor: pickerOpen ? palette.bgHover : "transparent",
              color: pickerOpen ? palette.textPrimary : palette.textSecondary,
              cursor: interactionLocked ? "default" : "pointer",
              opacity: interactionLocked ? 0.35 : 1,
            }}
            onMouseEnter={(e) => {
              if (interactionLocked) return;
              onHoverToolButton(e, pickerOpen, true);
            }}
            onMouseLeave={(e) => {
              if (interactionLocked) return;
              onHoverToolButton(e, pickerOpen, false);
            }}
          >
            <Smile size={inputToolIconSize} strokeWidth={2} />
          </button>
        </div>
      </div>

      <ComposerFormattingToggle
        formatOpen={formatOpen}
        interactionLocked={interactionLocked}
        palette={palette}
        spacing={spacing}
        inputToolBtnSize={inputToolBtnSize}
        inputToolBtnRadius={inputToolBtnRadius}
        inputToolIconSize={inputToolIconSize}
        onToggleFormatOpen={onFormatToggle}
        onHoverToolButton={onHoverToolButton}
      />

      <button
        type="button"
        title={editingMessage ? "Save edit" : "Send message"}
        aria-label={editingMessage ? "Save edit" : "Send message"}
        disabled={!canSend}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onSend}
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: inputToolBtnSize,
          height: inputToolBtnSize,
          padding: 0,
          marginTop: spacing.unit,
          marginBottom: spacing.unit,
          marginLeft: 0,
          marginRight: spacing.unit * 2,
          border: "none",
          borderRadius: inputToolBtnRadius,
          backgroundColor: "transparent",
          color: palette.textSecondary,
          cursor: canSend ? "pointer" : "default",
          opacity: canSend ? 1 : 0.45,
        }}
        onMouseEnter={(e) => {
          if (!canSend) return;
          e.currentTarget.style.backgroundColor = palette.bgHover;
          e.currentTarget.style.color = palette.textPrimary;
        }}
        onMouseLeave={(e) => {
          if (!canSend) return;
          e.currentTarget.style.backgroundColor = "transparent";
          e.currentTarget.style.color = palette.textSecondary;
        }}
      >
        <Send size={inputToolIconSize} strokeWidth={2} />
      </button>
    </div>
  );
}
