import { useEffect, useRef, useState } from "react";
import { ChevronDown, ShieldAlert, SquareTerminal } from "lucide-react";
import { useStore } from "../store";
import { localListShells, localOpenAdmin } from "../lib/api";
import type { LocalShell } from "../lib/types";

/**
 * Quick-launch menu for local shells (cmd / PowerShell / …). A normal pick
 * opens an embedded terminal tab; the "Administrator" entries elevate through
 * UAC and open in a separate window (an elevated shell can't share this app's
 * console). Shells are auto-detected by the backend; absent ones never appear.
 */
export function LocalLauncher() {
  const openLocalTerminal = useStore((s) => s.openLocalTerminal);
  const [shells, setShells] = useState<LocalShell[]>([]);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localListShells()
      .then(setShells)
      .catch(() => setShells([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const launch = (s: LocalShell) => {
    openLocalTerminal({ shell: s.id, label: s.label });
    setOpen(false);
  };
  const launchAdmin = (s: LocalShell) => {
    localOpenAdmin(s.id, null).catch(() => {});
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        title="Open a local terminal (cmd / PowerShell)"
        className="no-drag flex items-center gap-0.5 rounded-md px-1.5 py-1 text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi active:scale-[0.97]"
      >
        <SquareTerminal size={16} />
        <ChevronDown size={12} className="text-ink-dim" />
      </button>

      {open && (
        <div
          ref={menuRef}
          className="absolute right-0 top-full z-30 mt-1 w-60 animate-fade-up overflow-hidden rounded-lg border border-edge bg-bg-panel/97 py-1 shadow-[0_16px_40px_-10px_rgba(4,10,20,0.85)] backdrop-blur-sm"
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
        </div>
      )}
    </div>
  );
}
