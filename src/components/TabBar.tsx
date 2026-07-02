import { X, Columns2 } from "lucide-react";
import { useStore } from "../store";
import { PROTOCOL_COLORS, PROTOCOL_LABELS } from "../lib/types";
import { cn } from "../lib/utils";

const STATUS_COLOR: Record<string, string> = {
  connecting: "#e8a54c",
  connected: "#3ecf8e",
  error: "#f26d78",
  closed: "#5a6878",
};

export function TabBar() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  const splitId = useStore((s) => s.splitSessionId);
  const setActive = useStore((s) => s.setActiveSession);
  const toggleSplit = useStore((s) => s.toggleSplitSession);
  const close = useStore((s) => s.closeSession);

  if (sessions.length === 0)
    return <div className="h-9 shrink-0 border-b border-edge bg-bg-panel" />;

  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-edge bg-bg-panel">
      {sessions.map((s) => {
        const isActive = s.id === activeId;
        const isSplit = s.id === splitId;
        return (
          <div
            key={s.id}
            onClick={() => setActive(s.id)}
            className={cn(
              "group relative flex min-w-[150px] max-w-[220px] cursor-pointer items-center gap-2 border-r border-edge px-3 text-[12.5px] transition",
              isActive
                ? "bg-bg-base text-ink-hi"
                : "bg-bg-panel text-ink-mid hover:bg-bg-hover"
            )}
          >
            {isActive && (
              <div className="absolute inset-x-0 top-0 h-[2px] bg-accent" />
            )}
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                s.status === "connecting" && "animate-pulse"
              )}
              style={{ backgroundColor: STATUS_COLOR[s.status] }}
            />
            <span
              className="shrink-0 font-mono text-[9px] font-semibold tracking-wider"
              style={{ color: PROTOCOL_COLORS[s.protocol] }}
            >
              {PROTOCOL_LABELS[s.protocol]}
            </span>
            <span className="min-w-0 flex-1 truncate">{s.title}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleSplit(s.id);
              }}
              className={cn(
                "rounded p-0.5 transition hover:bg-bg-elev",
                isSplit
                  ? "text-accent"
                  : "text-ink-dim opacity-0 hover:text-ink-hi group-hover:opacity-100"
              )}
              title={isSplit ? "Close split" : "Open in split pane"}
            >
              <Columns2 size={12} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                close(s.id);
              }}
              className="rounded p-0.5 text-ink-dim opacity-0 transition hover:bg-bg-elev hover:text-ink-hi group-hover:opacity-100"
              title="Close session"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
