import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  type RefObject,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { Picker } from "emoji-mart";
import data from "@emoji-mart/data";
import { hrefLooksLikeDirectImageUrl } from "../../../utils/directImageUrl";
import { insertImageAtSelection } from "../../../utils/composerEditorDom";
import type { ComposerPickerTab } from "./ComposerMediaPickerPopover";

type UseComposerPickerArgs = {
  editorRef: RefObject<HTMLDivElement | null>;
  rootRef: RefObject<HTMLDivElement | null>;
  interactionLockedRef: RefObject<boolean>;
  composerImgStyle: { borderRadius: number; maxWidth: string };
  refreshComposerDomState: () => void;
  syncHeight: () => void;
  resolvedColorScheme: string;
  spacingUnit: number;
};

export function useComposerPicker({
  editorRef,
  rootRef,
  interactionLockedRef,
  composerImgStyle,
  refreshComposerDomState,
  syncHeight,
  resolvedColorScheme,
  spacingUnit,
}: UseComposerPickerArgs) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<ComposerPickerTab>("emoji");
  const [popoverPos, setPopoverPos] = useState<{ bottom: number; right: number } | null>(null);
  const pickerAnchorRef = useRef<HTMLButtonElement>(null);
  const emojiPickerMountRef = useRef<HTMLDivElement>(null);
  const insertEmojiFromPickerRef = useRef<(native: string) => void>(() => {});
  const [giphyApiKey, setGiphyApiKey] = useState("");

  useEffect(() => {
    invoke<string>("get_giphy_api_key").then(setGiphyApiKey).catch(() => {});
  }, []);

  const handlePickerToggle = useCallback(() => {
    setPickerOpen((open) => !open);
  }, []);

  // ─── Picker positioning ───────────────────────────────────────────────────

  useLayoutEffect(() => {
    const margin = spacingUnit * 2;
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
  }, [pickerOpen, spacingUnit]);

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
  }, [pickerOpen, rootRef]);

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

  const handleGifSelect = useCallback(
    (gifUrl: string) => {
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
    },
    [editorRef, composerImgStyle, refreshComposerDomState, syncHeight],
  );

  return {
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
  };
}
