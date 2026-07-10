import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Terminal,
  FolderTree,
  Server,
  Cable,
  Globe,
  SquareTerminal,
  Pencil,
  Trash2,
  Copy,
  ChevronDown,
  ChevronRight,
  Settings as SettingsIcon,
} from "lucide-react";
import { useStore } from "../store";
import { localOpenAdmin } from "../lib/api";
import { LocalLauncher } from "./LocalLauncher";
import {
  PROTOCOL_COLORS,
  UNGROUPED,
  type Connection,
  type Protocol,
} from "../lib/types";

const ICONS: Record<Protocol, React.ComponentType<{ size?: number; color?: string }>> = {
  ssh: Terminal,
  sftp: FolderTree,
  ftp: Server,
  serial: Cable,
  local: SquareTerminal,
  telnet: Globe,
};

const WIDTH_KEY = "dshh.sidebarWidth";
const MIN_WIDTH = 200;
const MAX_WIDTH = 460;
const DEFAULT_WIDTH = 256;

const clampWidth = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));

function connectionDetail(c: Connection): string {
  if (c.protocol === "serial") return `${c.serialPort} · ${c.baudRate} baud`;
  if (c.protocol === "local")
    return [c.shell ?? "shell", c.admin ? "admin" : null, c.cwd || null]
      .filter(Boolean)
      .join(" · ");
  return `${c.username ? c.username + "@" : ""}${c.host}:${c.port}`;
}

export function Sidebar({
  onNew,
  onEdit,
  onSettings,
}: {
  onNew: () => void;
  onEdit: (c: Connection) => void;
  onSettings: () => void;
}) {
  const connections = useStore((s) => s.connections);
  const openSession = useStore((s) => s.openSession);
  const removeConnection = useStore((s) => s.removeConnection);
  const duplicateConnection = useStore((s) => s.duplicateConnection);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return saved ? clampWidth(saved) : DEFAULT_WIDTH;
  });
  const [resizing, setResizing] = useState(false);

  // Drag-to-resize the panel. Width is derived from the pointer's x relative
  // to the panel's left edge, so it tracks the cursor exactly.
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const left = asideRef.current?.getBoundingClientRect().left ?? 0;
    setResizing(true);
    const onMove = (ev: PointerEvent) => setWidth(clampWidth(ev.clientX - left));
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);

  const { names, map } = useMemo(() => {
    const map = new Map<string, Connection[]>();
    for (const c of connections) {
      const g = c.group?.trim() || UNGROUPED;
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(c);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) =>
        a.protocol === b.protocol
          ? a.name.localeCompare(b.name)
          : a.protocol.localeCompare(b.protocol)
      );
    }
    const names = Array.from(map.keys()).sort((a, b) =>
      a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b)
    );
    return { names, map };
  }, [connections]);

  const toggle = (g: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(g) ? next.delete(g) : next.add(g);
      return next;
    });

  // An elevated saved terminal can't embed, so it opens in its own UAC window;
  // everything else opens as a normal tab.
  const activate = (c: Connection) => {
    if (c.protocol === "local" && c.admin) {
      localOpenAdmin(c.shell ?? "cmd", c.cwd ?? null).catch(() => {});
    } else {
      openSession(c.id, c.name);
    }
  };

  return (
    <aside
      ref={asideRef}
      style={{ width }}
      className={`relative flex shrink-0 flex-col border-r border-edge bg-bg-panel ${
        resizing ? "select-none" : ""
      }`}
    >
      <div className="drag-region flex items-center justify-between px-3 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md border border-accent/30 bg-accent/10 font-mono text-[11px] font-semibold leading-none text-accent">
            &gt;_
          </div>
          <span className="font-mono text-[13px] font-semibold tracking-[0.08em] text-ink-hi">
            dshh
          </span>
        </div>
        <div className="no-drag flex items-center gap-1">
          <LocalLauncher />
          <button onClick={onNew} title="New connection" className="tb-btn">
            <Plus size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {connections.length === 0 && (
          <div className="mx-1 mt-8 rounded-lg border border-dashed border-edge-bright px-4 py-6 font-mono text-[11px] leading-relaxed text-ink-dim">
            <div className="text-ink-mid">$ no connections</div>
            <div className="mt-2">
              hit <span className="text-accent">+</span> to add ssh, sftp, ftp or a
              serial port
            </div>
          </div>
        )}

        {names.map((g) => {
          const isCollapsed = collapsed.has(g);
          const items = map.get(g)!;
          return (
            <div key={g} className="mt-3">
              <button
                onClick={() => toggle(g)}
                className="micro-label flex w-full items-center gap-1 rounded px-1.5 py-1 transition hover:text-ink-mid"
              >
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span className="truncate">{g}</span>
                <span className="ml-auto rounded bg-bg-elev px-1.5 py-px font-mono text-[9px] text-ink-dim">
                  {items.length}
                </span>
              </button>

              {!isCollapsed &&
                items.map((c) => {
                  const Icon = ICONS[c.protocol];
                  const color = PROTOCOL_COLORS[c.protocol];
                  return (
                    <div
                      key={c.id}
                      onDoubleClick={() => activate(c)}
                      title={`${c.name}\n${connectionDetail(c)}\n\nDouble-click to open`}
                      className="group flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition hover:bg-bg-hover"
                    >
                      <div
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                        style={{ backgroundColor: `${color}14` }}
                      >
                        <Icon size={14} color={color} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] text-ink-hi">{c.name}</div>
                        <div className="truncate font-mono text-[10.5px] text-ink-dim">
                          {connectionDetail(c)}
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                        {c.protocol === "ssh" && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              openSession(c.id, c.name, "sftp");
                            }}
                            className="rounded p-1 text-ink-dim hover:bg-bg-elev hover:text-proto-sftp"
                            title="Browse files (SFTP)"
                          >
                            <FolderTree size={13} />
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onEdit(c);
                          }}
                          className="rounded p-1 text-ink-dim hover:bg-bg-elev hover:text-ink-hi"
                          title="Edit"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            duplicateConnection(c.id);
                          }}
                          className="rounded p-1 text-ink-dim hover:bg-bg-elev hover:text-ink-hi"
                          title="Duplicate"
                        >
                          <Copy size={13} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Delete "${c.name}"?`)) removeConnection(c.id);
                          }}
                          className="rounded p-1 text-ink-dim hover:bg-bg-elev hover:text-err"
                          title="Delete"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between border-t border-edge px-3 py-2">
        <span className="font-mono text-[9.5px] tracking-wide text-ink-dim">
          in-process · no ssh.exe
        </span>
        <button onClick={onSettings} title="Settings" className="tb-btn">
          <SettingsIcon size={15} />
        </button>
      </div>

      {/* Drag handle: sits over the right border, widens the hit area without
          shifting layout. Turns accent-colored while hovered or dragging. */}
      <div
        onPointerDown={startResize}
        onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        title="Drag to resize · double-click to reset"
        className="group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize"
      >
        <div
          className={`ml-auto h-full w-px transition-colors group-hover:bg-accent ${
            resizing ? "bg-accent" : "bg-transparent"
          }`}
        />
      </div>
    </aside>
  );
}
