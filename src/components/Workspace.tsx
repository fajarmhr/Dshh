import { useStore } from "../store";
import { TabBar } from "./TabBar";
import { TerminalView } from "./TerminalView";
import { FileBrowser } from "./FileBrowser";

export function Workspace() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  const connections = useStore((s) => s.connections);

  const active = sessions.find((s) => s.id === activeId) || null;

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-bg-base">
      <TabBar />
      <div className="relative min-h-0 flex-1">
        {sessions.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="text-5xl font-thin text-[#2a323d]">Dshh</div>
            <div className="max-w-sm text-sm text-[#5f6b7a]">
              Double-click a saved connection on the left to open a session, or
              create a new one with the <span className="text-accent">+</span>{" "}
              button.
            </div>
          </div>
        )}

        {/* Keep every session mounted so terminals/buffers survive tab switches */}
        {sessions.map((s) => {
          const conn = connections.find((c) => c.id === s.connectionId);
          if (!conn) return null;
          const visible = s.id === activeId;
          return (
            <div
              key={s.id}
              className="absolute inset-0"
              style={{ display: visible ? "block" : "none" }}
            >
              {s.protocol === "ssh" || s.protocol === "serial" ? (
                <TerminalView session={s} conn={conn} />
              ) : (
                <FileBrowser session={s} conn={conn} />
              )}
            </div>
          );
        })}

        {active?.error && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {active.error}
          </div>
        )}
      </div>
    </main>
  );
}
