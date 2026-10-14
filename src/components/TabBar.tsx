import {
  Cable,
  Columns2,
  FolderTree,
  HardDrive,
  Monitor,
  Server,
  SquareTerminal,
  Terminal,
  X,
} from "lucide-react";
import { useStore } from "../store";
import { PROTOCOL_COLORS, PROTOCOL_LABELS, type Protocol } from "../lib/types";
import { cn } from "../lib/utils";
import { FullScreenButton } from "./FullScreenButton";

/**
 * One icon per protocol, so a row of tabs is scannable without reading the
 * labels — the thing MobaXterm gets right and a text-only tab strip doesn't.
 */
const PROTOCOL_ICONS: Record<Protocol, typeof Terminal> = {
  ssh: Terminal,
  sftp: FolderTree,
  ftp: HardDrive,
  serial: Cable,
  local: SquareTerminal,
  telnet: Server,
  vnc: Monitor,
};

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
  const connections = useStore((s) => s.connections);

  if (sessions.length === 0)
    return <div className="h-9 shrink-0 border-b border-edge bg-bg-panel effect-surface" />;

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-edge bg-bg-panel effect-surface">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {sessions.map((s) => {
          const isActive = s.id === activeId;
          const isSplit = s.id === splitId;
          // The connection's accent, when it has one, replaces the generic blue
          // underline — so a tab on a host you marked "prod" reads as prod even
          // when the sidebar is scrolled away.
          const accent =
            connections.find((c) => c.id === s.connectionId)?.color ?? null;
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
                <div
                  className={cn("absolute inset-x-0 top-0 h-[2px]", !accent && "bg-accent")}
                  style={accent ? { backgroundColor: accent } : undefined}
                />
              )}
              {!isActive && accent && (
                <div
                  className="absolute inset-x-0 top-0 h-[2px] opacity-40"
                  style={{ backgroundColor: accent }}
                />
              )}
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  s.status === "connecting" && "animate-pulse"
                )}
                style={{ backgroundColor: STATUS_COLOR[s.status] }}
              />
              {(() => {
                const Icon = PROTOCOL_ICONS[s.protocol];
                return (
                  <Icon
                    size={12}
                    className="shrink-0"
                    style={{ color: PROTOCOL_COLORS[s.protocol] }}
                    aria-label={PROTOCOL_LABELS[s.protocol]}
                  />
                );
              })()}
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
      <div className="flex shrink-0 items-center border-l border-edge px-1">
        <FullScreenButton />
      </div>
    </div>
  );
}
