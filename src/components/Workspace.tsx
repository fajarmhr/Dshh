import { useEffect } from "react";
import { PanelRightClose } from "lucide-react";
import { useStore } from "../store";
import { revealChrome, setFullScreen, useFullScreen } from "../lib/fullscreen";
import { cn } from "../lib/utils";
import { TabBar } from "./TabBar";
import { TerminalView } from "./TerminalView";
import { FileBrowser } from "./FileBrowser";
import { VncView } from "./VncView";
import { BottomDock } from "./BottomDock";

export function Workspace() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  const splitId = useStore((s) => s.splitSessionId);
  const connections = useStore((s) => s.connections);
  const transientConnections = useStore((s) => s.transientConnections);
  const toggleSplit = useStore((s) => s.toggleSplitSession);
  const full = useFullScreen((s) => s.on);
  const revealed = useFullScreen((s) => s.revealed);

  // Nothing left to show full screen.
  useEffect(() => {
    if (full && sessions.length === 0) setFullScreen(false);
  }, [full, sessions.length]);

  const active = sessions.find((s) => s.id === activeId) || null;
  const split =
    splitId && splitId !== activeId && sessions.some((s) => s.id === splitId)
      ? splitId
      : null;

  return (
    <main className="relative flex min-w-0 flex-1 flex-col bg-bg-base effect-base">
      {!full && <TabBar />}
      <div className="relative min-h-0 flex-1">
        {sessions.length === 0 && (
          <div className="flex h-full items-center">
            <div className="animate-fade-up pl-[14%]">
              <div className="micro-label">dshh · multi-protocol client</div>
              <div className="mt-3 flex items-center font-mono text-2xl text-ink-hi">
                <span className="text-ink-dim">$&nbsp;</span>
                <span>connect</span>
                <span className="ml-1.5 inline-block h-[1.15em] w-[0.55em] animate-blink bg-accent" />
              </div>
              <div className="mt-6 space-y-1.5 font-mono text-[11.5px] leading-relaxed text-ink-dim">
                <div>
                  <span className="text-ink-mid">double-click</span> a saved host to
                  open a session
                </div>
                <div>
                  <span className="text-ink-mid">+</span> to add ssh · sftp · ftp ·
                  serial · vnc
                </div>
                <div>
                  <span className="text-ink-mid">ctrl+f</span> search buffer ·{" "}
                  <span className="text-ink-mid">ctrl+k</span> compose command
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Keep every session mounted so terminals/buffers survive tab switches.
            Panes are repositioned with CSS only — never reparented — so xterm
            instances stay intact in a split view. */}
        {sessions.map((s) => {
          const conn =
            connections.find((c) => c.id === s.connectionId) ??
            transientConnections.find((c) => c.id === s.connectionId);
          if (!conn) return null;
          const isActive = s.id === activeId;
          const isSplitPane = s.id === split;
          const visible = isActive || isSplitPane;
          const style: React.CSSProperties = !visible
            ? { display: "none" }
            : isSplitPane
              ? { top: 0, bottom: 0, left: "50%", right: 0 }
              : { top: 0, bottom: 0, left: 0, right: split ? "50%" : 0 };
          return (
            <div
              key={s.id}
              className={`absolute ${isSplitPane ? "border-l border-edge" : ""}`}
              style={style}
            >
              {s.protocol === "vnc" ? (
                <VncView session={s} conn={conn} />
              ) : s.protocol === "ssh" ||
                s.protocol === "serial" ||
                s.protocol === "local" ||
                s.protocol === "telnet" ? (
                <TerminalView session={s} conn={conn} />
              ) : (
                <FileBrowser session={s} conn={conn} />
              )}
              {isSplitPane && (
                <button
                  onClick={() => toggleSplit(s.id)}
                  className="absolute right-2 top-1.5 z-10 rounded-md border border-edge bg-bg-panel/90 p-1 text-ink-dim backdrop-blur-sm transition hover:text-ink-hi"
                  title="Close split pane"
                >
                  <PanelRightClose size={13} />
                </button>
              )}
            </div>
          );
        })}

        {active?.error && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 animate-fade-up rounded-md border border-err/40 bg-err/10 px-4 py-2 font-mono text-xs text-err">
            {active.error}
          </div>
        )}
      </div>
      <div className={full ? "hidden" : "contents"}>
        <BottomDock />
      </div>

      {full && (
        // Full screen: a thin strip along the top edge slides the tab bar
        // down over the panes, to switch sessions or leave full screen.
        <div
          className="absolute inset-x-0 top-0 z-40 h-1"
          onMouseEnter={() => revealChrome(true)}
          onMouseLeave={() => revealChrome(false)}
        >
          <div
            className={cn(
              "absolute inset-x-0 top-0 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.9)] transition-transform duration-150",
              revealed ? "translate-y-0" : "-translate-y-full"
            )}
          >
            <TabBar />
          </div>
        </div>
      )}
    </main>
  );
}
