import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import { Room } from "../types/matrix";
import CreateSpaceDialog from "./CreateSpaceDialog";

interface SpaceSidebarProps {
  spaces: Room[];
  activeSpaceId: string | null;
  onSelectSpace: (spaceId: string) => void;
  onSpacesChanged: () => void;
}

function SpaceAvatar({ space, isActive }: { space: Room; isActive: boolean }) {
  const initials = space.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <button
      onClick={() => {}}
      title={space.name}
      style={{
        width: 48,
        height: 48,
        borderRadius: isActive ? 16 : 24,
        border: "none",
        cursor: "pointer",
        overflow: "hidden",
        padding: 0,
        transition: "border-radius 0.2s ease",
        outline: isActive ? "2px solid #5865f2" : "2px solid transparent",
        outlineOffset: 3,
        flexShrink: 0,
      }}
    >
      {space.avatarUrl ? (
        <img
          src={space.avatarUrl}
          alt={space.name}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            backgroundColor: "#5865f2",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          {initials}
        </div>
      )}
    </button>
  );
}

export default function SpaceSidebar({
  spaces,
  activeSpaceId,
  onSelectSpace,
  onSpacesChanged,
}: SpaceSidebarProps) {
  const { palette } = useTheme();
  const [showDialog, setShowDialog] = useState(false);
  const [canCreate, setCanCreate] = useState(true);
  const [addHovered, setAddHovered] = useState(false);
  const checkedRef = useRef(false);

  // Check room creation permission once on mount
  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    invoke<boolean>("can_create_rooms")
      .then(setCanCreate)
      .catch(() => setCanCreate(true)); // Optimistic fallback
  }, []);

  const handleOpenDialog = useCallback(() => {
    setShowDialog(true);
  }, []);

  const handleCloseDialog = useCallback(() => {
    setShowDialog(false);
  }, []);

  const handleCreated = useCallback(() => {
    onSpacesChanged();
  }, [onSpacesChanged]);

  return (
    <>
      <div
        style={{
          width: 72,
          minWidth: 72,
          flexShrink: 0,
          backgroundColor: palette.bgTertiary,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "12px 0",
          gap: 8,
          overflowY: "auto",
          height: "100vh",
        }}
      >
        {/* Home button */}
        <button
          onClick={() => onSelectSpace("")}
          title="Home"
          style={{
            width: 48,
            height: 48,
            borderRadius:
              activeSpaceId === "" || activeSpaceId === null ? 16 : 24,
            border: "none",
            backgroundColor: "#5865f2",
            color: "#fff",
            fontSize: 20,
            cursor: "pointer",
            transition: "border-radius 0.2s ease",
            outline:
              activeSpaceId === "" || activeSpaceId === null
                ? "2px solid #5865f2"
                : "2px solid transparent",
            outlineOffset: 3,
            flexShrink: 0,
          }}
        >
          P
        </button>

        {/* Divider */}
        <div
          style={{
            width: 32,
            height: 2,
            backgroundColor: "#35363c",
            borderRadius: 1,
            flexShrink: 0,
          }}
        />

        {/* Space avatars */}
        {spaces.map((space) => (
          <div key={space.id} onClick={() => onSelectSpace(space.id)}>
            <SpaceAvatar
              space={space}
              isActive={activeSpaceId === space.id}
            />
          </div>
        ))}

        {/* Spacer to push the add button to the bottom */}
        <div style={{ flex: 1 }} />

        {/* Divider before add button */}
        <div
          style={{
            width: 32,
            height: 2,
            backgroundColor: "#35363c",
            borderRadius: 1,
            flexShrink: 0,
          }}
        />

        {/* Add space button */}
        <button
          onClick={handleOpenDialog}
          onMouseEnter={() => setAddHovered(true)}
          onMouseLeave={() => setAddHovered(false)}
          title="Add a space"
          style={{
            width: 48,
            height: 48,
            borderRadius: addHovered ? 16 : 24,
            border: "none",
            backgroundColor: addHovered ? "#3ba55d" : palette.bgPrimary,
            color: addHovered ? "#fff" : "#3ba55d",
            cursor: "pointer",
            transition: "border-radius 0.2s ease, background-color 0.2s ease, color 0.2s ease",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
          }}
        >
          <Plus size={24} strokeWidth={2} />
        </button>
      </div>

      {/* Create/Join dialog */}
      {showDialog && (
        <CreateSpaceDialog
          canCreate={canCreate}
          onClose={handleCloseDialog}
          onCreated={handleCreated}
        />
      )}
    </>
  );
}