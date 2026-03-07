import { useTheme } from "../theme/ThemeContext";
import { Room } from "../types/matrix";

interface SpaceSidebarProps {
  spaces: Room[];
  activeSpaceId: string | null;
  onSelectSpace: (spaceId: string) => void;
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
}: SpaceSidebarProps) {
  const { palette } = useTheme();

  return (
    <div
      style={{
        width: 72,
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
          borderRadius: activeSpaceId === "" || activeSpaceId === null ? 16 : 24,
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
    </div>
  );
}