import { PanelRightClose } from "lucide-react";
import { useStore } from "../store";
import { TabBar } from "./TabBar";
import { TerminalView } from "./TerminalView";
import { FileBrowser } from "./FileBrowser";
import { BottomDock } from "./BottomDock";

export function Workspace() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  const splitId = useStore((s) => s.splitSessionId);
  const connections = useStore((s) => s.connections);
  const toggleSplit = useStore((s) => s.toggleSplitSession);

  const active = sessions.find((s) => s.id === activeId) || null;
  const split =
    splitId && splitId !== activeId && sessions.some((s) => s.id === splitId)
      ? splitId
      : null;

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-bg-base">
      <TabBar />
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
                  serial
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
          const conn = connections.find((c) => c.id === s.connectionId);
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
              {s.protocol === "ssh" || s.protocol === "serial" ? (
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
      <BottomDock />
    </main>
  );
}
