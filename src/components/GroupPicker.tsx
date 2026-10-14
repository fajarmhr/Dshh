import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Folder, FolderMinus, FolderPlus, Search } from "lucide-react";
import { useStore } from "../store";
import { cn } from "../lib/utils";

const MENU_WIDTH = 260;
/** Gap kept between the menu and the window edges. */
const EDGE = 8;

/** The groups saved connections use, A–Z, with how many each holds. */
export function useGroups() {
  const connections = useStore((s) => s.connections);
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of connections) {
      const g = c.group?.trim();
      if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [connections]);
}

type Row =
  | { kind: "create"; name: string }
  | { kind: "none" }
  | { kind: "group"; name: string; count: number };

/**
 * Choose a group from the ones that exist, or start a new one by typing its
 * name — no need to remember how a group was spelled. Opens against
 * `anchor`, below it where there's room and above where there isn't.
 * ↑/↓ move, Enter picks, Esc closes.
 */
export function GroupMenu({
  anchor,
  value,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  value?: string;
  onPick: (group: string | undefined) => void;
  onClose: () => void;
}) {
  const groups = useGroups();
  const menuRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const current = value?.trim() || undefined;

  const q = query.trim();
  const lower = q.toLowerCase();
  const rows: Row[] = [
    ...(q && !groups.some((g) => g.name.toLowerCase() === lower)
      ? [{ kind: "create" as const, name: q }]
      : []),
    ...(q ? [] : [{ kind: "none" as const }]),
    ...groups
      .filter((g) => g.name.toLowerCase().includes(lower))
      .map((g) => ({ kind: "group" as const, ...g })),
  ];

  const [pos] = useState<CSSProperties>(() => {
    const r = anchor.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - MENU_WIDTH - EDGE));
    const below = window.innerHeight - r.bottom - EDGE;
    return below >= 240
      ? { left, top: r.bottom + 4, maxHeight: below - 4 }
      : { left, bottom: window.innerHeight - r.top + 4, maxHeight: r.top - EDGE - 4 };
  });

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  const pick = (row: Row) => onPick(row.kind === "none" ? undefined : row.name);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setHi((h) => Math.min(h + 1, rows.length - 1));
    else if (e.key === "ArrowUp") setHi((h) => Math.max(h - 1, 0));
    else if (e.key === "Enter" && rows[hi]) pick(rows[hi]);
    else if (e.key === "Escape") onClose();
    else return;
    // Handled: keep it from moving the caret, submitting, or closing a dialog underneath.
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <div
      ref={menuRef}
      style={{ ...pos, width: MENU_WIDTH }}
      className="fixed z-[60] flex animate-fade-up flex-col overflow-hidden rounded-lg border border-edge bg-bg-panel/95 shadow-[0_16px_40px_-10px_rgba(4,10,20,0.85)] backdrop-blur-sm"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
        <Search size={12} className="shrink-0 text-ink-dim" />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHi(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={groups.length ? "Find or create a group" : "Name a new group"}
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink-hi outline-none placeholder:text-ink-dim"
        />
      </div>
      <div className="min-h-0 overflow-y-auto py-1">
        {rows.map((row, i) => (
          <button
            key={row.kind === "none" ? "\0none" : `${row.kind}:${row.name}`}
            onClick={() => pick(row)}
            onMouseEnter={() => setHi(i)}
            className={cn(
              "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] transition",
              i === hi ? "bg-bg-hover text-ink-hi" : "text-ink-mid"
            )}
          >
            {row.kind === "create" ? (
              <>
                <FolderPlus size={13} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate">
                  Create <span className="text-ink-hi">&ldquo;{row.name}&rdquo;</span>
                </span>
              </>
            ) : row.kind === "none" ? (
              <>
                <FolderMinus size={13} className="shrink-0 text-ink-dim" />
                <span className="min-w-0 flex-1 truncate">No group</span>
                {!current && <Check size={13} className="shrink-0 text-accent" />}
              </>
            ) : (
              <>
                <Folder size={13} className="shrink-0 text-ink-dim" />
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                {current === row.name ? (
                  <Check size={13} className="shrink-0 text-accent" />
                ) : (
                  <span className="shrink-0 rounded bg-bg-elev px-1.5 py-px font-mono text-[9px] text-ink-dim">
                    {row.count}
                  </span>
                )}
              </>
            )}
          </button>
        ))}
        {rows.length === 0 && (
          <div className="px-3 py-2 font-mono text-[11px] text-ink-dim">no groups yet</div>
        )}
      </div>
    </div>,
    document.body
  );
}

/** The Group field of the connection form: shows the group, opens the picker. */
export function GroupField({
  value,
  onChange,
}: {
  value?: string;
  onChange: (group: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="field-input flex items-center gap-2 text-left"
        title="Choose a group, or create one"
      >
        <Folder size={13} className="shrink-0 text-ink-dim" />
        <span className={cn("min-w-0 flex-1 truncate", !value?.trim() && "text-ink-dim")}>
          {value?.trim() || "No group"}
        </span>
        <ChevronDown size={13} className="shrink-0 text-ink-dim" />
      </button>
      {open && btnRef.current && (
        <GroupMenu
          anchor={btnRef.current}
          value={value}
          onPick={(g) => {
            onChange(g);
            setOpen(false);
          }}
          onClose={close}
        />
      )}
    </>
  );
}
