import { useEffect, useState } from "react";
import { File, Folder, Lock, RefreshCw, Trash2, UserCog, X } from "lucide-react";
import type { FileTree } from "../lib/api";
import type { RemoteFile } from "../lib/types";
import { formatBytes, overlayDismiss } from "../lib/utils";

/** `0o2755` → `rwxr-sr-x`, the way `ls -l` prints it. */
export function formatMode(mode: number): string {
  const bit = (b: number, c: string) => (mode & b ? c : "-");
  // The execute slot also shows setuid/setgid/sticky: lowercase when the
  // execute bit is set too, uppercase when it isn't.
  const xslot = (x: number, special: number, letter: string) =>
    mode & special ? (mode & x ? letter : letter.toUpperCase()) : bit(x, "x");
  return (
    bit(0o400, "r") +
    bit(0o200, "w") +
    xslot(0o100, 0o4000, "s") +
    bit(0o40, "r") +
    bit(0o20, "w") +
    xslot(0o10, 0o2000, "s") +
    bit(0o4, "r") +
    bit(0o2, "w") +
    xslot(0o1, 0o1000, "t")
  );
}

/** Up to `max` names from a selection, for a dialog to list. */
function Preview({ items, max = 6 }: { items: RemoteFile[]; max?: number }) {
  return (
    <div className="max-h-40 overflow-y-auto rounded-lg border border-edge bg-bg-inset/60 px-3 py-2">
      {items.slice(0, max).map((f) => (
        <div key={f.path} className="flex items-center gap-2 py-0.5 font-mono text-[11.5px]">
          {f.isDir ? (
            <Folder size={12} className="shrink-0 text-warn" />
          ) : (
            <File size={12} className="shrink-0 text-ink-dim" />
          )}
          <span className="truncate text-ink-hi" title={f.path}>
            {f.name}
          </span>
        </div>
      ))}
      {items.length > max && (
        <div className="pt-0.5 font-mono text-[11px] text-ink-dim">
          and {items.length - max} more
        </div>
      )}
    </div>
  );
}

function Shell({
  icon,
  title,
  tone = "text-ink-hi",
  onClose,
  children,
  footer,
}: {
  icon: React.ReactNode;
  title: string;
  tone?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay" {...overlayDismiss(onClose)}>
      <div className="modal-shell w-[440px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <div className={`flex items-center gap-2 ${tone}`}>
            {icon}
            <h2 className="text-sm font-semibold text-ink-hi">{title}</h2>
          </div>
          <button onClick={onClose} className="tb-btn">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-3 px-5 py-4">{children}</div>
        <div className="flex justify-end gap-2 border-t border-edge px-5 py-3">{footer}</div>
      </div>
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The warning before a delete. Folders go with everything inside them, so the
 * count of what is actually under the selection is worked out first and the
 * button only arms once the user can see it.
 */
export function DeleteConfirm({
  items,
  tree,
  error,
  busy,
  onConfirm,
  onCancel,
}: {
  items: RemoteFile[];
  /** What the selection holds; null while it is still being counted. */
  tree: FileTree | null;
  /** Counting failed; deleting would fail the same way. */
  error: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const files = tree?.entries.filter((e) => !e.isDir) ?? [];
  const dirs = tree ? tree.entries.length - files.length : 0;
  const bytes = files.reduce((n, e) => n + e.size, 0);
  const hasDirs = items.some((f) => f.isDir);

  return (
    <Shell
      icon={<Trash2 size={15} />}
      tone="text-err"
      title={`Delete ${plural(items.length, "item")}?`}
      onClose={onCancel}
      footer={
        <>
          <button onClick={onCancel} className="btn-ghost" disabled={busy}>
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!tree || !!error || busy}
            className="rounded-md bg-err px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-err/85 active:scale-[0.97] disabled:opacity-40"
          >
            {busy ? "Deleting…" : "Delete permanently"}
          </button>
        </>
      }
    >
      <Preview items={items} />
      {error ? (
        <div className="rounded-lg border border-err/40 bg-err/10 px-3 py-2 font-mono text-[11px] text-err">
          {error}
        </div>
      ) : !tree ? (
        <div className="flex items-center gap-2 font-mono text-[11px] text-ink-dim">
          <RefreshCw size={12} className="animate-spin" />
          counting what's inside…
        </div>
      ) : (
        <div className="rounded-lg border border-err/30 bg-err/[0.07] px-3 py-2 text-[12.5px] leading-relaxed text-ink-hi">
          {plural(files.length, "file")}
          {hasDirs ? ` and ${plural(dirs, "folder")}` : ""} ({formatBytes(bytes)}) will be
          deleted from the server. This can't be undone.
          {tree.unreadable.length > 0 && (
            <div className="mt-1 text-[11.5px] text-warn">
              {plural(tree.unreadable.length, "folder")} couldn't be read, so{" "}
              {tree.unreadable.length === 1 ? "it" : "they"} may not delete.
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}

const CLASSES = [
  { label: "Owner", shift: 6 },
  { label: "Group", shift: 3 },
  { label: "Others", shift: 0 },
];
const RIGHTS = [
  { label: "Read", bit: 4 },
  { label: "Write", bit: 2 },
  { label: "Execute", bit: 1 },
];

/** Permissions as an rwx grid and an octal field, kept in step. */
export function ChmodDialog({
  items,
  initial,
  busy,
  ftp,
  onApply,
  onCancel,
}: {
  items: RemoteFile[];
  initial: number;
  busy: boolean;
  /** FTP applies it with SITE CHMOD, which some servers don't support. */
  ftp: boolean;
  onApply: (mode: number, recursive: boolean, dirExec: boolean) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState(initial & 0o7777);
  const [octal, setOctal] = useState((initial & 0o7777).toString(8).padStart(3, "0"));
  const [recursive, setRecursive] = useState(false);
  const [dirExec, setDirExec] = useState(true);
  const hasDirs = items.some((f) => f.isDir);

  const setBits = (next: number) => {
    setMode(next);
    setOctal(next.toString(8).padStart(3, "0"));
  };
  const onOctal = (text: string) => {
    setOctal(text);
    if (/^[0-7]{3,4}$/.test(text)) setMode(parseInt(text, 8));
  };
  const valid = /^[0-7]{3,4}$/.test(octal);

  return (
    <Shell
      icon={<Lock size={15} />}
      title={`Permissions · ${plural(items.length, "item")}`}
      onClose={onCancel}
      footer={
        <>
          <button onClick={onCancel} className="btn-ghost" disabled={busy}>
            Cancel
          </button>
          <button
            onClick={() => onApply(mode, recursive && hasDirs, dirExec)}
            disabled={!valid || busy}
            className="btn-primary disabled:opacity-40"
          >
            {busy ? "Applying…" : "Apply"}
          </button>
        </>
      }
    >
      <Preview items={items} max={4} />
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="micro-label">
            <th className="py-1 text-left font-medium"></th>
            {RIGHTS.map((r) => (
              <th key={r.label} className="py-1 font-medium">
                {r.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CLASSES.map((c) => (
            <tr key={c.label}>
              <td className="py-1 text-ink-mid">{c.label}</td>
              {RIGHTS.map((r) => {
                const b = r.bit << c.shift;
                return (
                  <td key={r.label} className="py-1 text-center">
                    <input
                      type="checkbox"
                      checked={!!(mode & b)}
                      onChange={(e) => setBits(e.target.checked ? mode | b : mode & ~b)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-3">
        <div className="w-24">
          <label className="field-label">Octal</label>
          <input
            className="field-input font-mono text-[13px]"
            value={octal}
            maxLength={4}
            onChange={(e) => onOctal(e.target.value.trim())}
          />
        </div>
        <div className="pt-5 font-mono text-[13px] text-ink-mid">
          {valid ? formatMode(mode) : "—"}
        </div>
      </div>
      {hasDirs && (
        <div className="space-y-2 rounded-lg border border-edge bg-bg-inset/50 p-3">
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-mid">
            <input
              type="checkbox"
              checked={recursive}
              onChange={(e) => setRecursive(e.target.checked)}
            />
            Apply to everything inside the selected folders
          </label>
          {recursive && (
            <label className="flex cursor-pointer items-center gap-2.5 pl-6 text-[12.5px] text-ink-mid">
              <input
                type="checkbox"
                checked={dirExec}
                onChange={(e) => setDirExec(e.target.checked)}
              />
              Folders also get execute wherever they get read (so 644 stays openable)
            </label>
          )}
        </div>
      )}
      {ftp && (
        <p className="text-[11px] leading-relaxed text-ink-dim">
          Sent as SITE CHMOD — Unix FTP servers support it; Windows ones usually don't.
        </p>
      )}
    </Shell>
  );
}

/** Owner and group, by name or numeric id. SFTP only: FTP has no chown. */
export function ChownDialog({
  items,
  users,
  groups,
  busy,
  onApply,
  onCancel,
}: {
  items: RemoteFile[];
  /** Names known on the server, offered as suggestions. */
  users: string[];
  groups: string[];
  busy: boolean;
  onApply: (owner: string | null, group: string | null, recursive: boolean) => void;
  onCancel: () => void;
}) {
  // Prefill only when the whole selection agrees; mixed owners start blank.
  const same = (key: "owner" | "group") => {
    const first = items[0]?.[key];
    return first && items.every((f) => f[key] === first) ? first : "";
  };
  const [owner, setOwner] = useState(same("owner"));
  const [group, setGroup] = useState(same("group"));
  const [recursive, setRecursive] = useState(false);
  const hasDirs = items.some((f) => f.isDir);
  const ready = !!owner.trim() || !!group.trim();

  return (
    <Shell
      icon={<UserCog size={15} />}
      title={`Owner · ${plural(items.length, "item")}`}
      onClose={onCancel}
      footer={
        <>
          <button onClick={onCancel} className="btn-ghost" disabled={busy}>
            Cancel
          </button>
          <button
            onClick={() =>
              onApply(owner.trim() || null, group.trim() || null, recursive && hasDirs)
            }
            disabled={!ready || busy}
            className="btn-primary disabled:opacity-40"
          >
            {busy ? "Applying…" : "Apply"}
          </button>
        </>
      }
    >
      <Preview items={items} max={4} />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="field-label">Owner</label>
          <input
            autoFocus
            list="dshh-remote-users"
            className="field-input font-mono text-[13px]"
            value={owner}
            placeholder="keep"
            onChange={(e) => setOwner(e.target.value)}
          />
          <datalist id="dshh-remote-users">
            {users.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="field-label">Group</label>
          <input
            list="dshh-remote-groups"
            className="field-input font-mono text-[13px]"
            value={group}
            placeholder="keep"
            onChange={(e) => setGroup(e.target.value)}
          />
          <datalist id="dshh-remote-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </div>
      </div>
      {hasDirs && (
        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-mid">
          <input
            type="checkbox"
            checked={recursive}
            onChange={(e) => setRecursive(e.target.checked)}
          />
          Apply to everything inside the selected folders
        </label>
      )}
      <p className="text-[11px] leading-relaxed text-ink-dim">
        Names or numeric ids. Leave one blank to keep it. Giving files to another user
        normally needs a root login.
      </p>
    </Shell>
  );
}

/** A finished bulk operation, summarised for the status bar. */
export function reportText(
  verb: string,
  r: { files: number; dirs: number; failed: number; errors: string[] }
): string {
  const done = [r.files ? plural(r.files, "file") : "", r.dirs ? plural(r.dirs, "folder") : ""]
    .filter(Boolean)
    .join(" and ");
  const head = `${verb} ${done || "nothing"}`;
  return r.failed ? `${head} — ${r.failed} failed: ${r.errors[0] ?? ""}` : head;
}
