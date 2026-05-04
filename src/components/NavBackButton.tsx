import { useState } from "react";
import { ArrowLeft } from "lucide-react";

/** Header-level back button for mobile — round, large touch target, grey on press. */
function NavBackButton({
  onClick,
  palette,
}: {
  onClick: () => void;
  palette: { textSecondary: string; bgTertiary: string };
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      title="Open navigation"
      style={{
        background: pressed ? palette.bgTertiary : "none",
        border: "none",
        cursor: "pointer",
        width: 40,
        height: 40,
        padding: 0,
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: palette.textSecondary,
        WebkitTapHighlightColor: "transparent",
        transition: "background-color 0.12s",
      }}
    >
      <ArrowLeft size={22} />
    </button>
  );
}

export default NavBackButton;
