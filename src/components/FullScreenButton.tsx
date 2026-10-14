import { Fullscreen, Shrink } from "lucide-react";
import { toggleFullScreen, useFullScreen } from "../lib/fullscreen";

/** Toolbar toggle for workspace full screen (also Ctrl+Alt+Enter). */
export function FullScreenButton({
  className = "tb-btn",
  label = false,
}: {
  className?: string;
  /** Spell out "Exit" while in full screen, for toolbars with text buttons. */
  label?: boolean;
}) {
  const on = useFullScreen((s) => s.on);
  return (
    <button
      onClick={toggleFullScreen}
      className={className}
      title={on ? "Leave full screen (Ctrl+Alt+Enter)" : "Full screen (Ctrl+Alt+Enter)"}
    >
      {on ? <Shrink size={14} /> : <Fullscreen size={14} />}
      {label && on && "Exit"}
    </button>
  );
}
