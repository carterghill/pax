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
import {
  fillComposerEditor,
  getPlainTextOffsetsFromSelection,
  insertPlainTextAtSelection,
  serializeComposerEditor,
  setSelectionPlainTextOffsets,
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

function getSelectedLineSpan(value: string, start: number, end: number): { lineStart: number; lineEnd: number } {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const nextNl = value.indexOf("\n", end);
  const lineEnd = nextNl === -1 ? value.length : nextNl;
  return { lineStart, lineEnd };
}

/** Space before a bare image URL when needed so `splitTextWithDirectImageEmbeds` recognizes it (matches paste behavior). */
function leadingSpaceBeforeBareUrl(raw: string, insertAt: number): string {
  if (insertAt === 0) return "";
  const prev = raw[insertAt - 1]!;
  if (/[\s([{<'"`]/.test(prev)) return "";
  if (!/[\w/]/.test(prev)) return "";
  return " ";
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
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [openPopover, setOpenPopover] = useState<"format" | "emoji" | "gif" | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const restoreSelectionRef = useRef<{ start: number; end: number } | null>(null);
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

  const emojiOnlyComposer = useMemo(() => isOnlyEmojisAndWhitespace(text), [text]);

  const composerImgStyle = useMemo(
    () => ({ borderRadius: spacing.unit, maxWidth: "100%" }),
    [spacing.unit],
  );

  /** Grow with typing up to this many lines, then keep height fixed and scroll. */
  const COMPOSER_MAX_AUTO_LINES = 3;
  const composerMaxHeightPx = useMemo(() => {
    const fontSize = emojiOnlyComposer
      ? typography.fontSizeBase * EMOJI_ONLY_DISPLAY_SCALE
      : typography.fontSizeBase;
    const linePx = fontSize * typography.lineHeight;
    const padV = spacing.unit * 3 * 2;
    return Math.ceil(padV + COMPOSER_MAX_AUTO_LINES * linePx);
  }, [emojiOnlyComposer, typography.fontSizeBase, typography.lineHeight, spacing.unit]);

  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    fillComposerEditor(el, text, composerImgStyle);
    const r = restoreSelectionRef.current;
    if (r) {
      setSelectionPlainTextOffsets(el, r.start, r.end);
      restoreSelectionRef.current = null;
    }
    const syncHeight = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, composerMaxHeightPx)}px`;
    };
    syncHeight();
    const ro = new ResizeObserver(syncHeight);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, composerImgStyle, composerMaxHeightPx]);

  const sendTyping = useCallback(
    (typing: boolean) => {
      if (typing === isTyping.current) return;
      isTyping.current = typing;
      invoke("send_typing_notice", { roomId, typing }).catch(() => {});
    },
    [roomId],
  );

  function handleEditorInput() {
    const el = editorRef.current;
    if (!el) return;
    const { start, end } = getPlainTextOffsetsFromSelection(el);
    const next = serializeComposerEditor(el);
    setText((prev) => {
      if (next === prev) return prev;
      restoreSelectionRef.current = { start, end };
      return next;
    });

    if (editingMessage) return;

    if (next.trim().length > 0) {
      sendTyping(true);
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      typingTimeout.current = setTimeout(() => sendTyping(false), 3000);
    } else {
      sendTyping(false);
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
    }
  }

  useEffect(() => {
    return () => {
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      if (isTyping.current) {
        invoke("send_typing_notice", { roomId, typing: false }).catch(() => {});
        isTyping.current = false;
      }
    };
  }, [roomId]);

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

  insertEmojiFromPickerRef.current = (native: string) => {
    insertAtCursor(native, native.length, native.length);
    setOpenPopover(null);
  };

  useLayoutEffect(() => {
    if (openPopover !== "emoji") return;
    const mount = emojiPickerMountRef.current;
    if (!mount) return;
    mount.innerHTML = "";
    const theme = themeName === "light" ? "light" : "dark";
    // Imperative parent mount avoids @emoji-mart/react + ref timing issues (e.g. React 19).
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

  useEffect(() => {
    if (!editingMessage) return;
    const body = editingMessage.body;
    setText(body);
    const len = body.length;
    restoreSelectionRef.current = { start: len, end: len };
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [editingMessage?.eventId]);

  const wrapSelection = useCallback(
    (before: string, after: string, emptyPlaceholder: string) => {
      const el = editorRef.current;
      if (!el) return;
      const { start, end } = getPlainTextOffsetsFromSelection(el);
      const sel = text.slice(start, end);
      const middle = sel || emptyPlaceholder;
      const next = text.slice(0, start) + before + middle + after + text.slice(end);
      const a = start + before.length;
      const b = a + middle.length;
      restoreSelectionRef.current = { start: a, end: b };
      setText(next);
    },
    [text],
  );

  const insertAtCursor = useCallback(
    (insertion: string, selectStartOffset: number, selectEndOffset: number) => {
      const el = editorRef.current;
      if (!el) return;
      const { start, end } = getPlainTextOffsetsFromSelection(el);
      const next = text.slice(0, start) + insertion + text.slice(end);
      restoreSelectionRef.current = {
        start: start + selectStartOffset,
        end: start + selectEndOffset,
      };
      setText(next);
    },
    [text],
  );

  const prefixLines = useCallback(
    (prefix: string, ordered = false) => {
      const el = editorRef.current;
      if (!el) return;
      const { start, end } = getPlainTextOffsetsFromSelection(el);
      const { lineStart, lineEnd } = getSelectedLineSpan(text, start, end);
      const block = text.slice(lineStart, lineEnd);
      const lines = block.split("\n");
      const newLines = ordered
        ? lines.map((line, i) => {
            const stripped = line.replace(/^(\d+\.\s|-\s)/, "");
            return `${i + 1}. ${stripped}`;
          })
        : lines.map((line) => {
            if (line.startsWith(prefix)) return line.slice(prefix.length);
            return prefix + line;
          });
      const newBlock = newLines.join("\n");
      const next = text.slice(0, lineStart) + newBlock + text.slice(lineEnd);
      const delta = newBlock.length - block.length;
      restoreSelectionRef.current = { start: start + delta, end: end + delta };
      setText(next);
    },
    [text],
  );

  const toggleHeadingPrefix = useCallback(
    (hashes: string) => {
      const el = editorRef.current;
      if (!el) return;
      const { start, end } = getPlainTextOffsetsFromSelection(el);
      const { lineStart, lineEnd } = getSelectedLineSpan(text, start, end);
      const block = text.slice(lineStart, lineEnd);
      const lines = block.split("\n");
      const re = /^#{1,6}\s/;
      const newLines = lines.map((line) => {
        if (re.test(line)) {
          const rest = line.replace(re, "");
          return `${hashes} ${rest}`;
        }
        return `${hashes} ${line}`;
      });
      const newBlock = newLines.join("\n");
      const next = text.slice(0, lineStart) + newBlock + text.slice(lineEnd);
      const delta = newBlock.length - block.length;
      restoreSelectionRef.current = { start: start + delta, end: end + delta };
      setText(next);
    },
    [text],
  );

  const insertBlockCode = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const { start, end } = getPlainTextOffsetsFromSelection(el);
    const sel = text.slice(start, end);
    const fence = "```";
    let next: string;
    let selStart: number;
    let selEnd: number;
    if (sel) {
      next = text.slice(0, start) + `${fence}\n${sel}\n${fence}` + text.slice(end);
      selStart = start + fence.length + 1;
      selEnd = selStart + sel.length;
    } else {
      next = text.slice(0, start) + `${fence}\n\n${fence}` + text.slice(end);
      selStart = start + fence.length + 1;
      selEnd = selStart;
    }
    restoreSelectionRef.current = { start: selStart, end: selEnd };
    setText(next);
  }, [text]);

  const insertLink = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const { start, end } = getPlainTextOffsetsFromSelection(el);
    const sel = text.slice(start, end);
    const label = sel || "text";
    const insertion = `[${label}](https://)`;
    const next = text.slice(0, start) + insertion + text.slice(end);
    const urlStart = start + insertion.indexOf("https://");
    const urlEnd = urlStart + "https://".length;
    restoreSelectionRef.current = { start: urlStart, end: urlEnd };
    setText(next);
  }, [text]);

  const insertHorizontalRule = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const { start } = getPlainTextOffsetsFromSelection(el);
    const padBefore = start > 0 && text[start - 1] !== "\n" ? "\n\n" : "\n";
    const insertion = `${padBefore}---\n`;
    insertAtCursor(insertion, insertion.length, insertion.length);
  }, [text, insertAtCursor]);

  type FormatItem = { icon: typeof Bold; label: string; run: () => void };

  const formatGroups: FormatItem[][] = [
    [
      { icon: Bold, label: "Bold", run: () => wrapSelection("**", "**", "bold") },
      { icon: Italic, label: "Italic", run: () => wrapSelection("_", "_", "italic") },
      { icon: Strikethrough, label: "Strikethrough", run: () => wrapSelection("~~", "~~", "text") },
    ],
    [
      { icon: Code, label: "Inline code", run: () => wrapSelection("`", "`", "code") },
      { icon: Braces, label: "Code block", run: () => insertBlockCode() },
    ],
    [{ icon: Link, label: "Link", run: () => insertLink() }],
    [
      { icon: List, label: "Bullet list", run: () => prefixLines("- ") },
      { icon: ListOrdered, label: "Numbered list", run: () => prefixLines("", true) },
      { icon: TextQuote, label: "Quote", run: () => prefixLines("> ") },
    ],
    [
      { icon: Heading1, label: "Heading 1", run: () => toggleHeadingPrefix("#") },
      { icon: Heading2, label: "Heading 2", run: () => toggleHeadingPrefix("##") },
    ],
    [{ icon: Minus, label: "Horizontal rule", run: () => insertHorizontalRule() }],
  ];

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    setOpenPopover(null);
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
        setText("");
      } else {
        await invoke("send_message", { roomId, body: trimmed });
        setText("");
      }
      onMessageSent();
      editorRef.current?.focus();
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
        setText("");
        onCancelEdit();
      }
    }
  }

  const formatBtnGap = spacing.unit * 0.75;
  const groupGap = spacing.unit * 1.5;
  /** Square chrome controls next to the textarea (emoji + markdown + send). */
  const inputToolIconSize = 20;
  /** Outer edge length; icon is centered with minimal inset (no extra CSS padding). */
  const inputToolBtnSize = inputToolIconSize + spacing.unit * 3;
  const inputToolBtnRadius = Math.max(3, spacing.unit * 0.55);
  const hoverToolBtn = (e: React.MouseEvent<HTMLButtonElement>, active: boolean, enter: boolean) => {
    if (active) return;
    e.currentTarget.style.backgroundColor = enter ? palette.bgHover : "transparent";
    e.currentTarget.style.color = enter ? palette.textPrimary : palette.textSecondary;
  };
  const canSend = text.trim().length > 0 && !sending;

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
              const { start } = getPlainTextOffsetsFromSelection(el);
              const prefix = leadingSpaceBeforeBareUrl(text, start);
              const insertion = `${prefix}${gif.url}`;
              insertAtCursor(insertion, insertion.length, insertion.length);
              setOpenPopover(null);
              requestAnimationFrame(() => editorRef.current?.focus());
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

  return (
    <>
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
          {!text.trim() && (
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
            contentEditable
            role="textbox"
            aria-multiline="true"
            aria-label={editingMessage ? "Edit message" : `Message ${roomName}`}
            suppressContentEditableWarning
            onInput={handleEditorInput}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              e.preventDefault();
              const t = e.clipboardData.getData("text/plain");
              const el = editorRef.current;
              if (el) insertPlainTextAtSelection(el, t);
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
                    {group.map(({ icon: Icon, label, run }) => (
                      <button
                        key={label}
                        type="button"
                        role="menuitem"
                        title={label}
                        aria-label={label}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          run();
                          setOpenPopover(null);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: inputToolBtnSize,
                          height: inputToolBtnSize,
                          padding: 0,
                          border: "none",
                          borderRadius: inputToolBtnRadius,
                          backgroundColor: "transparent",
                          color: palette.textSecondary,
                          cursor: "pointer",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = palette.bgHover;
                          e.currentTarget.style.color = palette.textHeading;
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = "transparent";
                          e.currentTarget.style.color = palette.textSecondary;
                        }}
                      >
                        <Icon size={inputToolIconSize} strokeWidth={2} />
                      </button>
                    ))}
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