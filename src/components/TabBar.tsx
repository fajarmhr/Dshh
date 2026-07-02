import { X, Circle } from "lucide-react";
import { useStore } from "../store";
import { PROTOCOL_COLORS, PROTOCOL_LABELS } from "../lib/types";
import { cn } from "../lib/utils";

const STATUS_COLOR: Record<string, string> = {
  connecting: "#f0a54a",
  connected: "#37c6a4",
  error: "#ef5f6b",
  closed: "#5f6b7a",
};

export function TabBar() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  const setActive = useStore((s) => s.setActiveSession);
  const close = useStore((s) => s.closeSession);

  if (sessions.length === 0) return <div className="h-10 border-b border-edge" />;

  return (
    <div className="flex h-10 items-stretch gap-px overflow-x-auto border-b border-edge bg-bg-panel">
      {sessions.map((s) => (
        <div
          key={s.id}
          onClick={() => setActive(s.id)}
          className={cn(
            "group flex min-w-[160px] max-w-[220px] cursor-pointer items-center gap-2 border-r border-edge px-3 text-sm transition",
            s.id === activeId
              ? "bg-bg-base text-white"
              : "bg-bg-panel text-[#9aa7b6] hover:bg-bg-hover"
          )}
        >
          <Circle
            size={8}
            fill={STATUS_COLOR[s.status]}
            color={STATUS_COLOR[s.status]}
          />
          <span
            className="text-[10px] font-semibold uppercase"
            style={{ color: PROTOCOL_COLORS[s.protocol] }}
          >
            {PROTOCOL_LABELS[s.protocol]}
          </span>
          <span className="min-w-0 flex-1 truncate">{s.title}</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              close(s.id);
            }}
            className="rounded p-0.5 opacity-0 transition hover:bg-bg-elev group-hover:opacity-100"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
