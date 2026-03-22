import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  Fragment,
} from "react";
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
  Smile,
} from "lucide-react";
import { Picker } from "emoji-mart";
import data from "@emoji-mart/data";
import { useTheme } from "../theme/ThemeContext";
import { EMOJI_ONLY_DISPLAY_SCALE, isOnlyEmojisAndWhitespace } from "../utils/emojifyTwemoji";

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

function afterTextUpdate(
  el: HTMLTextAreaElement,
  start: number,
  end: number,
  focus = true,
) {
  requestAnimationFrame(() => {
    if (focus) el.focus();
    el.setSelectionRange(start, end);
  });
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
  const [formatMenuOpen, setFormatMenuOpen] = useState(false);
  const [emojiMenuOpen, setEmojiMenuOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const emojiPickerMountRef = useRef<HTMLDivElement>(null);
  const insertEmojiFromPickerRef = useRef<(native: string) => void>(() => {});
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping = useRef(false);
  const { palette, typography, spacing, name: themeName } = useTheme();

  const emojiOnlyComposer = useMemo(() => isOnlyEmojisAndWhitespace(text), [text]);

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
    const el = inputRef.current;
    if (!el) return;
    const sync = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, composerMaxHeightPx)}px`;
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, composerMaxHeightPx]);

  const sendTyping = useCallback(
    (typing: boolean) => {
      if (typing === isTyping.current) return;
      isTyping.current = typing;
      invoke("send_typing_notice", { roomId, typing }).catch(() => {});
    },
    [roomId],
  );

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setText(val);

    if (editingMessage) return;

    if (val.trim().length > 0) {
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

  useEffect(() => {
    if (!formatMenuOpen && !emojiMenuOpen) return;
    const onDocDown = (e: MouseEvent) => {
      const root = rootRef.current;
      if (root && e.composedPath().includes(root)) return;
      setFormatMenuOpen(false);
      setEmojiMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFormatMenuOpen(false);
        setEmojiMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [formatMenuOpen, emojiMenuOpen]);

  insertEmojiFromPickerRef.current = (native: string) => {
    insertAtCursor(native, native.length, native.length);
    setEmojiMenuOpen(false);
  };

  useLayoutEffect(() => {
    if (!emojiMenuOpen) return;
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
  }, [emojiMenuOpen, themeName]);

  useEffect(() => {
    if (!editingMessage) return;
    setText(editingMessage.body);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      const len = editingMessage.body.length;
      inputRef.current?.setSelectionRange(len, len);
    });
  }, [editingMessage?.eventId]);

  const wrapSelection = useCallback(
    (before: string, after: string, emptyPlaceholder: string) => {
      const el = inputRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const sel = text.slice(start, end);
      const middle = sel || emptyPlaceholder;
      const next = text.slice(0, start) + before + middle + after + text.slice(end);
      setText(next);
      const a = start + before.length;
      const b = a + middle.length;
      afterTextUpdate(el, a, b);
    },
    [text],
  );

  const insertAtCursor = useCallback(
    (insertion: string, selectStartOffset: number, selectEndOffset: number) => {
      const el = inputRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const next = text.slice(0, start) + insertion + text.slice(el.selectionEnd);
      setText(next);
      afterTextUpdate(el, start + selectStartOffset, start + selectEndOffset);
    },
    [text],
  );

  const prefixLines = useCallback(
    (prefix: string, ordered = false) => {
      const el = inputRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;
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
      setText(next);
      const delta = newBlock.length - block.length;
      afterTextUpdate(el, start + delta, end + delta);
    },
    [text],
  );

  const toggleHeadingPrefix = useCallback(
    (hashes: string) => {
      const el = inputRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;
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
      setText(next);
      const delta = newBlock.length - block.length;
      afterTextUpdate(el, start + delta, end + delta);
    },
    [text],
  );

  const insertBlockCode = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
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
    setText(next);
    afterTextUpdate(el, selStart, selEnd);
  }, [text]);

  const insertLink = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const sel = text.slice(start, end);
    const label = sel || "text";
    const insertion = `[${label}](https://)`;
    const next = text.slice(0, start) + insertion + text.slice(end);
    setText(next);
    const urlStart = start + insertion.indexOf("https://");
    const urlEnd = urlStart + "https://".length;
    afterTextUpdate(el, urlStart, urlEnd);
  }, [text]);

  const insertHorizontalRule = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart;
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
      inputRef.current?.focus();
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
      if (emojiMenuOpen) {
        setEmojiMenuOpen(false);
        return;
      }
      if (formatMenuOpen) {
        setFormatMenuOpen(false);
        return;
      }
      if (editingMessage && onCancelEdit) {
        e.preventDefault();
        setText("");
        onCancelEdit();
      }
    }
  }

  const iconBtnSize = 22;
  const formatBtnPx = spacing.unit * 10;
  const formatBtnRadius = Math.max(3, spacing.unit * 0.55);
  const formatBtnGap = spacing.unit * 0.75;
  const groupGap = spacing.unit * 1.5;
  /** Square chrome controls next to the textarea (emoji + markdown). */
  const inputToolBtnSize = spacing.unit * 10;
  const inputToolBtnRadius = Math.max(3, spacing.unit * 0.55);

  return (
    <div
      ref={rootRef}
      style={{ padding: `0 ${spacing.unit * 3}px ${spacing.unit * 3}px`, position: "relative" }}
    >
      {formatMenuOpen && (
        <div
          role="menu"
          aria-label="Markdown formatting"
          style={{
            position: "absolute",
            bottom: "100%",
            right: 0,
            marginBottom: spacing.unit * 2,
            padding: `${spacing.unit * 2}px ${spacing.unit * 2.5}px`,
            display: "flex",
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "flex-end",
            rowGap: spacing.unit * 1.25,
            columnGap: groupGap,
            width: "max-content",
            maxWidth: "min(100%, calc(100vw - 24px))",
            backgroundColor: palette.bgTertiary,
            border: `1px solid ${palette.border}`,
            borderRadius: spacing.unit * 2,
            boxShadow:
              themeName === "light"
                ? `0 8px 28px rgba(0,0,0,0.1), 0 0 0 1px ${palette.border} inset`
                : `0 12px 44px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.06) inset`,
            zIndex: 20,
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
                    height: formatBtnPx - spacing.unit * 0.75,
                    flexShrink: 0,
                    alignSelf: "center",
                    borderRadius: 1,
                    backgroundColor: palette.border,
                    opacity: 0.9,
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
                      setFormatMenuOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: formatBtnPx,
                      height: formatBtnPx,
                      padding: 0,
                      border: "none",
                      borderRadius: formatBtnRadius,
                      backgroundColor: palette.bgSecondary,
                      color: palette.textSecondary,
                      cursor: "pointer",
                      boxShadow: `0 0 0 1px ${palette.border}`,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = palette.bgHover;
                      e.currentTarget.style.color = palette.textHeading;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = palette.bgSecondary;
                      e.currentTarget.style.color = palette.textSecondary;
                    }}
                  >
                    <Icon size={iconBtnSize} strokeWidth={2} />
                  </button>
                ))}
              </div>
            </Fragment>
          ))}
        </div>
      )}

      <div
        style={{
          backgroundColor: palette.bgActive,
          borderRadius: spacing.unit * 1.5,
          display: "flex",
          alignItems: "flex-end",
          minHeight: spacing.unit * 11,
        }}
      >
        <textarea
          ref={inputRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={editingMessage ? "Edit message" : `Message #${roomName}`}
          rows={1}
          style={{
            flex: 1,
            minWidth: 0,
            alignSelf: "flex-end",
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
            resize: "none",
            maxHeight: composerMaxHeightPx,
            overflowY: "auto",
            boxSizing: "border-box",
          }}
        />
        <div
          style={{
            position: "relative",
            flexShrink: 0,
            alignSelf: "flex-end",
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
          }}
        >
          {emojiMenuOpen && (
            <div
              style={{
                position: "absolute",
                bottom: "100%",
                right: 0,
                marginBottom: spacing.unit * 2,
                zIndex: 21,
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
            </div>
          )}
          <button
            type="button"
            title="Emoji"
            aria-label="Insert emoji"
            aria-expanded={emojiMenuOpen}
            aria-haspopup="dialog"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setFormatMenuOpen(false);
              setEmojiMenuOpen((o) => !o);
            }}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: inputToolBtnSize,
              height: inputToolBtnSize,
              margin: spacing.unit,
              marginRight: spacing.unit * 0.75,
              border: "none",
              borderRadius: inputToolBtnRadius,
              backgroundColor: emojiMenuOpen ? palette.bgHover : "transparent",
              color: emojiMenuOpen ? palette.textPrimary : palette.textSecondary,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              if (!emojiMenuOpen) {
                e.currentTarget.style.backgroundColor = palette.bgHover;
                e.currentTarget.style.color = palette.textPrimary;
              }
            }}
            onMouseLeave={(e) => {
              if (!emojiMenuOpen) {
                e.currentTarget.style.backgroundColor = "transparent";
                e.currentTarget.style.color = palette.textSecondary;
              }
            }}
          >
            <Smile size={20} strokeWidth={2} />
          </button>
        </div>
        <button
          type="button"
          title="Text formatting"
          aria-expanded={formatMenuOpen}
          aria-haspopup="menu"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setEmojiMenuOpen(false);
            setFormatMenuOpen((o) => !o);
          }}
          style={{
            flexShrink: 0,
            alignSelf: "flex-end",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: inputToolBtnSize,
            height: inputToolBtnSize,
            margin: spacing.unit,
            marginLeft: 0,
            border: "none",
            borderRadius: inputToolBtnRadius,
            backgroundColor: formatMenuOpen ? palette.bgHover : "transparent",
            color: formatMenuOpen ? palette.textPrimary : palette.textSecondary,
            cursor: "pointer",
          }}
          onMouseEnter={(e) => {
            if (!formatMenuOpen) {
              e.currentTarget.style.backgroundColor = palette.bgHover;
              e.currentTarget.style.color = palette.textPrimary;
            }
          }}
          onMouseLeave={(e) => {
            if (!formatMenuOpen) {
              e.currentTarget.style.backgroundColor = "transparent";
              e.currentTarget.style.color = palette.textSecondary;
            }
          }}
        >
          <Type size={20} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
