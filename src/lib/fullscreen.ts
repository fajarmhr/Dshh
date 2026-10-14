import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Full screen for the whole workspace: the window covers the monitor and the
 * app chrome (sidebar, tab bar, bottom dock) steps aside, so the open session
 * — or both halves of a split — gets every pixel. Any session type, one
 * switch. Not persisted: every launch starts windowed.
 */
interface FullScreenState {
  on: boolean;
  /** The tab bar (and a VNC pane's controls) slid down from the top edge. */
  revealed: boolean;
}

export const useFullScreen = create<FullScreenState>(() => ({ on: false, revealed: false }));

let hideTimer = 0;
/** When full screen last changed; the resizes that follow are its own. */
let toggledAt = 0;

/**
 * Slide the chrome down, or back up. Going up waits a beat, so the pointer
 * can cross from the tab bar to a VNC pane's bar under it without both
 * vanishing in between.
 */
export function revealChrome(show: boolean, delay = 250) {
  window.clearTimeout(hideTimer);
  if (show) useFullScreen.setState({ revealed: true });
  else hideTimer = window.setTimeout(() => useFullScreen.setState({ revealed: false }), delay);
}

export function setFullScreen(on: boolean) {
  if (useFullScreen.getState().on === on) return;
  toggledAt = Date.now();
  getCurrentWindow()
    .setFullscreen(on)
    .catch(() => {});
  useFullScreen.setState({ on, revealed: false });
  // Show the way out for a moment on the way in.
  if (on) {
    revealChrome(true);
    revealChrome(false, 2500);
  }
}

export const toggleFullScreen = () => setFullScreen(!useFullScreen.getState().on);

/**
 * Ctrl+Alt+Enter toggles full screen from anywhere. It is caught on the way
 * down (capture phase), before a terminal or a remote screen can see it, and
 * the Enter's release is swallowed too so neither gets half a key press. The
 * window leaving full screen some other way is followed as well.
 */
export function installFullScreenKeys(): () => void {
  const swallowed = new Set<string>();
  const down = (e: KeyboardEvent) => {
    if (!(e.ctrlKey && e.altKey && e.key === "Enter")) return;
    e.preventDefault();
    e.stopPropagation();
    swallowed.add(e.code);
    if (!e.repeat) toggleFullScreen();
  };
  const up = (e: KeyboardEvent) => {
    if (!swallowed.delete(e.code)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const resized = () => {
    if (!useFullScreen.getState().on || Date.now() - toggledAt < 1500) return;
    getCurrentWindow()
      .isFullscreen()
      .then((fs) => !fs && useFullScreen.setState({ on: false, revealed: false }))
      .catch(() => {});
  };
  window.addEventListener("keydown", down, true);
  window.addEventListener("keyup", up, true);
  window.addEventListener("resize", resized);
  return () => {
    window.removeEventListener("keydown", down, true);
    window.removeEventListener("keyup", up, true);
    window.removeEventListener("resize", resized);
  };
}
