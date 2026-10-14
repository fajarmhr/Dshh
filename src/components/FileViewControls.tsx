import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronRight,
  FolderSearch,
  Search,
  X,
} from "lucide-react";
import {
  DEFAULT_VIEW,
  DIR_LABELS,
  GROUP_LABELS,
  nextSort,
  sanitizeView,
  SORT_LABELS,
  type FileGroup,
  type FileViewPrefs,
  type GroupBy,
  type SortKey,
} from "../lib/fileView";

/**
 * Per-pane sort/group choice, remembered across sessions. Remote and local
 * panes keep separate choices — sorting a server by date says nothing about
 * how you like your Downloads folder.
 */
export function useFileViewPrefs(scope: "remote" | "local" | "peer") {
  const key = `dshh.fileview.${scope}.v1`;
  const [prefs, setPrefs] = useState<FileViewPrefs>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? sanitizeView(JSON.parse(raw)) : DEFAULT_VIEW;
    } catch {
      return DEFAULT_VIEW;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(prefs));
    } catch {
      /* storage full or unavailable: the choice just won't outlive the pane */
    }
  }, [key, prefs]);
  const update = (patch: Partial<FileViewPrefs>) => setPrefs((p) => ({ ...p, ...patch }));
  return [prefs, update] as const;
}

/**
 * Filter box for a pane's toolbar. Typing filters what's listed; `onSubmit`
 * (Enter) is optional — the remote pane uses it to search subfolders too.
 */
export function SearchBox({
  value,
  onChange,
  onSubmit,
  placeholder = "Filter",
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  title?: string;
}) {
  return (
    <div
      className="flex h-6 w-40 min-w-[4.5rem] shrink items-center gap-1.5 rounded-md border border-edge bg-bg-inset px-2 text-ink-mid focus-within:border-accent"
      title={title}
    >
      <Search size={11} className="shrink-0 text-ink-dim" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit?.();
          else if (e.key === "Escape") {
            onChange("");
            e.currentTarget.blur();
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-ink-hi outline-none placeholder:text-ink-dim"
      />
      {value && onSubmit && (
        <button
          onClick={onSubmit}
          className="shrink-0 rounded text-ink-dim transition hover:text-accent"
          title="Search subfolders too (Enter)"
        >
          <FolderSearch size={12} />
        </button>
      )}
      {value && (
        <button
          onClick={() => onChange("")}
          className="shrink-0 rounded text-ink-dim transition hover:text-ink-hi"
          title="Clear (Esc)"
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}

function MenuItem({
  checked,
  onClick,
  children,
}: {
  checked: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      role="menuitemradio"
      aria-checked={checked}
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition hover:bg-bg-hover ${
        checked ? "text-ink-hi" : "text-ink-mid"
      }`}
    >
      <Check size={12} className={`shrink-0 text-accent ${checked ? "" : "invisible"}`} />
      {children}
    </button>
  );
}

/**
 * Sort & group menu. It stays open across picks, so sort, direction and
 * grouping can be set in one visit; outside click or Esc closes it.
 */
export function ViewMenu({
  prefs,
  onChange,
}: {
  prefs: FileViewPrefs;
  onChange: (patch: Partial<FileViewPrefs>) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  const customised =
    prefs.sortKey !== DEFAULT_VIEW.sortKey ||
    prefs.sortDir !== DEFAULT_VIEW.sortDir ||
    prefs.groupBy !== DEFAULT_VIEW.groupBy ||
    prefs.foldersFirst !== DEFAULT_VIEW.foldersFirst;

  return (
    <div className="relative shrink-0">
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        className={`tb-btn ${customised || open ? "text-accent" : ""}`}
        title={`Sort & group — ${SORT_LABELS[prefs.sortKey]}, ${DIR_LABELS[prefs.sortKey][prefs.sortDir]}${
          prefs.groupBy === "none" ? "" : `, grouped by ${GROUP_LABELS[prefs.groupBy].toLowerCase()}`
        }`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <ArrowUpDown size={15} />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-52 animate-fade-up overflow-hidden rounded-lg border border-edge bg-bg-panel/95 py-1 shadow-[0_16px_40px_-10px_rgba(4,10,20,0.85)] backdrop-blur-sm"
        >
          <div className="micro-label px-3 py-1">Sort by</div>
          {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
            <MenuItem
              key={k}
              checked={prefs.sortKey === k}
              onClick={() => prefs.sortKey !== k && onChange(nextSort(prefs, k))}
            >
              {SORT_LABELS[k]}
            </MenuItem>
          ))}
          <div className="my-1 h-px bg-edge" />
          {(["asc", "desc"] as const).map((d) => (
            <MenuItem key={d} checked={prefs.sortDir === d} onClick={() => onChange({ sortDir: d })}>
              {DIR_LABELS[prefs.sortKey][d]}
            </MenuItem>
          ))}
          <div className="my-1 h-px bg-edge" />
          <div className="micro-label px-3 py-1">Group by</div>
          {(Object.keys(GROUP_LABELS) as GroupBy[]).map((g) => (
            <MenuItem key={g} checked={prefs.groupBy === g} onClick={() => onChange({ groupBy: g })}>
              {GROUP_LABELS[g]}
            </MenuItem>
          ))}
          <div className="my-1 h-px bg-edge" />
          <button
            role="menuitemcheckbox"
            aria-checked={prefs.foldersFirst}
            onClick={() => onChange({ foldersFirst: !prefs.foldersFirst })}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi"
          >
            <Check
              size={12}
              className={`shrink-0 text-accent ${prefs.foldersFirst ? "" : "invisible"}`}
            />
            Folders first
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Column header that sorts by `sortKey` on click and shows the direction when
 * active. `alias` is a key with no column of its own that this one stands in
 * for — type sorting shows on the name column, and clicking there flips it.
 */
export function SortTh({
  label,
  sortKey,
  alias,
  prefs,
  onChange,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  alias?: SortKey;
  prefs: FileViewPrefs;
  onChange: (patch: Partial<FileViewPrefs>) => void;
  align?: "left" | "right";
}) {
  const current = alias && prefs.sortKey === alias ? alias : sortKey;
  const active = prefs.sortKey === current;
  const Arrow = prefs.sortDir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}
      aria-sort={active ? (prefs.sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        onClick={() => onChange(nextSort(prefs, current))}
        className={`inline-flex items-center gap-1 uppercase tracking-[0.14em] transition hover:text-ink-hi ${
          align === "right" ? "flex-row-reverse" : ""
        } ${active ? "text-ink-mid" : ""}`}
        title={`Sort by ${SORT_LABELS[current].toLowerCase()}`}
      >
        {label}
        <Arrow size={10} className={active ? "text-accent" : "invisible"} />
      </button>
    </th>
  );
}

/** Collapsible header row above a group's files. */
export function GroupRow({
  group,
  collapsed,
  onToggle,
  colSpan,
}: {
  group: FileGroup;
  collapsed: boolean;
  onToggle: () => void;
  colSpan: number;
}) {
  return (
    <tr
      onClick={onToggle}
      className="cursor-pointer border-b border-edge/60 bg-bg-panel/50 transition hover:bg-bg-hover"
    >
      <td colSpan={colSpan} className="px-3 py-1">
        <div className="micro-label flex items-center gap-1.5">
          <ChevronRight
            size={11}
            className={`shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
          />
          <span className="text-ink-mid">{group.label}</span>
          <span>{group.files.length}</span>
        </div>
      </td>
    </tr>
  );
}

/** Which groups are folded. Keys carry the grouping, so switching group-by starts all open. */
export function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return [collapsed, toggle] as const;
}
