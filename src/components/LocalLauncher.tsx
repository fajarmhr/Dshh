import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ShieldAlert, SquareTerminal } from "lucide-react";
import { useStore } from "../store";
import { localListShells, localOpenAdmin } from "../lib/api";
import type { LocalShell } from "../lib/types";

const MENU_WIDTH = 240;
/** Gap kept between the menu and the window edges. */
const EDGE = 8;

/**
 * Quick-launch menu for local shells (cmd / PowerShell / …). A normal pick
 * opens an embedded terminal tab; the "Administrator" entries elevate through
 * UAC and open in a separate window (an elevated shell can't share this app's
 * console). Shells are auto-detected by the backend; absent ones never appear.
 */
export function LocalLauncher() {
  const openLocalTerminal = useStore((s) => s.openLocalTerminal);
  const [shells, setShells] = useState<LocalShell[]>([]);
  /** Where the open menu sits on screen; `null` while closed. */
  const [at, setAt] = useState<CSSProperties | null>(null);
  const open = at !== null;
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localListShells()
      .then(setShells)
      .catch(() => setShells([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = () => setAt(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  // Hung off the button's right edge, the menu ran out of the window whenever
  // the sidebar was narrower than it, so it is portalled out and pinned on
  // screen: right-aligned to the button where that fits, pushed in where not.
  const toggle = () => {
    if (open) return setAt(null);
    const r = btnRef.current!.getBoundingClientRect();
    const maxLeft = window.innerWidth - MENU_WIDTH - EDGE;
    const left = Math.max(EDGE, Math.min(r.right - MENU_WIDTH, maxLeft));
    const top = r.bottom + 4;
    setAt({ left, top, width: MENU_WIDTH, maxHeight: window.innerHeight - top - EDGE });
  };

  const launch = (s: LocalShell) => {
    openLocalTerminal({ shell: s.id, label: s.label });
    setAt(null);
  };
  const launchAdmin = (s: LocalShell) => {
    localOpenAdmin(s.id, null).catch(() => {});
    setAt(null);
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={toggle}
        title="Open a local terminal (cmd / PowerShell)"
        className="no-drag flex items-center gap-0.5 rounded-md px-1.5 py-1 text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi active:scale-[0.97]"
      >
        <SquareTerminal size={16} />
        <ChevronDown size={12} className="text-ink-dim" />
      </button>

      {at &&
        createPortal(
          <div
            ref={menuRef}
            style={at}
            className="fixed z-[60] animate-fade-up overflow-y-auto rounded-lg border border-edge bg-bg-panel/95 py-1 shadow-[0_16px_40px_-10px_rgba(4,10,20,0.85)] backdrop-blur-sm"
          >
            <div className="micro-label px-3 py-1">Local terminal</div>
            {shells.length === 0 ? (
              <div className="px-3 py-2 font-mono text-[11px] text-ink-dim">
                no shells detected
              </div>
            ) : (
              shells.map((s) => (
                <button
                  key={s.id}
                  onClick={() => launch(s)}
                  className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] text-ink-hi transition hover:bg-bg-hover"
                >
                  <SquareTerminal size={13} className="shrink-0 text-proto-local" />
                  {s.label}
                </button>
              ))
            )}

            {shells.length > 0 && (
              <>
                <div className="my-1 h-px bg-edge" />
                <div className="micro-label px-3 py-1">Administrator (new window)</div>
                {shells.map((s) => (
                  <button
                    key={`admin-${s.id}`}
                    onClick={() => launchAdmin(s)}
                    className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi"
                  >
                    <ShieldAlert size={13} className="shrink-0 text-warn" />
                    {s.label}
                  </button>
                ))}
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
