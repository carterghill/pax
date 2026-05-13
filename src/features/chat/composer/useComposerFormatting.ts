import { useState, useEffect, useCallback, type RefObject } from "react";
import {
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
} from "lucide-react";
import {
  getActiveFormats,
  toggleInlineCode,
  toggleCodeBlock,
  toggleLink,
} from "../../../utils/composerEditorDom";
import type { ComposerFormatItem } from "./ComposerFormattingToolbar";

type UseComposerFormattingArgs = {
  editorRef: RefObject<HTMLDivElement | null>;
};

export function useComposerFormatting({ editorRef }: UseComposerFormattingArgs) {
  const [formatOpen, setFormatOpen] = useState(false);
  const [activeFormats, setActiveFormats] = useState<Set<string>>(new Set());

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
  }, [editorRef]);

  const refreshFormats = useCallback(() => {
    const el = editorRef.current;
    if (el) setActiveFormats(getActiveFormats(el));
  }, [editorRef]);

  const execFormat = useCallback((cmd: string) => {
    editorRef.current?.focus();
    document.execCommand(cmd);
    refreshFormats();
  }, [editorRef, refreshFormats]);

  const toggleFormatBlock = useCallback((tag: string, key: string) => {
    editorRef.current?.focus();
    document.execCommand("formatBlock", false, activeFormats.has(key) ? "div" : tag);
    refreshFormats();
  }, [editorRef, activeFormats, refreshFormats]);

  const formatGroups: ComposerFormatItem[][] = [
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

  return {
    formatOpen,
    setFormatOpen,
    activeFormats,
    refreshFormats,
    formatGroups,
  };
}
