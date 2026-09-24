import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Folder, Monitor, RefreshCw } from "lucide-react";
import {
  GroupRow,
  SearchBox,
  SortTh,
  useCollapsedGroups,
  useFileViewPrefs,
  ViewMenu,
} from "./FileViewControls";
import { localFsHome, localFsList } from "../lib/api";
import { FileTypeIcon } from "../lib/fileIcons";
import { arrangeFiles } from "../lib/fileView";
import type { RemoteFile } from "../lib/types";
import { formatBytes, formatDate } from "../lib/utils";

const REMOTE_MIME = "application/x-dshh-remote";
const LOCAL_MIME = "application/x-dshh-local";

/**
 * Local disk pane for the FTP/SFTP split view. Drag a local file onto the
 * remote pane to upload; drop a remote file here to download into the
 * current directory. Listing comes from the `local_fs_*` commands; the
 * transfer itself is done by the parent via `onRemoteDrop`.
 */
export function LocalPane({
  onRemoteDrop,
}: {
  onRemoteDrop: (file: { path: string; name: string }, localDir: string) => Promise<void>;
}) {
  const [cwd, setCwd] = useState("");
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Editable address bar; mirrors the remote pane in FileBrowser.
  const [pathDraft, setPathDraft] = useState(cwd);
  const [view, setView] = useFileViewPrefs("local");
  const [collapsed, toggleGroup] = useCollapsedGroups();
  const [query, setQuery] = useState("");
  /** cwd as the listing callback sees it, to tell a refresh from a move. */
  const cwdRef = useRef(cwd);

  const list = useCallback(async (path: string) => {
    setBusy(true);
    try {
      const entries = await localFsList(path);
      // A filter belongs to the folder it was typed in.
      if (path !== cwdRef.current) {
        setQuery("");
        cwdRef.current = path;
      }
      setFiles(entries);
      setCwd(path);
      setMsg("");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    localFsHome().then(list).catch((e) => setMsg(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goUp = () => {
    if (!cwd) return;
    if (/^[A-Za-z]:/.test(cwd)) {
      const trimmed = cwd.replace(/[\\/]+$/, "");
      if (/^[A-Za-z]:$/.test(trimmed)) {
        list(""); // above a drive root → drive list
        return;
      }
      const parent = trimmed.split(/[\\/]/).slice(0, -1).join("\\");
      list(/^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent);
    } else {
      list(cwd.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/");
    }
  };

  useEffect(() => setPathDraft(cwd), [cwd]);

  // Enter navigates; an empty path lists the drives ("This PC").
  const goPath = () => {
    const next = pathDraft.trim();
    if (next === cwd) return;
    list(next);
  };

  const { groups, shown } = useMemo(
    () => arrangeFiles(files, query, view),
    [files, query, view]
  );
  const filtering = query.trim() !== "";

  const onDrop = async (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData(REMOTE_MIME);
    setDragOver(false);
    if (!raw || !cwd) return;
    e.preventDefault();
    const file = JSON.parse(raw) as { path: string; name: string };
    setBusy(true);
    setMsg(`Downloading ${file.name}…`);
    try {
      await onRemoteDrop(file, cwd);
      setMsg(`Downloaded ${file.name}`);
      await list(cwd);
    } catch (err) {
      setMsg(String(err));
    } finally {
      setBusy(false);
    }
  };

  const row = (f: RemoteFile) => (
    <tr
      key={f.path}
      onDoubleClick={() => f.isDir && list(f.path)}
      draggable={!f.isDir}
      onDragStart={(e) => {
        e.dataTransfer.setData(LOCAL_MIME, JSON.stringify({ path: f.path, name: f.name }));
        e.dataTransfer.effectAllowed = "copy";
      }}
      className="group cursor-default border-b border-edge/40 transition hover:bg-bg-hover"
    >
      <td className="w-full min-w-[9rem] max-w-0 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {f.isDir ? (
            <Folder size={15} className="shrink-0 text-warn" />
          ) : (
            <FileTypeIcon name={f.name} />
          )}
          <span className="truncate text-ink-hi" title={f.name}>
            {f.name}
          </span>
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-[11px] text-ink-mid">
        {f.isDir ? "—" : formatBytes(f.size)}
      </td>
      <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-[11px] text-ink-dim">
        {formatDate(f.modified)}
      </td>
    </tr>
  );

  return (
    <div
      ref={rootRef}
      className="relative flex h-full w-1/2 min-w-0 shrink-0 flex-col border-r border-edge bg-bg-base"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(REMOTE_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10">
          <span className="rounded-md bg-bg-panel px-3 py-1.5 font-mono text-xs text-accent">
            drop to download into {cwd}
          </span>
        </div>
      )}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-edge bg-bg-panel px-2">
        <button onClick={goUp} className="tb-btn" title="Up one directory">
          <ArrowUp size={15} />
        </button>
        <button onClick={() => list(cwd)} className="tb-btn" title="Refresh">
          <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
        </button>
        <div className="mx-2 flex h-6 min-w-[5rem] flex-1 items-center gap-1.5 rounded-md border border-edge bg-bg-inset px-2 text-ink-mid focus-within:border-accent">
          <Monitor size={11} className="shrink-0 text-ink-dim" />
          <input
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setPathDraft(cwd)}
            onKeyDown={(e) => {
              if (e.key === "Enter") goPath();
              else if (e.key === "Escape") {
                setPathDraft(cwd);
                e.currentTarget.blur();
              }
            }}
            placeholder="This PC"
            spellCheck={false}
            autoComplete="off"
            aria-label="Local directory path"
            title="Type a path and press Enter"
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none placeholder:text-ink-dim"
          />
        </div>
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Filter"
          title="Filters this folder as you type · * is a wildcard"
        />
        <ViewMenu prefs={view} onChange={setView} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown === 0 && !busy ? (
          <div className="flex h-full items-center justify-center px-4 text-center">
            <span className="font-mono text-[11px] text-ink-dim">
              {files.length === 0
                ? msg || "empty directory"
                : `nothing here matches "${query.trim()}"`}
            </span>
          </div>
        ) : (
          <table className={`w-full text-[13px] ${busy ? "opacity-60" : ""}`}>
            <thead className="sticky top-0 z-10 bg-bg-panel">
              <tr className="micro-label">
                <SortTh
                  label={view.sortKey === "type" ? "local · type" : "local"}
                  sortKey="name"
                  alias="type"
                  prefs={view}
                  onChange={setView}
                />
                <SortTh label="size" sortKey="size" prefs={view} onChange={setView} align="right" />
                <SortTh
                  label="modified"
                  sortKey="modified"
                  prefs={view}
                  onChange={setView}
                  align="right"
                />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) =>
                g.label ? (
                  <Fragment key={g.key}>
                    <GroupRow
                      group={g}
                      collapsed={collapsed.has(g.key)}
                      onToggle={() => toggleGroup(g.key)}
                      colSpan={3}
                    />
                    {!collapsed.has(g.key) && g.files.map(row)}
                  </Fragment>
                ) : (
                  <Fragment key={g.key}>{g.files.map(row)}</Fragment>
                )
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-edge bg-bg-panel px-3 font-mono text-[10.5px] text-ink-dim">
        <span className="min-w-0 flex-1 truncate">
          {msg || "drag onto the remote pane to upload"}
        </span>
        <span className="shrink-0">
          {filtering ? `${shown} of ${files.length} items` : `${files.length} items`}
        </span>
      </div>
    </div>
  );
}
