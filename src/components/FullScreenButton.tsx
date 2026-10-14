import { Fullscreen, Shrink } from "lucide-react";
import { toggleFullScreen, useFullScreen } from "../lib/fullscreen";

/** The tab bar's toggle for workspace full screen (also Ctrl+Alt+Enter). */
export function FullScreenButton() {
  const on = useFullScreen((s) => s.on);
  return (
    <button
      onClick={toggleFullScreen}
      className="tb-btn"
      title={on ? "Leave full screen (Ctrl+Alt+Enter)" : "Full screen (Ctrl+Alt+Enter)"}
    >
      {on ? <Shrink size={14} /> : <Fullscreen size={14} />}
    </button>
  );
}
