import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import type { RoomMember } from "../../../types/matrix";
import type { ThemePalette, ThemeTypography } from "../../../theme/types";
import { useRoomMembers } from "../../../hooks/useRoomMembers";
import { useResolveMemberLabel } from "../../../hooks/useResolveMemberLabel";
import {
  createComposerMentionSpan,
  replaceBareMxidsWithPillsInComposer,
  type ComposerMentionPillStyle,
} from "../../../utils/composerEditorDom";
import { localpartFromUserId } from "../../../utils/matrix";

type UseComposerMentionsArgs = {
  roomId: string;
  selfUserId: string;
  editorRef: RefObject<HTMLDivElement | null>;
  palette: ThemePalette;
  typography: ThemeTypography;
  refreshComposerDomState: () => void;
};

export function useComposerMentions({
  roomId,
  selfUserId,
  editorRef,
  palette,
  typography,
  refreshComposerDomState,
}: UseComposerMentionsArgs) {
  const { members: roomMembers } = useRoomMembers(roomId);
  const { resolveMemberLabel } = useResolveMemberLabel(roomId);

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
  const mentionInsertingRef = useRef(false);
  const mentionMenuRef = useRef<HTMLDivElement>(null);

  const mentionCandidates = useMemo(() => {
    if (!mentionMenuOpen || !mentionQuery) return [];
    const q = mentionQuery.toLowerCase();
    return roomMembers
      .filter((m) => {
        if (m.userId === selfUserId) return false;
        const localpart = localpartFromUserId(m.userId);
        const dn = (m.displayName ?? "").toLowerCase();
        return localpart.toLowerCase().includes(q) || dn.includes(q);
      })
      .slice(0, 8);
  }, [mentionMenuOpen, mentionQuery, roomMembers, selfUserId]);

  useEffect(() => {
    setMentionIndex((prev) => Math.min(prev, Math.max(0, mentionCandidates.length - 1)));
  }, [mentionCandidates.length]);

  useEffect(() => {
    if (mentionMenuOpen && mentionCandidates.length === 0 && mentionQuery.length > 0) {
      setMentionMenuOpen(false);
    }
  }, [mentionMenuOpen, mentionCandidates.length, mentionQuery]);

  useEffect(() => {
    if (!mentionMenuOpen || !mentionMenuRef.current) return;
    const items = mentionMenuRef.current.querySelectorAll("[role='option']");
    items[mentionIndex]?.scrollIntoView({ block: "nearest" });
  }, [mentionIndex, mentionMenuOpen]);

  const getMentionContext = useCallback((): string | null => {
    const el = editorRef.current;
    if (!el) return null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;

    const range = sel.getRangeAt(0);
    const preRange = document.createRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.startContainer, range.startOffset);
    const textBefore = preRange.toString().replace(/\u200b/g, "");
    const lastAt = textBefore.lastIndexOf("@");
    if (lastAt === -1) return null;

    if (lastAt > 0) {
      const charBefore = textBefore[lastAt - 1];
      if (!/[\s\n]/.test(charBefore)) return null;
    }

    const query = textBefore.slice(lastAt + 1);
    const queryWithoutTerminator = /[\s:]$/.test(query) ? query.slice(0, -1) : query;
    if (/[\s\n]/.test(queryWithoutTerminator)) return null;
    return query;
  }, [editorRef]);

  const findExactMemberMatch = useCallback(
    (query: string): RoomMember | null => {
      const q = query.toLowerCase();
      for (const m of roomMembers) {
        if (m.userId === selfUserId) continue;
        const localpart = localpartFromUserId(m.userId);
        if (localpart.toLowerCase() === q) return m;
        if (m.displayName && m.displayName.toLowerCase() === q) return m;
      }
      return null;
    },
    [roomMembers, selfUserId],
  );

  const completeMention = useCallback(
    (member: RoomMember) => {
      const el = editorRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const range = sel.getRangeAt(0);
      const preRange = document.createRange();
      preRange.selectNodeContents(el);
      preRange.setEnd(range.startContainer, range.startOffset);
      const textBefore = preRange.toString().replace(/\u200b/g, "");
      const lastAt = textBefore.lastIndexOf("@");
      if (lastAt === -1) return;

      let charCount = 0;
      let startNode: Node | null = null;
      let startOffset = 0;

      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const tn = walker.currentNode;
        const len = (tn.textContent ?? "").replace(/\u200b/g, "").length;
        if (charCount + len > lastAt) {
          startNode = tn;
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

      const replaceRange = document.createRange();
      replaceRange.setStart(startNode, startOffset);
      replaceRange.setEnd(range.startContainer, range.startOffset);
      sel.removeAllRanges();
      sel.addRange(replaceRange);

      mentionInsertingRef.current = true;
      try {
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
      } finally {
        mentionInsertingRef.current = false;
      }

      setMentionMenuOpen(false);
      setMentionQuery("");
      setMentionIndex(0);
      refreshComposerDomState();
    },
    [
      editorRef,
      getComposerMentionVisibleLabel,
      makeComposerMentionSpan,
      refreshComposerDomState,
    ],
  );

  const handleComposerInputMentions = useCallback(() => {
    const el = editorRef.current;
    if (!el || mentionInsertingRef.current) return;

    replaceBareMxidsWithPillsInComposer(
      el,
      getComposerMentionVisibleLabel,
      makeComposerMentionSpan,
    );

    const ctx = getMentionContext();
    if (ctx !== null && ctx.length > 0) {
      const lastChar = ctx[ctx.length - 1];
      if (lastChar === " " || lastChar === ":") {
        const queryWithout = ctx.slice(0, -1);
        const match = findExactMemberMatch(queryWithout);
        if (match) {
          requestAnimationFrame(() => {
            const recheck = getMentionContext();
            if (recheck === null) return;
            const recheckClean = recheck.replace(/[\s:]$/, "");
            const m2 = findExactMemberMatch(recheckClean);
            if (m2) completeMention(m2);
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
      return;
    }

    setMentionMenuOpen(false);
    setMentionQuery("");
  }, [
    completeMention,
    editorRef,
    findExactMemberMatch,
    getComposerMentionVisibleLabel,
    getMentionContext,
    makeComposerMentionSpan,
  ]);

  const handleMentionKeyDown = useCallback(
    (e: ReactKeyboardEvent): boolean => {
      if (!mentionMenuOpen || mentionCandidates.length === 0) return false;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, mentionCandidates.length - 1));
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const selected = mentionCandidates[mentionIndex];
        if (selected) completeMention(selected);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionMenuOpen(false);
        return true;
      }

      return false;
    },
    [completeMention, mentionCandidates, mentionIndex, mentionMenuOpen],
  );

  return {
    mentionMenuProps: {
      open: mentionMenuOpen,
      candidates: mentionCandidates,
      selectedIndex: mentionIndex,
      menuRef: mentionMenuRef,
      onSelectIndex: setMentionIndex,
      onCompleteMention: completeMention,
    },
    getComposerMentionVisibleLabel,
    makeComposerMentionSpan,
    handleComposerInputMentions,
    handleMentionKeyDown,
  };
}
