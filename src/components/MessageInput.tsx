import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  Fragment,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  Type,
  Bold,
  Italic,
  Strikethrough,
  Code,
  Braces,
  Link,
  List,
  ListOrdered,
  TextQuote,
  Heading1,
  Heading2,
  Minus,
  Send,
  Smile,
  Clapperboard,
} from "lucide-react";
import GifPicker, { Theme as GifPickerTheme } from "react-gif-picker";
import { Picker } from "emoji-mart";
import data from "@emoji-mart/data";
import { useTheme } from "../theme/ThemeContext";
import { EMOJI_ONLY_DISPLAY_SCALE, isOnlyEmojisAndWhitespace } from "../utils/emojifyTwemoji";
import { hrefLooksLikeDirectImageUrl } from "../utils/directImageUrl";
import {
  serializeComposerEditor,
  fillComposerEditorFromMarkdown,
  getEditorPlainText,
  insertPlainTextAtSelection,
  insertImageAtSelection,
  getActiveFormats,
  toggleInlineCode,
  toggleCodeBlock,
  toggleLink,
} from "../utils/composerEditorDom";

export interface EditingMessageRef {
  eventId: string;
  body: string;
}

interface MessageInputProps {
  roomId: string;
  roomName: string;
  onMessageSent: () => void;
  editingMessage?: EditingMessageRef | null;
  onCancelEdit?: () => void;
}

const COMPOSER_POPOVER_Z = 12_000;

function fixedPopoverStyle(bottom: number, right: number): CSSProperties {
  return {
    position: "fixed",
    bottom,
    right,
    zIndex: COMPOSER_POPOVER_Z,
  };
}

export default function MessageInput({
  roomId,
  roomName,
  onMessageSent,
  editingMessage = null,
  onCancelEdit,
}: MessageInputProps) {
  const [plainText, setPlainText] = useState("");
  const [sending, setSending] = useState(false);
  const [openPopover, setOpenPopover] = useState<"format" | "emoji" | "gif" | null>(null);
  const [activeFormats, setActiveFormats] = useState<Set<string>>(new Set());
  const editorRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const emojiAnchorRef = useRef<HTMLButtonElement>(null);
  const gifAnchorRef = useRef<HTMLButtonElement>(null);
  const emojiPickerMountRef = useRef<HTMLDivElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ bottom: number; right: number } | null>(null);
  const insertEmojiFromPickerRef = useRef<(native: string) => void>(() => {});
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping = useRef(false);
  const { palette, typography, spacing, name: themeName } = useTheme();
  const tenorApiKey = import.meta.env.VITE_TENOR_API_KEY ?? "";

  const emojiOnlyComposer = useMemo(() => isOnlyEmojisAndWhitespace(plainText), [plainText]);

  const composerImgStyle = useMemo(
    () => ({ borderRadius: spacing.unit, maxWidth: "100%" }),
    [spacing.unit],
  );

  const COMPOSER_MAX_AUTO_LINES = 3;
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
    el.style.height = `${Math.min(el.scrollHeight, composerMaxHeightPx)}px`;
  }, [composerMaxHeightPx]);

  // Sync height on mount and when max changes (emoji-only toggle).
  useLayoutEffect(syncHeight, [syncHeight]);

  // Set default paragraph separator so Enter produces <div> consistently.
  useEffect(() => {
    document.execCommand("defaultParagraphSeparator", false, "div");
  }, []);

  // ─── Typing indicator ─────────────────────────────────────────────────────

  const sendTyping = useCallback(
    (typing: boolean) => {
      if (typing === isTyping.current) return;
      isTyping.current = typing;
      invoke("send_typing_notice", { roomId, typing }).catch(() => {});
    },
    [roomId],
  );

  useEffect(() => {
    return () => {
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      if (isTyping.current) {
        invoke("send_typing_notice", { roomId, typing: false }).catch(() => {});
        isTyping.current = false;
      }
    };
  }, [roomId]);

  // ─── Editor input handler (uncontrolled – DOM is source of truth) ─────────

  function handleEditorInput() {
    const el = editorRef.current;
    if (!el) return;
    const text = getEditorPlainText(el);
    setPlainText(text);
    syncHeight();

    if (editingMessage) return;
    if (text.trim().length > 0) {
      sendTyping(true);
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      typingTimeout.current = setTimeout(() => sendTyping(false), 3000);
    } else {
      sendTyping(false);
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
    }
  }

  // ─── Active format tracking ───────────────────────────────────────────────

  useEffect(() => {
    const update = () => {
      const el = editorRef.current;
      if (!el) return;
      setActiveFormats(getActiveFormats(el));
    };
    document.addEventListener("selectionchange", update);
    // Also refresh on keyup to catch Ctrl+B / Ctrl+I / Ctrl+S browser hotkeys
    // which toggle formatting via execCommand but don't fire selectionchange.
    const el = editorRef.current;
    el?.addEventListener("keyup", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      el?.removeEventListener("keyup", update);
    };
  }, []);

  // ─── Popover positioning (emoji + GIF only; format toolbar is inline) ─────

  useLayoutEffect(() => {
    const margin = spacing.unit * 2;
    const anchorFor = (p: typeof openPopover) => {
      if (p === "emoji") return emojiAnchorRef.current;
      if (p === "gif") return gifAnchorRef.current;
      return null;
    };
    const update = () => {
      const anchor = anchorFor(openPopover);
      if (!openPopover || !anchor) { setPopoverPos(null); return; }
      const r = anchor.getBoundingClientRect();
      setPopoverPos({
        bottom: window.innerHeight - r.top + margin,
        right: window.innerWidth - r.right,
      });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [openPopover, spacing.unit]);

  // Close popovers on outside click / Escape.
  useEffect(() => {
    if (!openPopover) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest("[data-pax-composer-popover]")) return;
      const root = rootRef.current;
      if (root && e.composedPath().includes(root)) return;
      setOpenPopover(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenPopover(null);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openPopover]);

  // ─── Emoji picker mount ───────────────────────────────────────────────────

  insertEmojiFromPickerRef.current = (native: string) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    document.execCommand("insertText", false, native);
    setOpenPopover(null);
  };

  useLayoutEffect(() => {
    if (openPopover !== "emoji") return;
    const mount = emojiPickerMountRef.current;
    if (!mount) return;
    mount.innerHTML = "";
    const theme = themeName === "light" ? "light" : "dark";
    new Picker({
      parent: mount,
      data,
      theme,
      set: "native",
      maxFrequentRows: 4,
      skinTonePosition: "search",
      previewPosition: "bottom",
      searchPosition: "sticky",
      onEmojiSelect: (emoji: { native: string }) => {
        insertEmojiFromPickerRef.current(emoji.native);
      },
    });
    return () => {
      mount.innerHTML = "";
    };
  }, [openPopover, popoverPos, themeName]);

  // ─── Edit message loading ─────────────────────────────────────────────────

  useEffect(() => {
    if (!editingMessage) return;
    const el = editorRef.current;
    if (!el) return;
    fillComposerEditorFromMarkdown(el, editingMessage.body, composerImgStyle);
    setPlainText(getEditorPlainText(el));
    syncHeight();
    requestAnimationFrame(() => {
      el.focus();
      const sel = window.getSelection();
      if (sel) {
        sel.selectAllChildren(el);
        sel.collapseToEnd();
      }
    });
  }, [editingMessage?.eventId]);

  // ─── Format actions ───────────────────────────────────────────────────────

  const refreshFormats = useCallback(() => {
    const el = editorRef.current;
    if (el) setActiveFormats(getActiveFormats(el));
  }, []);

  const execFormat = useCallback((cmd: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd);
    refreshFormats();
  }, [refreshFormats]);

  const toggleFormatBlock = useCallback((tag: string, key: string) => {
    editorRef.current?.focus();
    document.execCommand("formatBlock", false, activeFormats.has(key) ? "div" : tag);
    refreshFormats();
  }, [activeFormats, refreshFormats]);

  type FormatItem = { icon: typeof Bold; label: string; run: () => void; formatKey?: string };

  const formatGroups: FormatItem[][] = [
    [
      { icon: Bold, label: "Bold", formatKey: "bold", run: () => execFormat("bold") },
      { icon: Italic, label: "Italic", formatKey: "italic", run: () => execFormat("italic") },
      { icon: Strikethrough, label: "Strikethrough", formatKey: "strikethrough", run: () => execFormat("strikeThrough") },
    ],
    [
      { icon: Code, label: "Inline code", formatKey: "code", run: () => { editorRef.current?.focus(); toggleInlineCode(editorRef.current!); refreshFormats(); } },
      { icon: Braces, label: "Code block", formatKey: "codeblock", run: () => { editorRef.current?.focus(); toggleCodeBlock(editorRef.current!); refreshFormats(); } },
    ],
    [{ icon: Link, label: "Link", formatKey: "link", run: () => { editorRef.current?.focus(); toggleLink(editorRef.current!); refreshFormats(); } }],
    [
      { icon: List, label: "Bullet list", formatKey: "ul", run: () => execFormat("insertUnorderedList") },
      { icon: ListOrdered, label: "Numbered list", formatKey: "ol", run: () => execFormat("insertOrderedList") },
      { icon: TextQuote, label: "Quote", formatKey: "quote", run: () => toggleFormatBlock("blockquote", "quote") },
    ],
    [
      { icon: Heading1, label: "Heading 1", formatKey: "h1", run: () => toggleFormatBlock("h1", "h1") },
      { icon: Heading2, label: "Heading 2", formatKey: "h2", run: () => toggleFormatBlock("h2", "h2") },
    ],
    [{ icon: Minus, label: "Horizontal rule", run: () => execFormat("insertHorizontalRule") }],
  ];

  // ─── Send / key handling ──────────────────────────────────────────────────

  async function handleSend() {
    const el = editorRef.current;
    if (!el) return;
    const markdown = serializeComposerEditor(el);
    const trimmed = markdown.trim();
    if (!trimmed || sending) return;

    // Close emoji/gif but keep format toolbar open across sends.
    setOpenPopover((o) => (o === "format" ? o : null));
    sendTyping(false);
    if (typingTimeout.current) clearTimeout(typingTimeout.current);

    setSending(true);
    try {
      if (editingMessage) {
        await invoke("edit_message", {
          roomId,
          eventId: editingMessage.eventId,
          body: trimmed,
        });
        onCancelEdit?.();
      } else {
        await invoke("send_message", { roomId, body: trimmed });
      }
      // Snapshot which inline formats were active so we can restore them.
      const prevFormats = getActiveFormats(el);
      el.innerHTML = "";
      setPlainText("");
      onMessageSent();
      el.focus();
      // Re-apply inline formats: insert a zero-width space first so execCommand
      // can wrap it in <b>/<i>/<s> elements, giving the cursor a styled home.
      if (prevFormats.has("bold") || prevFormats.has("italic") || prevFormats.has("strikethrough")) {
        document.execCommand("insertText", false, "\u200b");
        // Select the ZWS so the format commands wrap it.
        const sel = window.getSelection();
        if (sel) { sel.selectAllChildren(el); }
        for (const fmt of prevFormats) {
          if (fmt === "bold") document.execCommand("bold");
          else if (fmt === "italic") document.execCommand("italic");
          else if (fmt === "strikethrough") document.execCommand("strikeThrough");
        }
        // Collapse to end so typing appends inside the wrappers.
        if (sel) { sel.collapseToEnd(); }
      }
      refreshFormats();
    } catch (e) {
      console.error(editingMessage ? "Failed to edit:" : "Failed to send:", e);
    }
    setSending(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }
    if (e.key === "Escape") {
      if (openPopover) {
        setOpenPopover(null);
        return;
      }
      if (editingMessage && onCancelEdit) {
        e.preventDefault();
        const el = editorRef.current;
        if (el) el.innerHTML = "";
        setPlainText("");
        onCancelEdit();
      }
    }
  }

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
  const canSend = plainText.trim().length > 0 && !sending;

  // ─── Portals ──────────────────────────────────────────────────────────────

  const emojiPickerPortal =
    openPopover === "emoji" &&
    popoverPos &&
    createPortal(
      <div
        data-pax-composer-popover
        style={{
          ...fixedPopoverStyle(popoverPos.bottom, popoverPos.right),
          borderRadius: spacing.unit * 2,
          overflow: "hidden",
          border: `1px solid ${palette.border}`,
          boxShadow:
            themeName === "light"
              ? `0 8px 28px rgba(0,0,0,0.12), 0 0 0 1px ${palette.border} inset`
              : `0 12px 44px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06) inset`,
        }}
      >
        <div ref={emojiPickerMountRef} />
      </div>,
      document.body,
    );

  const gifPickerPortal =
    openPopover === "gif" &&
    popoverPos &&
    createPortal(
      <div
        data-pax-composer-popover
        style={{
          ...fixedPopoverStyle(popoverPos.bottom, popoverPos.right),
          borderRadius: spacing.unit * 2,
          overflow: "hidden",
          border: `1px solid ${palette.border}`,
          boxShadow:
            themeName === "light"
              ? `0 8px 28px rgba(0,0,0,0.12), 0 0 0 1px ${palette.border} inset`
              : `0 12px 44px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06) inset`,
          backgroundColor: palette.bgTertiary,
        }}
      >
        {tenorApiKey ? (
          <GifPicker
            tenorApiKey={tenorApiKey}
            clientKey="pax"
            theme={themeName === "light" ? GifPickerTheme.LIGHT : GifPickerTheme.DARK}
            width={320}
            height={380}
            onGifClick={(gif) => {
              const el = editorRef.current;
              if (!el) return;
              el.focus();
              if (hrefLooksLikeDirectImageUrl(gif.url)) {
                insertImageAtSelection(el, gif.url, composerImgStyle);
              } else {
                document.execCommand("insertText", false, gif.url);
              }
              setOpenPopover(null);
              requestAnimationFrame(() => el.focus());
            }}
          />
        ) : (
          <div
            style={{
              width: 280,
              padding: spacing.unit * 3,
              color: palette.textSecondary,
              fontSize: typography.fontSizeBase * 0.9,
              lineHeight: typography.lineHeight,
            }}
          >
            Add{" "}
            <code style={{ color: palette.textPrimary }}>VITE_TENOR_API_KEY</code> to your env to search Tenor GIFs (free key
            from Google Cloud → Tenor API).
          </div>
        )}
      </div>,
      document.body,
    );

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* Scoped rich-text styles for the composer editor */}
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
      `}</style>

      <div
        ref={rootRef}
        style={{ padding: `0 ${spacing.unit * 3}px ${spacing.unit * 3}px`, position: "relative" }}
      >
      <div
        style={{
          backgroundColor: palette.bgActive,
          borderRadius: spacing.unit * 1.5,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        {/* Top row: editor + toolbar buttons */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            minHeight: spacing.unit * 11,
            minWidth: 0,
            flexWrap: "nowrap",
            overflowX: "auto",
          }}
        >
        <div
          style={{
            position: "relative",
            flex: 1,
            minWidth: 0,
            alignSelf: "stretch",
          }}
        >
          {!plainText.trim() && (
            <div
              aria-hidden
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                right: 0,
                padding: `${spacing.unit * 3}px ${spacing.unit * 2}px ${spacing.unit * 3}px ${spacing.unit * 4}px`,
                pointerEvents: "none",
                color: palette.textSecondary,
                fontSize: emojiOnlyComposer
                  ? typography.fontSizeBase * EMOJI_ONLY_DISPLAY_SCALE
                  : typography.fontSizeBase,
                fontFamily: `${typography.fontFamily}, var(--pax-twemoji-font-stack)`,
                lineHeight: typography.lineHeight,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {editingMessage ? "Edit message" : `Message #${roomName}`}
            </div>
          )}
          <div
            ref={editorRef}
            data-pax-composer
            contentEditable
            role="textbox"
            aria-multiline="true"
            aria-label={editingMessage ? "Edit message" : `Message ${roomName}`}
            suppressContentEditableWarning
            onInput={handleEditorInput}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              e.preventDefault();
              const text = e.clipboardData.getData("text/plain");
              const el = editorRef.current;
              if (!el) return;
              const trimmed = text.trim();
              if (hrefLooksLikeDirectImageUrl(trimmed)) {
                insertImageAtSelection(el, trimmed, composerImgStyle);
              } else {
                insertPlainTextAtSelection(el, text);
              }
            }}
            style={{
              minWidth: 0,
              width: "100%",
              background: "none",
              border: "none",
              outline: "none",
              color: palette.textPrimary,
              fontSize: emojiOnlyComposer
                ? typography.fontSizeBase * EMOJI_ONLY_DISPLAY_SCALE
                : typography.fontSizeBase,
              fontFamily: `${typography.fontFamily}, var(--pax-twemoji-font-stack)`,
              lineHeight: typography.lineHeight,
              padding: `${spacing.unit * 3}px ${spacing.unit * 2}px ${spacing.unit * 3}px ${spacing.unit * 4}px`,
              maxHeight: composerMaxHeightPx,
              overflowY: "auto",
              boxSizing: "border-box",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
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
              ref={gifAnchorRef}
              type="button"
              title={tenorApiKey ? "GIF" : "GIF (configure Tenor API key)"}
              aria-label="Insert GIF"
              aria-expanded={openPopover === "gif"}
              aria-haspopup="dialog"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setOpenPopover((o) => (o === "gif" ? null : "gif"))}
              style={{
                flexShrink: 0,
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: spacing.unit * 0.35,
                width: "auto",
                minWidth: inputToolBtnSize,
                height: inputToolBtnSize,
                paddingLeft: spacing.unit * 1.25,
                paddingRight: spacing.unit * 1.25,
                margin: spacing.unit,
                marginRight: spacing.unit * 0.5,
                border: "none",
                borderRadius: inputToolBtnRadius,
                backgroundColor: openPopover === "gif" ? palette.bgHover : "transparent",
                color: openPopover === "gif" ? palette.textPrimary : palette.textSecondary,
                cursor: "pointer",
                fontFamily: typography.fontFamily,
              }}
              onMouseEnter={(e) => hoverToolBtn(e, openPopover === "gif", true)}
              onMouseLeave={(e) => hoverToolBtn(e, openPopover === "gif", false)}
            >
              <Clapperboard size={inputToolIconSize - 2} strokeWidth={2} aria-hidden />
              <span
                style={{
                  fontSize: typography.fontSizeSmall - 1,
                  fontWeight: typography.fontWeightBold,
                  letterSpacing: "0.04em",
                  lineHeight: 1,
                }}
              >
                GIF
              </span>
            </button>
          </div>
          <div style={{ position: "relative", flexShrink: 0 }}>
            <button
              ref={emojiAnchorRef}
              type="button"
              title="Emoji"
              aria-label="Insert emoji"
              aria-expanded={openPopover === "emoji"}
              aria-haspopup="dialog"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setOpenPopover((o) => (o === "emoji" ? null : "emoji"))}
              style={{
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: inputToolBtnSize,
                height: inputToolBtnSize,
                padding: 0,
                margin: spacing.unit,
                marginLeft: 0,
                marginRight: spacing.unit * 0.75,
                border: "none",
                borderRadius: inputToolBtnRadius,
                backgroundColor: openPopover === "emoji" ? palette.bgHover : "transparent",
                color: openPopover === "emoji" ? palette.textPrimary : palette.textSecondary,
                cursor: "pointer",
              }}
              onMouseEnter={(e) => hoverToolBtn(e, openPopover === "emoji", true)}
              onMouseLeave={(e) => hoverToolBtn(e, openPopover === "emoji", false)}
            >
              <Smile size={inputToolIconSize} strokeWidth={2} />
            </button>
          </div>
        </div>
        <button
          type="button"
          title="Text formatting"
          aria-expanded={openPopover === "format"}
          aria-haspopup="menu"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpenPopover((o) => (o === "format" ? null : "format"))}
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: inputToolBtnSize,
            height: inputToolBtnSize,
            padding: 0,
            margin: spacing.unit,
            marginLeft: 0,
            border: "none",
            borderRadius: inputToolBtnRadius,
            backgroundColor: openPopover === "format" ? palette.bgHover : "transparent",
            color: openPopover === "format" ? palette.textPrimary : palette.textSecondary,
            cursor: "pointer",
          }}
          onMouseEnter={(e) => hoverToolBtn(e, openPopover === "format", true)}
          onMouseLeave={(e) => hoverToolBtn(e, openPopover === "format", false)}
        >
          <Type size={inputToolIconSize} strokeWidth={2} />
        </button>
        <button
          type="button"
          title={editingMessage ? "Save edit" : "Send message"}
          aria-label={editingMessage ? "Save edit" : "Send message"}
          disabled={!canSend}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void handleSend()}
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
            cursor: canSend ? "pointer" : "not-allowed",
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

        {/* Inline format toolbar */}
        {openPopover === "format" && (
          <>
            <div
              aria-hidden
              style={{
                height: 1,
                marginLeft: spacing.unit * 2,
                marginRight: spacing.unit * 2,
                backgroundColor: palette.border,
                opacity: 0.25,
              }}
            />
            <div
              role="toolbar"
              aria-label="Markdown formatting"
              style={{
                padding: `${spacing.unit * 1.5}px ${spacing.unit * 2}px`,
                display: "flex",
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: formatBtnGap,
                columnGap: groupGap,
              }}
            >
              {formatGroups.map((group, groupIndex) => (
                <Fragment key={groupIndex}>
                  {groupIndex > 0 && (
                    <div
                      aria-hidden
                      role="separator"
                      style={{
                        width: 1,
                        height: inputToolBtnSize - spacing.unit * 0.75,
                        flexShrink: 0,
                        alignSelf: "center",
                        borderRadius: 1,
                        backgroundColor: palette.border,
                        opacity: 0.3,
                      }}
                    />
                  )}
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "row",
                      flexWrap: "nowrap",
                      alignItems: "center",
                      gap: formatBtnGap,
                    }}
                  >
                    {group.map(({ icon: Icon, label, run, formatKey }) => {
                      const isActive = formatKey ? activeFormats.has(formatKey) : false;
                      return (
                        <button
                          key={label}
                          type="button"
                          role="menuitem"
                          title={label}
                          aria-label={label}
                          aria-pressed={isActive}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={run}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: inputToolBtnSize,
                            height: inputToolBtnSize,
                            padding: 0,
                            border: "none",
                            borderRadius: inputToolBtnRadius,
                            backgroundColor: isActive ? palette.bgHover : "transparent",
                            color: isActive ? palette.textHeading : palette.textSecondary,
                            cursor: "pointer",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = palette.bgHover;
                            e.currentTarget.style.color = palette.textHeading;
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = isActive ? palette.bgHover : "transparent";
                            e.currentTarget.style.color = isActive ? palette.textHeading : palette.textSecondary;
                          }}
                        >
                          <Icon size={inputToolIconSize} strokeWidth={2} />
                        </button>
                      );
                    })}
                  </div>
                </Fragment>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
      {emojiPickerPortal}
      {gifPickerPortal}
    </>
  );
}