import type { RefObject } from "react";
import type { RoomMember } from "../../../types/matrix";
import type {
  ResolvedColorScheme,
  ThemePalette,
  ThemeSpacing,
  ThemeTypography,
} from "../../../theme/types";

interface MentionAutocompleteMenuProps {
  open: boolean;
  candidates: RoomMember[];
  selectedIndex: number;
  menuRef: RefObject<HTMLDivElement | null>;
  palette: ThemePalette;
  typography: ThemeTypography;
  spacing: ThemeSpacing;
  resolvedColorScheme: ResolvedColorScheme;
  zIndex: number;
  onSelectIndex: (index: number) => void;
  onCompleteMention: (member: RoomMember) => void;
}

function localpartFromUserId(userId: string): string {
  return userId.startsWith("@") ? userId.slice(1).split(":")[0] : userId.split(":")[0];
}

export default function MentionAutocompleteMenu({
  open,
  candidates,
  selectedIndex,
  menuRef,
  palette,
  typography,
  spacing,
  resolvedColorScheme,
  zIndex,
  onSelectIndex,
  onCompleteMention,
}: MentionAutocompleteMenuProps) {
  if (!open || candidates.length === 0) return null;

  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label="Mention suggestions"
      style={{
        position: "absolute",
        bottom: "100%",
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
        zIndex,
      }}
    >
      {candidates.map((member, index) => {
        const localpart = localpartFromUserId(member.userId);
        const isSelected = index === selectedIndex;
        const mentionRowFadePx = spacing.unit * 4;
        const mentionRowMask = `linear-gradient(90deg, #000 0%, #000 calc(100% - ${mentionRowFadePx}px), transparent 100%)`;
        return (
          <div
            key={member.userId}
            role="option"
            aria-selected={isSelected}
            title={`${member.displayName ?? localpart} ${member.userId}`}
            onMouseDown={(e) => {
              e.preventDefault();
              onCompleteMention(member);
            }}
            onMouseEnter={() => onSelectIndex(index)}
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
                {member.displayName ?? localpart}
              </span>
              <span
                style={{
                  fontSize: typography.fontSizeSmall,
                  color: palette.textSecondary,
                  flexShrink: 0,
                }}
              >
                {member.userId}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
