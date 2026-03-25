import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useContext,
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
} from "lucide-react";
import {
  Grid as GiphyGrid,
  SearchBar as GiphySearchBar,
  SearchContext,
  SearchContextManager,
} from "@giphy/react-components";
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
  const [formatOpen, setFormatOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<"emoji" | "gif">("emoji");
  const [activeFormats, setActiveFormats] = useState<Set<string>>(new Set());
  const editorRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pickerAnchorRef = useRef<HTMLButtonElement>(null);
  const emojiPickerMountRef = useRef<HTMLDivElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ bottom: number; right: number } | null>(null);
  const insertEmojiFromPickerRef = useRef<(native: string) => void>(() => {});
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping = useRef(false);
  const { palette, typography, spacing, name: themeName } = useTheme();
  const [giphyApiKey, setGiphyApiKey] = useState("");

  useEffect(() => {
    invoke<string>("get_giphy_api_key").then(setGiphyApiKey).catch(() => {});
  }, []);

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

  useLayoutEffect(syncHeight, [syncHeight]);

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

  // ─── Editor input handler ─────────────────────────────────────────────────

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
    const el = editorRef.current;
    el?.addEventListener("keyup", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      el?.removeEventListener("keyup", update);
    };
  }, []);

  // ─── Picker positioning ───────────────────────────────────────────────────

  useLayoutEffect(() => {
    const margin = spacing.unit * 2;
    const update = () => {
      const anchor = pickerAnchorRef.current;
      if (!pickerOpen || !anchor) { setPopoverPos(null); return; }
      const r = anchor.getBoundingClientRect();
      setPopoverPos({
        bottom: window.innerHeight - r.top + margin,
        right: window.innerWidth - r.right,
      });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [pickerOpen, spacing.unit]);

  // Close picker on outside click / Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest("[data-pax-composer-popover]")) return;
      const root = rootRef.current;
      if (root && e.composedPath().includes(root)) return;
      setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  // ─── Emoji picker mount ───────────────────────────────────────────────────

  insertEmojiFromPickerRef.current = (native: string) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    document.execCommand("insertText", false, native);
    setPickerOpen(false);
  };

  useLayoutEffect(() => {
    if (!pickerOpen || pickerTab !== "emoji") return;
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
  }, [pickerOpen, pickerTab, popoverPos, themeName]);

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

    // Close picker but keep format toolbar open across sends.
    setPickerOpen(false);
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
      const prevFormats = getActiveFormats(el);
      el.innerHTML = "";
      setPlainText("");
      onMessageSent();
      el.focus();
      if (prevFormats.has("bold") || prevFormats.has("italic") || prevFormats.has("strikethrough")) {
        document.execCommand("insertText", false, "\u200b");
        const sel = window.getSelection();
        if (sel) { sel.selectAllChildren(el); }
        for (const fmt of prevFormats) {
          if (fmt === "bold") document.execCommand("bold");
          else if (fmt === "italic") document.execCommand("italic");
          else if (fmt === "strikethrough") document.execCommand("strikeThrough");
        }
        if (sel) { sel.collapseToEnd(); }
      }
      refreshFormats();
      syncHeight();
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
      if (pickerOpen) {
        setPickerOpen(false);
        return;
      }
      if (formatOpen) {
        setFormatOpen(false);
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

  // ─── Picker portal (emoji + GIF tabs) ─────────────────────────────────────

  const pickerPortal =
    pickerOpen &&
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
          display: "flex",
          flexDirection: "column",
          width: 352,
        }}
      >
        {/* Tab bar */}
        <div
          style={{
            display: "flex",
            borderBottom: `1px solid ${palette.border}`,
            flexShrink: 0,
          }}
        >
          {(["emoji", "gif"] as const).map((tab) => {
            const active = pickerTab === tab;
            return (
              <button
                key={tab}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setPickerTab(tab)}
                style={{
                  flex: 1,
                  padding: `${spacing.unit * 2}px 0`,
                  border: "none",
                  borderBottom: `2px solid ${active ? palette.textPrimary : "transparent"}`,
                  backgroundColor: "transparent",
                  color: active ? palette.textPrimary : palette.textSecondary,
                  fontSize: typography.fontSizeSmall,
                  fontWeight: active ? typography.fontWeightBold : typography.fontWeightNormal,
                  fontFamily: typography.fontFamily,
                  cursor: "pointer",
                  letterSpacing: "0.03em",
                  transition: "color 0.1s, border-color 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.color = palette.textPrimary;
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.color = palette.textSecondary;
                }}
              >
                {tab === "emoji" ? "Emoji" : "GIF"}
              </button>
            );
          })}
        </div>

        {/* Tab content — both always mounted to avoid React vs imperative DOM conflicts */}
        <div ref={emojiPickerMountRef} style={{ display: pickerTab === "emoji" ? "block" : "none" }} />
        <div style={{ display: pickerTab === "gif" ? "block" : "none" }}>
          {giphyApiKey ? (
            <SearchContextManager apiKey={giphyApiKey}>
              <GiphyPickerInner
                palette={palette}
                typography={typography}
                spacing={spacing}
                themeName={themeName}
                onGifSelect={(gifUrl) => {
                  const el = editorRef.current;
                  if (!el) return;
                  el.focus();
                  if (hrefLooksLikeDirectImageUrl(gifUrl)) {
                    insertImageAtSelection(el, gifUrl, composerImgStyle);
                  } else {
                    document.execCommand("insertText", false, gifUrl);
                  }
                  setPickerOpen(false);
                  requestAnimationFrame(() => el.focus());
                }}
              />
            </SearchContextManager>
          ) : (
            <div
              style={{
                padding: spacing.unit * 3,
                color: palette.textSecondary,
                fontSize: typography.fontSizeBase * 0.9,
                lineHeight: typography.lineHeight,
              }}
            >
              Add{" "}
              <code style={{ color: palette.textPrimary }}>GIPHY_API_KEY</code> to your .env to
              search GIPHY GIFs (free key from developers.giphy.com).
            </div>
          )}
        </div>
      </div>,
      document.body,
    );

  // ─── Render ───────────────────────────────────────────────────────────────

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
              ref={pickerAnchorRef}
              type="button"
              title="Emoji & GIF"
              aria-label="Emoji & GIF"
              aria-expanded={pickerOpen}
              aria-haspopup="dialog"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setPickerOpen((o) => !o)}
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
                cursor: "pointer",
              }}
              onMouseEnter={(e) => hoverToolBtn(e, pickerOpen, true)}
              onMouseLeave={(e) => hoverToolBtn(e, pickerOpen, false)}
            >
              <Smile size={inputToolIconSize} strokeWidth={2} />
            </button>
          </div>
        </div>
        <button
          type="button"
          title="Text formatting"
          aria-expanded={formatOpen}
          aria-haspopup="menu"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setFormatOpen((o) => !o)}
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
            backgroundColor: formatOpen ? palette.bgHover : "transparent",
            color: formatOpen ? palette.textPrimary : palette.textSecondary,
            cursor: "pointer",
          }}
          onMouseEnter={(e) => hoverToolBtn(e, formatOpen, true)}
          onMouseLeave={(e) => hoverToolBtn(e, formatOpen, false)}
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
        {formatOpen && (
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
      {pickerPortal}
    </>
  );
}

/* ─── GIPHY sub-component (must be a child of SearchContextManager) ──────── */

interface GiphyPickerInnerProps {
  palette: any;
  typography: any;
  spacing: any;
  themeName: string;
  onGifSelect: (gifUrl: string) => void;
}

function GiphyPickerInner({ palette, typography, spacing, onGifSelect }: GiphyPickerInnerProps) {
  const { fetchGifs, searchKey } = useContext(SearchContext);

  return (
    <div
      style={{
        width: 350,
        height: 380,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: palette.backgroundPrimary,
      }}
    >
      <div style={{ padding: `${spacing.unit}px ${spacing.unit * 1.5}px` }}>
        <GiphySearchBar
          placeholder="Search GIPHY"
          autoFocus
        />
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        <GiphyGrid
          key={searchKey}
          columns={3}
          width={350}
          gutter={6}
          fetchGifs={fetchGifs}
          hideAttribution
          noLink
          onGifClick={(gif, e) => {
            e.preventDefault();
            const url = gif.images?.original?.url ?? gif.images?.fixed_height?.url;
            if (url) onGifSelect(url);
          }}
        />
      </div>
      <div
        style={{
          padding: `${spacing.unit * 0.5}px ${spacing.unit}px`,
          textAlign: "right",
          fontSize: typography.fontSizeSmall * 0.85,
          color: palette.textSecondary,
          opacity: 0.7,
        }}
      >
        Powered by GIPHY
      </div>
    </div>
  );
}