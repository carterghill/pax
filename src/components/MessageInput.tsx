import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
} from "react";

import type { Message } from "../types/matrix";
import { useTheme } from "../theme/ThemeContext";
import { paletteComposerOuterBorderStyle } from "../theme/paletteBorder";
import { EMOJI_ONLY_DISPLAY_SCALE, isOnlyEmojisAndWhitespace } from "../utils/emojifyTwemoji";
import { hrefLooksLikeDirectImageUrl } from "../utils/directImageUrl";
import {
  fillComposerEditorFromMarkdown,
  getEditorPlainText,
  insertPlainTextAtSelection,
  insertImageAtSelection,
  syncComposerHeightAfterImages,
} from "../utils/composerEditorDom";
import { MODAL_LAYER_Z } from "./ModalLayer";
import { useComposerFileUpload } from "../features/chat/composer/useComposerFileUpload";
import { useComposerTypingNotice } from "../features/chat/composer/useComposerTypingNotice";
import { useComposerMentions } from "../features/chat/composer/useComposerMentions";
import {
  useComposerSubmit,
  type EditingMessageRef,
  type MessageFileSendBridge,
} from "../features/chat/composer/useComposerSubmit";
import { useComposerFormatting } from "../features/chat/composer/useComposerFormatting";
import { useComposerPicker } from "../features/chat/composer/useComposerPicker";
import ComposerContextBar from "../features/chat/composer/ComposerContextBar";
import ComposerFormattingToolbar from "../features/chat/composer/ComposerFormattingToolbar";
import ComposerMediaPickerPopover from "../features/chat/composer/ComposerMediaPickerPopover";
import MentionAutocompleteMenu from "../features/chat/composer/MentionAutocompleteMenu";
import ComposerInputRow from "../features/chat/composer/ComposerInputRow";

export type ComposerPermission = "loading" | "allowed" | "forbidden";
export type { EditingMessageRef, MessageFileSendBridge };

interface MessageInputProps {
  roomId: string;
  roomName: string;
  onMessageSent: () => void;
  /** When set, the next text send is a Matrix rich reply to this message. */
  replyDraft?: Message | null;
  onCancelReply?: () => void;
  editingMessage?: EditingMessageRef | null;
  onCancelEdit?: () => void;
  /** Fires when this client starts/stops sending typing notices (Matrix sync usually omits self). */
  onLocalTypingActive?: (active: boolean) => void;
  /** When set, first text send creates the DM room then delivers the message (no room until send). */
  draftDmPeerUserId?: string | null;
  onDraftDmFirstMessage?: (roomId: string) => void | Promise<void>;
  /** Read-only channel / power levels: disables the composer until allowed. */
  composerPermission?: ComposerPermission;
  /** Local Matrix user id (for optimistic file message rows). */
  selfUserId?: string;
  selfDisplayName?: string | null;
  selfAvatarUrl?: string | null;
  fileSendBridge?: MessageFileSendBridge | null;
}

/** Below `MODAL_LAYER_Z` so emoji/GIF popovers stay under full-screen modals. */
const COMPOSER_POPOVER_Z = MODAL_LAYER_Z - 1000;

export default function MessageInput({
  roomId,
  roomName,
  onMessageSent,
  replyDraft = null,
  onCancelReply,
  editingMessage = null,
  onCancelEdit,
  onLocalTypingActive,
  draftDmPeerUserId = null,
  onDraftDmFirstMessage,
  composerPermission = "allowed",
  selfUserId = "",
  selfDisplayName = null,
  selfAvatarUrl = null,
  fileSendBridge = null,
}: MessageInputProps) {
  const interactionLocked =
    !draftDmPeerUserId &&
    (composerPermission === "loading" || composerPermission === "forbidden");
  const interactionLockedRef = useRef(interactionLocked);
  interactionLockedRef.current = interactionLocked;

  const editingMessageRef = useRef(editingMessage);
  const onCancelEditRef = useRef(onCancelEdit);
  editingMessageRef.current = editingMessage;
  onCancelEditRef.current = onCancelEdit;

  useEffect(() => {
    if (editingMessage) onCancelReply?.();
  }, [editingMessage, onCancelReply]);

  const [plainText, setPlainText] = useState("");
  /** True when the editor contains an embedded image (GIF, pasted image). Plain text alone is tracked in `plainText`. */
  const [hasComposerMedia, setHasComposerMedia] = useState(false);
  const [sending, setSending] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();

  const {
    fileInputRef,
    pendingFile,
    pendingFileRef,
    setPendingFile,
    handleFileSelected,
    clearPendingFile,
  } = useComposerFileUpload({ roomId, interactionLocked, fileSendBridge });

  const { clearTypingTimeout, handleComposerActivity, sendTyping } = useComposerTypingNotice({
    roomId,
    draftDmPeerUserId,
    interactionLocked,
    editing: editingMessage != null,
    composerPermission,
    onLocalTypingActive,
  });

  const {
    formatOpen,
    setFormatOpen,
    activeFormats,
    refreshFormats,
    formatGroups,
  } = useComposerFormatting({ editorRef });

  const emojiOnlyComposer = useMemo(() => isOnlyEmojisAndWhitespace(plainText), [plainText]);

  const composerImgStyle = useMemo(
    () => ({ borderRadius: spacing.unit, maxWidth: "100%" }),
    [spacing.unit],
  );

  const COMPOSER_MAX_AUTO_LINES = 6;
  const composerMaxHeightPx = useMemo(() => {
    const fontSize = emojiOnlyComposer
      ? typography.fontSizeBase * EMOJI_ONLY_DISPLAY_SCALE
      : typography.fontSizeBase;
    const linePx = fontSize * typography.lineHeight;
    const padV = spacing.unit * 3 * 2;
    return Math.ceil(padV + COMPOSER_MAX_AUTO_LINES * linePx);
  }, [emojiOnlyComposer, typography.fontSizeBase, typography.lineHeight, spacing.unit]);

  // ─── Height sync ──────────────────────────────────────────────────────────

  const syncHeight = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    el.style.height = "auto";
    const sh = el.scrollHeight;
    const capped = Math.min(sh, composerMaxHeightPx);
    el.style.height = `${capped}px`;
    el.style.overflowY = sh > composerMaxHeightPx ? "auto" : "hidden";
  }, [composerMaxHeightPx]);

  /** Sync React state and height from the live editor DOM (needed after GIF/image insert when synthetic `input` may not run). */
  const refreshComposerDomState = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const text = getEditorPlainText(el);
    const media = el.querySelector("img") != null;
    setPlainText(text);
    setHasComposerMedia(media);
    syncHeight();
  }, [syncHeight]);

  const {
    pickerOpen,
    setPickerOpen,
    pickerTab,
    setPickerTab,
    popoverPos,
    pickerAnchorRef,
    emojiPickerMountRef,
    giphyApiKey,
    handlePickerToggle,
    handleGifSelect,
  } = useComposerPicker({
    editorRef,
    rootRef,
    interactionLockedRef,
    composerImgStyle,
    refreshComposerDomState,
    syncHeight,
    resolvedColorScheme,
    spacingUnit: spacing.unit,
  });

  const {
    mentionMenuProps,
    getComposerMentionVisibleLabel,
    makeComposerMentionSpan,
    handleComposerInputMentions,
    handleMentionKeyDown,
  } = useComposerMentions({
    roomId,
    selfUserId,
    editorRef,
    palette,
    typography,
    refreshComposerDomState,
  });

  useLayoutEffect(syncHeight, [syncHeight]);

  useEffect(() => {
    document.execCommand("defaultParagraphSeparator", false, "div");
  }, []);

  // ─── Editor input handler ─────────────────────────────────────────────────

  function handleEditorInput() {
    if (interactionLocked) return;
    const el = editorRef.current;
    if (!el) return;
    handleComposerInputMentions();
    const text = getEditorPlainText(el);
    const media = el.querySelector("img") != null;
    setPlainText(text);
    setHasComposerMedia(media);
    syncHeight();

    handleComposerActivity({ text, hasMedia: media });
  }

  const handleEditorPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      if (interactionLocked) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      const text = e.clipboardData.getData("text/plain");
      const el = editorRef.current;
      if (!el) return;
      const trimmed = text.trim();
      if (hrefLooksLikeDirectImageUrl(trimmed)) {
        insertImageAtSelection(el, trimmed, composerImgStyle, () => syncHeight());
      } else {
        insertPlainTextAtSelection(el, text);
      }
      refreshComposerDomState();
    },
    [composerImgStyle, interactionLocked, refreshComposerDomState, syncHeight],
  );

  // ─── Edit message loading ─────────────────────────────────────────────────

  useEffect(() => {
    if (!editingMessage) return;
    const el = editorRef.current;
    if (!el) return;
    fillComposerEditorFromMarkdown(el, editingMessage.body, composerImgStyle, {
      getPillLabel: getComposerMentionVisibleLabel,
      makeSpan: makeComposerMentionSpan,
    });
    const text = getEditorPlainText(el);
    const media = el.querySelector("img") != null;
    setPlainText(text);
    setHasComposerMedia(media);
    syncHeight();
    syncComposerHeightAfterImages(el, syncHeight);
    requestAnimationFrame(() => {
      el.focus();
      const sel = window.getSelection();
      if (sel) {
        sel.selectAllChildren(el);
        sel.collapseToEnd();
      }
    });
  }, [
    editingMessage?.eventId,
    editingMessage?.body,
    composerImgStyle,
    getComposerMentionVisibleLabel,
    makeComposerMentionSpan,
    syncHeight,
  ]);

  // ─── Send / key handling ──────────────────────────────────────────────────

  const { handleSend } = useComposerSubmit({
    roomId,
    interactionLocked,
    sending,
    setSending,
    editorRef,
    pendingFile,
    pendingFileRef,
    setPendingFile,
    fileSendBridge,
    selfUserId,
    selfDisplayName,
    selfAvatarUrl,
    draftDmPeerUserId,
    onDraftDmFirstMessage,
    replyDraft,
    onCancelReply,
    editingMessage,
    onCancelEdit,
    onMessageSent,
    setPlainText,
    setHasComposerMedia,
    setPickerOpen,
    sendTyping,
    clearTypingTimeout,
    refreshFormats,
    syncHeight,
  });

  function handleKeyDown(e: React.KeyboardEvent) {
    if (interactionLocked) return;
    if (handleMentionKeyDown(e)) return;

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }
    if (e.key === "Escape") {
      if (pickerOpen) {
        setPickerOpen(false);
        return;
      }
      if (formatOpen) {
        setFormatOpen(false);
        return;
      }
      if (replyDraft && onCancelReply) {
        e.preventDefault();
        onCancelReply();
        return;
      }
      if (editingMessage && onCancelEdit) {
        e.preventDefault();
        const el = editorRef.current;
        if (el) el.innerHTML = "";
        setPlainText("");
        setHasComposerMedia(false);
        onCancelEdit();
      }
    }
  }

  useEffect(() => {
    if (composerPermission !== "loading") return;
    setPickerOpen(false);
    setFormatOpen(false);
  }, [composerPermission, setPickerOpen, setFormatOpen]);

  useEffect(() => {
    if (draftDmPeerUserId) return;
    if (composerPermission !== "forbidden") return;

    setPickerOpen(false);
    setFormatOpen(false);
    clearPendingFile();

    const el = editorRef.current;
    if (el) {
      el.innerHTML = "";
      setPlainText("");
      setHasComposerMedia(false);
    }
    syncHeight();
    if (editingMessageRef.current && onCancelEditRef.current) {
      onCancelEditRef.current();
    }
  }, [composerPermission, draftDmPeerUserId, setPickerOpen, setFormatOpen, clearPendingFile, syncHeight]);

  // ─── Layout constants ─────────────────────────────────────────────────────

  const formatBtnGap = spacing.unit * 0.75;
  const groupGap = spacing.unit * 1.5;
  const inputToolIconSize = 20;
  const inputToolBtnSize = inputToolIconSize + spacing.unit * 3;
  const inputToolBtnRadius = Math.max(3, spacing.unit * 0.55);
  const hoverToolBtn = (e: React.MouseEvent<HTMLButtonElement>, active: boolean, enter: boolean) => {
    if (active) return;
    e.currentTarget.style.backgroundColor = enter ? palette.bgHover : "transparent";
    e.currentTarget.style.color = enter ? palette.textPrimary : palette.textSecondary;
  };
  const canSend =
    !interactionLocked &&
    (plainText.trim().length > 0 || hasComposerMedia || !!pendingFile) &&
    !sending &&
    pendingFile?.phase !== "error";

  const defaultPlaceholder = editingMessage ? "Edit message" : `Message #${roomName}`;
  const placeholderText = interactionLocked
    ? composerPermission === "loading"
      ? "Loading…"
      : "You don't have permission to send messages in this channel."
    : defaultPlaceholder;

  // ─── Render ───────────────────────────────────────────────────────────────

  const composerOuterBorder = paletteComposerOuterBorderStyle(palette);

  return (
    <>
      <style>{`
        [data-pax-composer] strong, [data-pax-composer] b { font-weight: bold; }
        [data-pax-composer] em, [data-pax-composer] i { font-style: italic; }
        [data-pax-composer] del, [data-pax-composer] s, [data-pax-composer] strike { text-decoration: line-through; }
        [data-pax-composer] code:not(pre code) {
          background: ${palette.bgHover};
          padding: 0.1em 0.35em;
          border-radius: 3px;
          font-family: 'Consolas', 'Courier New', monospace;
          font-size: 0.9em;
        }
        [data-pax-composer] pre {
          background: ${palette.bgHover};
          padding: ${spacing.unit * 2}px;
          border-radius: ${spacing.unit}px;
          font-family: 'Consolas', 'Courier New', monospace;
          font-size: 0.9em;
          white-space: pre-wrap;
          margin: ${spacing.unit}px 0;
        }
        [data-pax-composer] a {
          color: #5b9bd5;
          text-decoration: underline;
        }
        [data-pax-composer] blockquote {
          border-left: 3px solid ${palette.border};
          padding-left: ${spacing.unit * 2}px;
          margin: ${spacing.unit}px 0;
          color: ${palette.textSecondary};
        }
        [data-pax-composer] h1 { font-size: 1.4em; font-weight: bold; margin: 0; }
        [data-pax-composer] h2 { font-size: 1.2em; font-weight: bold; margin: 0; }
        [data-pax-composer] hr { border: none; border-top: 1px solid ${palette.border}; margin: ${spacing.unit}px 0; }
        [data-pax-composer] ul, [data-pax-composer] ol { margin: 0; padding-left: ${spacing.unit * 5}px; }
        /* Single block wrapper (incl. empty div+br); UA margin can inflate scrollHeight and show a bogus scrollbar. */
        [data-pax-composer] > div:only-child { margin: 0; }
        [data-pax-composer-root] button:disabled { cursor: default !important; }
        [data-pax-composer-root] [data-pax-composer][contenteditable="false"] { cursor: default !important; }
        [data-pax-composer] span[data-pax-mention-user-id]:hover {
          background-color: ${palette.accent}38 !important;
        }
      `}</style>

      <div
        ref={rootRef}
        data-pax-composer-root
        style={{ padding: `0 ${spacing.unit * 3}px ${spacing.unit * 3}px`, position: "relative" }}
      >

      <MentionAutocompleteMenu
        {...mentionMenuProps}
        palette={palette}
        typography={typography}
        spacing={spacing}
        resolvedColorScheme={resolvedColorScheme}
        zIndex={COMPOSER_POPOVER_Z}
      />

      <div
        style={{
          backgroundColor: palette.bgActive,
          borderRadius: spacing.unit * 1.5,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          ...(composerOuterBorder ? { border: composerOuterBorder } : {}),
        }}
      >
        <ComposerContextBar
          replyDraft={replyDraft}
          showReply={!!replyDraft && !!onCancelReply && !editingMessage}
          pendingFile={pendingFile}
          palette={palette}
          typography={typography}
          spacing={spacing}
          onCancelReply={onCancelReply}
          onClearPendingFile={clearPendingFile}
        />
        <ComposerInputRow
          fileInputRef={fileInputRef}
          editorRef={editorRef}
          pickerAnchorRef={pickerAnchorRef}
          pendingFile={pendingFile}
          draftDmPeerUserId={draftDmPeerUserId}
          interactionLocked={interactionLocked}
          plainText={plainText}
          hasComposerMedia={hasComposerMedia}
          emojiOnlyComposer={emojiOnlyComposer}
          placeholderText={placeholderText}
          composerMaxHeightPx={composerMaxHeightPx}
          pickerOpen={pickerOpen}
          formatOpen={formatOpen}
          canSend={canSend}
          editingMessage={editingMessage}
          palette={palette}
          typography={typography}
          spacing={spacing}
          inputToolBtnSize={inputToolBtnSize}
          inputToolBtnRadius={inputToolBtnRadius}
          inputToolIconSize={inputToolIconSize}
          onFileSelected={handleFileSelected}
          onEditorInput={handleEditorInput}
          onEditorKeyDown={handleKeyDown}
          onEditorPaste={handleEditorPaste}
          onPickerToggle={handlePickerToggle}
          onFormatToggle={() => setFormatOpen((open) => !open)}
          onSend={() => void handleSend()}
          onHoverToolButton={hoverToolBtn}
        />

        <ComposerFormattingToolbar
          formatOpen={formatOpen}
          formatGroups={formatGroups}
          activeFormats={activeFormats}
          palette={palette}
          spacing={spacing}
          formatBtnGap={formatBtnGap}
          groupGap={groupGap}
          inputToolBtnSize={inputToolBtnSize}
          inputToolBtnRadius={inputToolBtnRadius}
          inputToolIconSize={inputToolIconSize}
        />
      </div>
    </div>
      <ComposerMediaPickerPopover
        open={pickerOpen}
        popoverPos={popoverPos}
        pickerTab={pickerTab}
        emojiPickerMountRef={emojiPickerMountRef}
        giphyApiKey={giphyApiKey}
        palette={palette}
        typography={typography}
        spacing={spacing}
        resolvedColorScheme={resolvedColorScheme}
        zIndex={COMPOSER_POPOVER_Z}
        onPickerTabChange={setPickerTab}
        onGifSelect={handleGifSelect}
      />
    </>
  );
}
