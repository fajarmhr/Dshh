import { useMemo, useState } from "react";
import {
  Plus,
  Terminal,
  FolderTree,
  Server,
  Cable,
  Pencil,
  Trash2,
  Copy,
  ChevronDown,
  ChevronRight,
  Settings as SettingsIcon,
} from "lucide-react";
import { useStore } from "../store";
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
};

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

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-edge bg-bg-panel">
      <div className="drag-region flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded-full bg-accent" />
          <span className="text-sm font-semibold tracking-wide">Dshh</span>
        </div>
        <button
          onClick={onNew}
          title="New connection"
          className="no-drag rounded-md p-1.5 text-[#9aa7b6] transition hover:bg-bg-hover hover:text-white"
        >
          <Plus size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {connections.length === 0 && (
          <div className="mt-10 px-3 text-center text-xs leading-relaxed text-[#5f6b7a]">
            No connections yet.
            <br />
            Hit <span className="text-accent">+</span> to add SSH, SFTP, FTP or a
            serial port.
          </div>
        )}

        {names.map((g) => {
          const isCollapsed = collapsed.has(g);
          const items = map.get(g)!;
          return (
            <div key={g} className="mt-3">
              <button
                onClick={() => toggle(g)}
                className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-[10px] font-semibold uppercase tracking-widest text-[#5f6b7a] transition hover:text-[#9aa7b6]"
              >
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span className="truncate">{g}</span>
                <span className="ml-auto rounded bg-bg-elev px-1.5 text-[9px] text-[#5f6b7a]">
                  {items.length}
                </span>
              </button>

              {!isCollapsed &&
                items.map((c) => {
                  const Icon = ICONS[c.protocol];
                  return (
                    <div
                      key={c.id}
                      onDoubleClick={() => openSession(c.id, c.name)}
                      className="group flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition hover:bg-bg-hover"
                    >
                      <Icon size={15} color={PROTOCOL_COLORS[c.protocol]} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{c.name}</div>
                        <div className="truncate text-[11px] text-[#5f6b7a]">
                          {c.protocol === "serial"
                            ? `${c.serialPort} · ${c.baudRate} baud`
                            : `${c.username ? c.username + "@" : ""}${c.host}:${c.port}`}
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onEdit(c);
                          }}
                          className="rounded p-1 text-[#7c8896] hover:bg-bg-elev hover:text-white"
                          title="Edit"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            duplicateConnection(c.id);
                          }}
                          className="rounded p-1 text-[#7c8896] hover:bg-bg-elev hover:text-white"
                          title="Duplicate"
                        >
                          <Copy size={13} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Delete "${c.name}"?`)) removeConnection(c.id);
                          }}
                          className="rounded p-1 text-[#7c8896] hover:bg-bg-elev hover:text-red-400"
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
        <span className="text-[10px] text-[#5f6b7a]">In-process · no ssh.exe</span>
        <button
          onClick={onSettings}
          title="Settings"
          className="rounded-md p-1.5 text-[#9aa7b6] transition hover:bg-bg-hover hover:text-white"
        >
          <SettingsIcon size={15} />
        </button>
      </div>
    </aside>
  );
}
