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
import { listen } from "@tauri-apps/api/event";
import type { Message, RoomMember } from "../types/matrix";
import CircularUploadRing from "./CircularUploadRing";
import { useRoomMembers } from "../hooks/useRoomMembers";
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
  Paperclip,
  File,
  X,
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
import { paletteComposerOuterBorderStyle } from "../theme/paletteBorder";
import type { ResolvedColorScheme } from "../theme/types";
import { EMOJI_ONLY_DISPLAY_SCALE, isOnlyEmojisAndWhitespace } from "../utils/emojifyTwemoji";
import { hrefLooksLikeDirectImageUrl } from "../utils/directImageUrl";
import {
  serializeComposerEditor,
  fillComposerEditorFromMarkdown,
  getEditorPlainText,
  insertPlainTextAtSelection,
  insertImageAtSelection,
  syncComposerHeightAfterImages,
  getActiveFormats,
  toggleInlineCode,
  toggleCodeBlock,
  toggleLink,
  createComposerMentionSpan,
  replaceBareMxidsWithPillsInComposer,
  type ComposerMentionPillStyle,
} from "../utils/composerEditorDom";
import { MODAL_LAYER_Z } from "./ModalLayer";

export interface EditingMessageRef {
  eventId: string;
  body: string;
}

export type ComposerPermission = "loading" | "allowed" | "forbidden";

export type MessageFileSendBridge = {
  addOptimistic: (msg: Message) => void;
  patchMessage: (eventId: string, patch: Partial<Message>) => void;
  patchMessageByUploadId: (uploadId: string, patch: Partial<Message>) => void;
  replaceMessageEventId: (oldId: string, newId: string, patch?: Partial<Message>) => void;
  removeMessage: (eventId: string) => void;
};

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

/** Single combined progress scale: staging 0..END, HTTP upload END..HTTP_END, then send/sync. */
const UPLOAD_STAGING_END = 0.15;
const UPLOAD_HTTP_END = 0.9;

type PendingAttachment = {
  uploadId: string;
  name: string;
  mimeType: string;
  sourceFile: File;
  contentUri: string | null;
  byteSize: number | null;
  previewUrl: string | null;
  phase: "reading" | "uploading" | "ready" | "error";
  progress01: number;
  errorMessage?: string;
};

function formatInvokeErr(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function replyTargetSummary(msg: Message): string {
  const who = (msg.senderName?.trim() || msg.sender).trim() || "Message";
  if (msg.imageMediaRequest) return `${who} · Image`;
  if (msg.localImagePreviewObjectUrl) return `${who} · Image`;
  if (msg.videoMediaRequest) return `${who} · Video`;
  if (msg.fileMediaRequest) {
    const fn = msg.fileDisplayName?.trim();
    return fn ? `${who} · ${fn}` : `${who} · File`;
  }
  const t = msg.body.trim();
  if (!t) return who;
  return t.length > 100 ? `${who} · ${t.slice(0, 100)}…` : `${who} · ${t}`;
}

/** Human-readable size (binary units) for upload limit messaging. */
function formatBinaryBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${Math.round(v)} ${units[i]}` : `${v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

const STAGING_CHUNK = 512 * 1024;

function uint8ToBase64Chunk(u8: Uint8Array): string {
  const CH = 8192;
  const parts: string[] = [];
  for (let i = 0; i < u8.length; i += CH) {
    parts.push(String.fromCharCode(...u8.subarray(i, i + CH)));
  }
  return btoa(parts.join(""));
}

/** Writes the file to a Rust-side staging file in small base64 IPC chunks (bounded memory). */
async function streamFileToStaging(
  file: File,
  uploadId: string,
  onFraction: (f: number) => void,
): Promise<void> {
  const size = file.size;
  if (size === 0) {
    await invoke("room_file_staging_reset", { uploadId });
    onFraction(1);
    return;
  }
  await invoke("room_file_staging_reset", { uploadId });
  let offset = 0;
  while (offset < size) {
    const end = Math.min(offset + STAGING_CHUNK, size);
    const buf = await file.slice(offset, end).arrayBuffer();
    const u8 = new Uint8Array(buf);
    await invoke("room_file_staging_append_b64", {
      uploadId,
      chunkB64: uint8ToBase64Chunk(u8),
    });
    offset = end;
    onFraction(offset / size);
  }
}

async function stagingByteLenMatchesFile(uploadId: string, fileSize: number): Promise<boolean> {
  let len = 0;
  try {
    len = await invoke<number>("room_file_staging_byte_len", { uploadId });
  } catch {
    len = 0;
  }
  return len === fileSize;
}

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
  const lastTypingSentAt = useRef(0);
  const { palette, typography, spacing, resolvedColorScheme } = useTheme();
  const [giphyApiKey, setGiphyApiKey] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<PendingAttachment | null>(null);
  const pendingFileRef = useRef<PendingAttachment | null>(null);

  // ─── Mention autocomplete ─────────────────────────────────────────────────

  const { members: roomMembers } = useRoomMembers(roomId);

  const memberLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const mem of roomMembers) {
      const label = (mem.displayName?.trim() || mem.userId).trim();
      m.set(mem.userId.trim().toLowerCase(), label);
    }
    return m;
  }, [roomMembers]);

  const resolveMemberLabel = useCallback(
    (uid: string) => {
      const hit = memberLabelById.get(uid.trim().toLowerCase());
      if (hit) return hit;
      return uid;
    },
    [memberLabelById],
  );

  const getComposerMentionVisibleLabel = useCallback(
    (mxid: string) => {
      if (mxid === "@room") return "@room";
      const resolved = resolveMemberLabel(mxid);
      if (resolved.startsWith("@")) return resolved.split(":")[0];
      return `@${resolved}`;
    },
    [resolveMemberLabel],
  );

  const composerMentionPillStyle = useMemo<ComposerMentionPillStyle>(
    () => ({
      backgroundColor: `${palette.accent}22`,
      color: palette.accent,
      fontWeight: typography.fontWeightMedium,
    }),
    [palette.accent, typography.fontWeightMedium],
  );

  const makeComposerMentionSpan = useCallback(
    (mxid: string, label: string) => createComposerMentionSpan(mxid, label, composerMentionPillStyle),
    [composerMentionPillStyle],
  );

  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  /** Guard to skip re-detection after we programmatically insert a mention. */
  const mentionInsertingRef = useRef(false);
  const mentionMenuRef = useRef<HTMLDivElement>(null);

  /** Filtered + scored members for the autocomplete menu. */
  const mentionCandidates = useMemo(() => {
    if (!mentionMenuOpen || !mentionQuery) return [];
    const q = mentionQuery.toLowerCase();
    return roomMembers
      .filter((m) => {
        // Don't suggest yourself
        if (m.userId === selfUserId) return false;
        const localpart = m.userId.startsWith("@")
          ? m.userId.slice(1).split(":")[0]
          : m.userId.split(":")[0];
        const dn = (m.displayName ?? "").toLowerCase();
        return localpart.toLowerCase().includes(q) || dn.includes(q);
      })
      .slice(0, 8);
  }, [mentionMenuOpen, mentionQuery, roomMembers, selfUserId]);

  // Clamp mentionIndex when candidates change.
  useEffect(() => {
    setMentionIndex((prev) => Math.min(prev, Math.max(0, mentionCandidates.length - 1)));
  }, [mentionCandidates.length]);

  // Close the menu when candidates are empty.
  useEffect(() => {
    if (mentionMenuOpen && mentionCandidates.length === 0 && mentionQuery.length > 0) {
      setMentionMenuOpen(false);
    }
  }, [mentionMenuOpen, mentionCandidates.length, mentionQuery]);

  // Scroll the highlighted item into view when navigating with keyboard.
  useEffect(() => {
    if (!mentionMenuOpen || !mentionMenuRef.current) return;
    const items = mentionMenuRef.current.querySelectorAll("[role='option']");
    items[mentionIndex]?.scrollIntoView({ block: "nearest" });
  }, [mentionIndex, mentionMenuOpen]);

  /**
   * Get the text before the cursor and find an active `@query` pattern.
   * Returns the query string (after `@`) or null if no mention context.
   */
  function getMentionContext(): string | null {
    const el = editorRef.current;
    if (!el) return null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;

    // Build text-before-cursor by walking the editor DOM.
    const range = sel.getRangeAt(0);
    const preRange = document.createRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.startContainer, range.startOffset);
    const textBefore = preRange.toString().replace(/\u200b/g, "");

    // Walk backwards from end to find @ trigger.
    const lastAt = textBefore.lastIndexOf("@");
    if (lastAt === -1) return null;

    // @ must be at start or preceded by whitespace / newline.
    if (lastAt > 0) {
      const charBefore = textBefore[lastAt - 1];
      if (!/[\s\n]/.test(charBefore)) return null;
    }

    const query = textBefore.slice(lastAt + 1);
    // No spaces or newlines allowed in the query portion.
    if (/[\s\n]/.test(query)) return null;
    return query;
  }

  /**
   * Find a member whose displayName or localpart exactly matches `query`
   * (case-insensitive).  Used for auto-resolve on space/colon.
   */
  function findExactMemberMatch(query: string): RoomMember | null {
    const q = query.toLowerCase();
    for (const m of roomMembers) {
      if (m.userId === selfUserId) continue;
      const localpart = m.userId.startsWith("@")
        ? m.userId.slice(1).split(":")[0]
        : m.userId.split(":")[0];
      if (localpart.toLowerCase() === q) return m;
      if (m.displayName && m.displayName.toLowerCase() === q) return m;
    }
    return null;
  }

  /**
   * Replace the current `@query` text in the editor with the full MXID and
   * a trailing space, using execCommand so undo history is preserved.
   */
  function completeMention(member: RoomMember) {
    const el = editorRef.current;
    if (!el) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    // Re-derive text-before-cursor to find the exact @ position.
    const range = sel.getRangeAt(0);
    const preRange = document.createRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.startContainer, range.startOffset);
    const textBefore = preRange.toString().replace(/\u200b/g, "");
    const lastAt = textBefore.lastIndexOf("@");
    if (lastAt === -1) return;

    // We need to select from the @ to the current cursor, then replace.
    // Walk the DOM to find the text node + offset corresponding to `lastAt`.
    let charCount = 0;
    let startNode: Node | null = null;
    let startOffset = 0;

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const tn = walker.currentNode;
      const len = (tn.textContent ?? "").replace(/\u200b/g, "").length;
      if (charCount + len > lastAt) {
        startNode = tn;
        // Map clean charCount back to raw offset.
        const cleanTarget = lastAt - charCount;
        let rawOffset = 0;
        let cleanSeen = 0;
        const raw = tn.textContent ?? "";
        for (let i = 0; i < raw.length; i++) {
          if (cleanSeen === cleanTarget) break;
          if (raw[i] !== "\u200b") cleanSeen++;
          rawOffset = i + 1;
        }
        startOffset = rawOffset;
        break;
      }
      charCount += len;
    }
    if (!startNode) return;

    // Select from @ to cursor.
    const replaceRange = document.createRange();
    replaceRange.setStart(startNode, startOffset);
    replaceRange.setEnd(range.startContainer, range.startOffset);
    sel.removeAllRanges();
    sel.addRange(replaceRange);

    mentionInsertingRef.current = true;
    replaceRange.deleteContents();
    const span = makeComposerMentionSpan(
      member.userId,
      getComposerMentionVisibleLabel(member.userId),
    );
    replaceRange.insertNode(span);
    const space = document.createTextNode(" ");
    span.after(space);
    const after = document.createRange();
    after.setStartAfter(space);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    mentionInsertingRef.current = false;

    setMentionMenuOpen(false);
    setMentionQuery("");
    setMentionIndex(0);

    // Sync state.
    refreshComposerDomState();
  }

  useEffect(() => {
    invoke<string>("get_giphy_api_key").then(setGiphyApiKey).catch(() => {});
  }, []);

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
    // `overflow-y: auto` always reserves a track in some hosts; only enable when we cap at max height.
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

  useLayoutEffect(syncHeight, [syncHeight]);

  useEffect(() => {
    document.execCommand("defaultParagraphSeparator", false, "div");
  }, []);

  // ─── Typing indicator ─────────────────────────────────────────────────────

  const sendTyping = useCallback(
    (typing: boolean) => {
      if (draftDmPeerUserId) return;
      if (interactionLockedRef.current) return;

      if (typing) {
        const now = Date.now();
        if (isTyping.current && now - lastTypingSentAt.current < 3000) return;
        lastTypingSentAt.current = now;
        if (!isTyping.current) {
          isTyping.current = true;
          onLocalTypingActive?.(true);
        }
        invoke("send_typing_notice", { roomId, typing: true }).catch(() => {});
      } else {
        if (!isTyping.current) return;
        isTyping.current = false;
        lastTypingSentAt.current = 0;
        onLocalTypingActive?.(false);
        invoke("send_typing_notice", { roomId, typing: false }).catch(() => {});
      }
    },
    [roomId, onLocalTypingActive, draftDmPeerUserId],
  );

  useEffect(() => {
    return () => {
      if (draftDmPeerUserId) return;
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      if (isTyping.current) {
        invoke("send_typing_notice", { roomId, typing: false }).catch(() => {});
        isTyping.current = false;
        onLocalTypingActive?.(false);
      }
    };
  }, [roomId, onLocalTypingActive, draftDmPeerUserId]);

  useEffect(() => {
    pendingFileRef.current = pendingFile;
  }, [pendingFile]);

  useEffect(() => {
    return () => {
      const p = pendingFileRef.current;
      if (p?.previewUrl) URL.revokeObjectURL(p.previewUrl);
    };
  }, []);

  useEffect(() => {
    if (!roomId) return;
    let unlisten: (() => void) | undefined;
    void listen<{ uploadId: string; roomId: string; sent: number; total: number }>(
      "room-file-upload-progress",
      (ev) => {
        const { uploadId, roomId: rid, sent, total } = ev.payload;
        if (rid !== roomId) return;
        const denom = total > 0 ? total : 1;
        const prog = Math.min(
          UPLOAD_HTTP_END,
          UPLOAD_STAGING_END + (sent / denom) * (UPLOAD_HTTP_END - UPLOAD_STAGING_END),
        );
        setPendingFile((p) =>
          p?.uploadId === uploadId ? { ...p, phase: "uploading", progress01: prog } : p,
        );
        fileSendBridge?.patchMessageByUploadId(uploadId, {
          localFileUpload: { phase: "uploading", progress: prog },
        });
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [roomId, fileSendBridge]);

  useEffect(() => {
    if (!editingMessage) return;
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    sendTyping(false);
  }, [editingMessage, sendTyping]);

  // ─── Editor input handler ─────────────────────────────────────────────────

  function handleEditorInput() {
    if (interactionLocked) return;
    const el = editorRef.current;
    if (!el) return;
    if (!mentionInsertingRef.current) {
      replaceBareMxidsWithPillsInComposer(el, getComposerMentionVisibleLabel, makeComposerMentionSpan);
    }
    const text = getEditorPlainText(el);
    const media = el.querySelector("img") != null;
    setPlainText(text);
    setHasComposerMedia(media);
    syncHeight();

    // ── Mention autocomplete detection ────────────────────────────────────
    if (!mentionInsertingRef.current) {
      const ctx = getMentionContext();
      if (ctx !== null && ctx.length > 0) {
        // Check for auto-resolve: if the last character is space or colon,
        // see if the text before it exactly matches a member.
        const lastChar = ctx[ctx.length - 1];
        if (lastChar === " " || lastChar === ":") {
          const queryWithout = ctx.slice(0, -1);
          const match = findExactMemberMatch(queryWithout);
          if (match) {
            // Replace @query + trailing char with @mxid + space.
            // We need to re-derive context after the replace, so defer.
            requestAnimationFrame(() => {
              // Re-check that context is still valid (user might have
              // typed more in the meantime).
              const recheck = getMentionContext();
              if (recheck === null) return;
              const recheckClean = recheck.replace(/[\s:]$/, "");
              const m2 = findExactMemberMatch(recheckClean);
              if (!m2) return;
              // Select back to the @ and replace.
              completeMention(m2);
            });
            setMentionMenuOpen(false);
          } else {
            setMentionMenuOpen(false);
            setMentionQuery("");
          }
        } else {
          setMentionQuery(ctx);
          setMentionMenuOpen(true);
          setMentionIndex(0);
        }
      } else if (ctx !== null && ctx.length === 0) {
        // Just typed `@` with nothing after — don't open yet, wait for a char.
        setMentionMenuOpen(false);
        setMentionQuery("");
      } else {
        setMentionMenuOpen(false);
        setMentionQuery("");
      }
    }

    if (editingMessage) return;
    if (draftDmPeerUserId) return;
    if (text.trim().length > 0 || media) {
      sendTyping(true);
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      typingTimeout.current = setTimeout(() => {
        sendTyping(false);
      }, 3000);
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
    if (interactionLockedRef.current) return;
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
    const theme = resolvedColorScheme === "light" ? "light" : "dark";
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
  }, [pickerOpen, pickerTab, popoverPos, resolvedColorScheme]);

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

  const prepareAttachment = useCallback(
    async (uploadId: string) => {
      try {
        let cur = pendingFileRef.current;
        if (!cur || cur.uploadId !== uploadId) return;

        if (cur.contentUri) {
          const ready: PendingAttachment = { ...cur, phase: "ready", progress01: 1 };
          pendingFileRef.current = ready;
          setPendingFile(ready);
          return;
        }

        await streamFileToStaging(cur.sourceFile, uploadId, (f) => {
          if (pendingFileRef.current?.uploadId !== uploadId) return;
          const prog = f * UPLOAD_STAGING_END;
          setPendingFile((p) =>
            p?.uploadId === uploadId ? { ...p, phase: "reading", progress01: prog } : p,
          );
        });

        cur = pendingFileRef.current;
        if (!cur || cur.uploadId !== uploadId) return;

        const uploading: PendingAttachment = {
          ...cur,
          phase: "uploading",
          progress01: UPLOAD_STAGING_END,
        };
        pendingFileRef.current = uploading;
        setPendingFile(uploading);

        const [contentUri, byteSize] = await invoke<[string, number]>("upload_room_file", {
          roomId,
          uploadId: cur.uploadId,
          fileName: cur.name,
          mimeType: cur.mimeType,
        });

        cur = pendingFileRef.current;
        if (!cur || cur.uploadId !== uploadId) return;

        const done: PendingAttachment = {
          ...cur,
          contentUri,
          byteSize,
          phase: "ready",
          progress01: 1,
        };
        pendingFileRef.current = done;
        setPendingFile(done);
      } catch (e) {
        const msg = formatInvokeErr(e);
        console.error("Attachment prepare failed:", e);
        void invoke("room_file_staging_remove", { uploadId }).catch(() => {});
        setPendingFile((p) =>
          p?.uploadId === uploadId
            ? { ...p, phase: "error", errorMessage: msg, progress01: 0 }
            : p,
        );
      }
    },
    [roomId],
  );

  const runFileSendPipeline = useCallback(
    async (
      localEventId: string,
      snapshot: PendingAttachment,
      caption: string,
      bridge: MessageFileSendBridge,
    ) => {
      try {
        let contentUri = snapshot.contentUri;
        let byteSize = snapshot.byteSize;
        if (!contentUri) {
          const ok = await stagingByteLenMatchesFile(snapshot.uploadId, snapshot.sourceFile.size);
          if (!ok) {
            await streamFileToStaging(snapshot.sourceFile, snapshot.uploadId, (f) => {
              bridge.patchMessage(localEventId, {
                localFileUpload: {
                  phase: "encoding",
                  progress: f * UPLOAD_STAGING_END,
                },
              });
            });
          }

          bridge.patchMessage(localEventId, {
            localFileUpload: { phase: "uploading", progress: UPLOAD_STAGING_END },
          });
          const res = await invoke<[string, number]>("upload_room_file", {
            roomId,
            uploadId: snapshot.uploadId,
            fileName: snapshot.name,
            mimeType: snapshot.mimeType,
          });
          contentUri = res[0];
          byteSize = res[1];
        }

        bridge.patchMessage(localEventId, {
          localFileUpload: { phase: "sending", progress: 0.92 },
        });

        const cap = caption.trim();
        const serverEventId = await invoke<string>("send_file_message", {
          roomId,
          contentUri,
          fileName: snapshot.name,
          mimeType: snapshot.mimeType,
          fileSize: byteSize ?? null,
          caption: cap.length > 0 ? cap : null,
        });

        bridge.replaceMessageEventId(localEventId, serverEventId, {
          localPipelineUploadId: undefined,
          localFileUpload: { phase: "syncing", progress: 1 },
        });
      } catch (e) {
        const msg = formatInvokeErr(e);
        console.error("Failed to send file message:", e);
        void invoke("room_file_staging_remove", { uploadId: snapshot.uploadId }).catch(() => {});
        bridge.patchMessage(localEventId, {
          localFileUpload: { phase: "failed", progress: 0, errorMessage: msg },
        });
      }
    },
    [roomId],
  );

  function detachPendingAttachmentForSend() {
    pendingFileRef.current = null;
    setPendingFile(null);
  }

  // ─── Send / key handling ──────────────────────────────────────────────────

  async function handleSend() {
    if (interactionLocked) return;
    const el = editorRef.current;
    if (!el) return;
    const markdown = serializeComposerEditor(el);
    const trimmed = markdown.trim();
    if ((!trimmed && !pendingFile) || sending) return;

    // Close picker but keep format toolbar open across sends.
    setPickerOpen(false);
    sendTyping(false);
    if (typingTimeout.current) clearTimeout(typingTimeout.current);

    setSending(true);
    try {
      if (draftDmPeerUserId) {
        if (pendingFile) {
          setSending(false);
          return;
        }
        if (!trimmed || editingMessage) {
          setSending(false);
          return;
        }
        const rid = await invoke<string>("send_first_direct_message", {
          peerUserId: draftDmPeerUserId,
          body: trimmed,
        });
        const prevFormats = getActiveFormats(el);
        el.innerHTML = "";
        setPlainText("");
        setHasComposerMedia(false);
        await onDraftDmFirstMessage?.(rid);
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
        setSending(false);
        return;
      }
      if (pendingFile) {
        if (!fileSendBridge || !selfUserId) {
          setSending(false);
          return;
        }
        if (editingMessage) {
          setSending(false);
          return;
        }
        const snap = pendingFileRef.current;
        if (!snap) {
          setSending(false);
          return;
        }
        const localEventId = `local:${crypto.randomUUID()}`;
        const cap = trimmed;
        const body = cap.trim().length > 0 ? cap.trim() : "";

        const optimPhase =
          snap.phase === "ready"
            ? "sending"
            : snap.phase === "uploading"
              ? "uploading"
              : snap.phase === "error"
                ? "failed"
                : "encoding";

        fileSendBridge.addOptimistic({
          eventId: localEventId,
          sender: selfUserId,
          senderName: selfDisplayName?.trim() || selfUserId,
          body,
          timestamp: Date.now(),
          avatarUrl: selfAvatarUrl ?? null,
          fileDisplayName: snap.name,
          fileMime: snap.mimeType,
          localPipelineUploadId: snap.uploadId,
          localFileUpload: {
            phase: optimPhase,
            progress: Math.min(1, snap.progress01),
          },
          localImagePreviewObjectUrl: snap.previewUrl,
        });

        detachPendingAttachmentForSend();

        const prevFormats = getActiveFormats(el);
        el.innerHTML = "";
        setPlainText("");
        setHasComposerMedia(false);
        el.focus();
        if (prevFormats.has("bold") || prevFormats.has("italic") || prevFormats.has("strikethrough")) {
          document.execCommand("insertText", false, "\u200b");
          const sel = window.getSelection();
          if (sel) {
            sel.selectAllChildren(el);
          }
          for (const fmt of prevFormats) {
            if (fmt === "bold") document.execCommand("bold");
            else if (fmt === "italic") document.execCommand("italic");
            else if (fmt === "strikethrough") document.execCommand("strikeThrough");
          }
          if (sel) {
            sel.collapseToEnd();
          }
        }
        refreshFormats();
        syncHeight();

        void runFileSendPipeline(localEventId, snap, cap, fileSendBridge).finally(() => {
          onMessageSent();
        });

        setSending(false);
        return;
      }

      if (trimmed) {
        // Text-only message
        if (editingMessage) {
          await invoke("edit_message", {
            roomId,
            eventId: editingMessage.eventId,
            body: trimmed,
          });
          onCancelEdit?.();
        } else {
          await invoke("send_message", {
            roomId,
            body: trimmed,
            replyToEventId: replyDraft?.eventId ?? null,
          });
          onCancelReply?.();
        }
      }
      const prevFormats = getActiveFormats(el);
      el.innerHTML = "";
      setPlainText("");
      setHasComposerMedia(false);
      onMessageSent();
      el.focus();
      if (prevFormats.has("bold") || prevFormats.has("italic") || prevFormats.has("strikethrough")) {
        document.execCommand("insertText", false, "\u200b");
        const sel = window.getSelection();
        if (sel) {
          sel.selectAllChildren(el);
        }
        for (const fmt of prevFormats) {
          if (fmt === "bold") document.execCommand("bold");
          else if (fmt === "italic") document.execCommand("italic");
          else if (fmt === "strikethrough") document.execCommand("strikeThrough");
        }
        if (sel) {
          sel.collapseToEnd();
        }
      }
      refreshFormats();
      syncHeight();
    } catch (e) {
      console.error(editingMessage ? "Failed to edit:" : "Failed to send:", e);
    }
    setSending(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (interactionLocked) return;

    // ── Mention autocomplete keyboard handling ────────────────────────────
    if (mentionMenuOpen && mentionCandidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, mentionCandidates.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const selected = mentionCandidates[mentionIndex];
        if (selected) completeMention(selected);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionMenuOpen(false);
        return;
      }
    }

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

  // ─── File upload ──────────────────────────────────────────────────────────

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    if (interactionLocked) return;
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    try {
      const uploadId = crypto.randomUUID();
      const mimeType = file.type || "application/octet-stream";
      const previewUrl = mimeType.startsWith("image/") ? URL.createObjectURL(file) : null;

      let maxBytes: number | null = null;
      try {
        maxBytes = await invoke<number | null>("get_matrix_max_upload_bytes");
      } catch {
        // e.g. not logged in — still allow picking; server will reject if needed
      }

      if (maxBytes != null && file.size > maxBytes) {
        const next: PendingAttachment = {
          uploadId,
          name: file.name,
          mimeType,
          sourceFile: file,
          contentUri: null,
          byteSize: null,
          previewUrl,
          phase: "error",
          progress01: 0,
          errorMessage: `This file is ${formatBinaryBytes(file.size)} but your homeserver only allows ${formatBinaryBytes(maxBytes)} per upload (Matrix media limit).`,
        };
        pendingFileRef.current = next;
        setPendingFile(next);
        return;
      }

      const next: PendingAttachment = {
        uploadId,
        name: file.name,
        mimeType,
        sourceFile: file,
        contentUri: null,
        byteSize: null,
        previewUrl,
        phase: "reading",
        progress01: 0,
      };
      pendingFileRef.current = next;
      setPendingFile(next);
      void prepareAttachment(uploadId);
    } catch (err) {
      console.error("Failed to read file:", err);
    }
  }

  function clearPendingFile() {
    const p = pendingFileRef.current;
    if (p?.uploadId) {
      void invoke("room_file_staging_remove", { uploadId: p.uploadId }).catch(() => {});
    }
    if (p?.previewUrl) URL.revokeObjectURL(p.previewUrl);
    pendingFileRef.current = null;
    setPendingFile(null);
  }

  useEffect(() => {
    if (composerPermission !== "loading") return;
    setPickerOpen(false);
    setFormatOpen(false);
  }, [composerPermission]);

  useEffect(() => {
    if (draftDmPeerUserId) return;
    if (composerPermission !== "forbidden") return;

    sendTyping(false);
    if (typingTimeout.current) {
      clearTimeout(typingTimeout.current);
      typingTimeout.current = null;
    }
    if (isTyping.current) {
      isTyping.current = false;
      onLocalTypingActive?.(false);
      invoke("send_typing_notice", { roomId, typing: false }).catch(() => {});
    }
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
  }, [composerPermission, draftDmPeerUserId, roomId, sendTyping, onLocalTypingActive, syncHeight]);

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
      : "You don’t have permission to send messages in this channel."
    : defaultPlaceholder;

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
            resolvedColorScheme === "light"
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
                colorScheme={resolvedColorScheme}
                onGifSelect={(gifUrl) => {
                  const el = editorRef.current;
                  if (!el) return;
                  el.focus();
                  if (hrefLooksLikeDirectImageUrl(gifUrl)) {
                    insertImageAtSelection(el, gifUrl, composerImgStyle, () => syncHeight());
                  } else {
                    document.execCommand("insertText", false, gifUrl);
                  }
                  refreshComposerDomState();
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

      {/* ── Mention autocomplete menu ──────────────────────────────────────── */}
      {mentionMenuOpen && mentionCandidates.length > 0 && (
        <div
          ref={mentionMenuRef}
          role="listbox"
          aria-label="Mention suggestions"
          style={{
            position: "absolute",
            bottom: "100%",
            // Match composer width (abs positioning uses the padding box; in-flow content is inset).
            left: spacing.unit * 3,
            right: spacing.unit * 3,
            marginBottom: spacing.unit,
            backgroundColor: palette.bgSecondary,
            border: `1px solid ${palette.border}`,
            borderRadius: spacing.unit * 1.5,
            boxShadow:
              resolvedColorScheme === "light"
                ? "0 -2px 12px rgba(0,0,0,0.10)"
                : "0 -2px 16px rgba(0,0,0,0.40)",
            overflow: "hidden",
            zIndex: COMPOSER_POPOVER_Z,
          }}
        >
          {mentionCandidates.map((m, i) => {
            const localpart = m.userId.startsWith("@")
              ? m.userId.slice(1).split(":")[0]
              : m.userId.split(":")[0];
            const isSelected = i === mentionIndex;
            const mentionRowFadePx = spacing.unit * 4;
            const mentionRowMask = `linear-gradient(90deg, #000 0%, #000 calc(100% - ${mentionRowFadePx}px), transparent 100%)`;
            return (
              <div
                key={m.userId}
                role="option"
                aria-selected={isSelected}
                title={`${m.displayName ?? localpart} ${m.userId}`}
                onMouseDown={(e) => {
                  // mouseDown (not click) so it fires before the editor blur.
                  e.preventDefault();
                  completeMention(m);
                }}
                onMouseEnter={() => setMentionIndex(i)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  minWidth: 0,
                  padding: `${spacing.unit * 1.5}px ${spacing.unit * 2.5}px`,
                  cursor: "pointer",
                  backgroundColor: isSelected ? palette.bgHover : "transparent",
                  transition: "background-color 60ms ease",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: spacing.unit * 2,
                    minWidth: 0,
                    flex: 1,
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    maskImage: mentionRowMask,
                    WebkitMaskImage: mentionRowMask,
                  }}
                >
                  <span
                    style={{
                      fontWeight: typography.fontWeightMedium,
                      color: palette.textPrimary,
                      fontSize: typography.fontSizeBase,
                      flexShrink: 0,
                    }}
                  >
                    {m.displayName ?? localpart}
                  </span>
                  <span
                    style={{
                      fontSize: typography.fontSizeSmall,
                      color: palette.textSecondary,
                      flexShrink: 0,
                    }}
                  >
                    {m.userId}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

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
        {replyDraft && onCancelReply && !editingMessage ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.unit * 1.5,
              padding: `${spacing.unit * 1.5}px ${spacing.unit * 3}px`,
              borderBottom: `1px solid ${palette.border}`,
              minWidth: 0,
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: typography.fontSizeSmall,
                color: palette.textSecondary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={replyTargetSummary(replyDraft)}
            >
              Replying to {replyTargetSummary(replyDraft)}
            </span>
            <button
              type="button"
              onClick={() => onCancelReply()}
              title="Cancel reply"
              style={{
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 28,
                height: 28,
                border: "none",
                borderRadius: spacing.unit,
                background: "transparent",
                color: palette.textSecondary,
                cursor: "pointer",
              }}
            >
              <X size={16} />
            </button>
          </div>
        ) : null}
        {/* Attachment preview */}
        {pendingFile && (
          <div
            style={{
              padding: `${spacing.unit * 2}px ${spacing.unit * 3}px 0`,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: spacing.unit,
                backgroundColor: palette.bgTertiary,
                borderRadius: spacing.unit * 1.25,
                border: `1px solid ${palette.border}`,
                padding: `${spacing.unit * 1.25}px ${spacing.unit * 1.5}px`,
                maxWidth: "100%",
                minWidth: 0,
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: spacing.unit * 2,
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "row",
                    alignItems: "center",
                    gap: spacing.unit * 1.5,
                  }}
                >
                  {pendingFile.previewUrl ? (
                    <img
                      src={pendingFile.previewUrl}
                      alt=""
                      draggable={false}
                      style={{
                        display: "block",
                        width: 56,
                        height: 56,
                        objectFit: "cover",
                        borderRadius: spacing.unit,
                        flexShrink: 0,
                      }}
                    />
                  ) : (
                    <File
                      size={20}
                      strokeWidth={2}
                      style={{
                        flexShrink: 0,
                        color: palette.textSecondary,
                      }}
                      aria-hidden
                    />
                  )}
                  <span
                    style={{
                      fontSize: typography.fontSizeSmall,
                      fontFamily: typography.fontFamily,
                      color: palette.textPrimary,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      minWidth: 0,
                    }}
                    title={pendingFile.name}
                  >
                    {pendingFile.name}
                  </span>
                </div>

                <div
                  style={{
                    position: "relative",
                    width: 30,
                    height: 30,
                    flexShrink: 0,
                  }}
                >
                  {pendingFile.phase !== "error" ? (
                    <CircularUploadRing
                      progress={pendingFile.progress01}
                      size={30}
                      strokeWidth={2.5}
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                      }}
                    />
                  ) : null}
                  <button
                    type="button"
                    title="Remove attachment"
                    aria-label="Remove attachment"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={clearPendingFile}
                    style={{
                      position: "absolute",
                      left: "50%",
                      top: "50%",
                      transform: "translate(-50%, -50%)",
                      width: 22,
                      height: 22,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: 0,
                      border: "none",
                      borderRadius: "50%",
                      backgroundColor: palette.bgPrimary,
                      color: palette.textSecondary,
                      cursor: "pointer",
                      zIndex: 1,
                      boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = palette.textPrimary;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = palette.textSecondary;
                    }}
                  >
                    <X size={12} strokeWidth={2.5} />
                  </button>
                </div>
              </div>
              {pendingFile.phase === "error" && pendingFile.errorMessage ? (
                <div
                  style={{
                    fontSize: typography.fontSizeSmall * 0.95,
                    color: palette.textSecondary,
                  }}
                >
                  {pendingFile.errorMessage}
                </div>
              ) : null}
            </div>
          </div>
        )}
        {/* Top row: editor + toolbar buttons */}
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
        {/* File upload button (left of editor) */}
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: "none" }}
          onChange={handleFileSelected}
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
          disabled={!!pendingFile || !!draftDmPeerUserId || interactionLocked}
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
            cursor: pendingFile || draftDmPeerUserId || interactionLocked ? "default" : "pointer",
            opacity: pendingFile || draftDmPeerUserId || interactionLocked ? 0.35 : 1,
          }}
          onMouseEnter={(e) => {
            if (pendingFile || draftDmPeerUserId || interactionLocked) return;
            e.currentTarget.style.backgroundColor = palette.bgHover;
            e.currentTarget.style.color = palette.textPrimary;
          }}
          onMouseLeave={(e) => {
            if (pendingFile || draftDmPeerUserId || interactionLocked) return;
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
                fontSize: emojiOnlyComposer
                  ? typography.fontSizeBase * EMOJI_ONLY_DISPLAY_SCALE
                  : typography.fontSizeBase,
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
            onInput={handleEditorInput}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
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
                cursor: interactionLocked ? "default" : "pointer",
                opacity: interactionLocked ? 0.35 : 1,
              }}
              onMouseEnter={(e) => {
                if (interactionLocked) return;
                hoverToolBtn(e, pickerOpen, true);
              }}
              onMouseLeave={(e) => {
                if (interactionLocked) return;
                hoverToolBtn(e, pickerOpen, false);
              }}
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
          disabled={interactionLocked}
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
            cursor: interactionLocked ? "default" : "pointer",
            opacity: interactionLocked ? 0.35 : 1,
          }}
          onMouseEnter={(e) => {
            if (interactionLocked) return;
            hoverToolBtn(e, formatOpen, true);
          }}
          onMouseLeave={(e) => {
            if (interactionLocked) return;
            hoverToolBtn(e, formatOpen, false);
          }}
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

        {/* Inline format toolbar */}
        {formatOpen && (
          <>
            <div
              aria-hidden
              style={{
                height: 1,
                marginLeft: spacing.unit * 2,
                marginRight: spacing.unit * 2,
                backgroundColor: palette.borderSecondary ?? palette.border,
                opacity: palette.borderSecondary ? 1 : 0.25,
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
  colorScheme: ResolvedColorScheme;
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