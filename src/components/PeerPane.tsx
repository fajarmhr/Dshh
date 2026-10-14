import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, ArrowUp, Folder, RefreshCw, Server, Waypoints, X } from "lucide-react";
import {
  GroupRow,
  SearchBox,
  SortTh,
  useCollapsedGroups,
  useFileViewPrefs,
  ViewMenu,
} from "./FileViewControls";
import { PasswordPrompt } from "./PasswordPrompt";
import { ftpConnect, ftpDisconnect, ftpList, sftpConnect, sftpDisconnect, sftpList } from "../lib/api";
import { FileTypeIcon } from "../lib/fileIcons";
import { arrangeFiles, parentDir } from "../lib/fileView";
import type { Connection, RemoteFile } from "../lib/types";
import { formatBytes, formatDate, isAuthFailure } from "../lib/utils";
import { useStore } from "../store";

/** Rows dragged out of this pane, bound for server A. */
export const PEER_MIME = "application/x-dshh-peer";
/** Rows dragged out of the main (server A) pane, files and folders alike. */
export const ITEMS_MIME = "application/x-dshh-items";

/** What a drag carries: enough to copy each row without listing it again. */
export interface DragItem {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
}

export const dragItems = (files: RemoteFile[]): DragItem[] =>
  files.map(({ path, name, isDir, size }) => ({ path, name, isDir, size }));

/** Server B's live session, as the main pane needs it to start a copy. */
export interface PeerHandle {
  id: string;
  /** The connection as it authenticated, with any password typed into the retry prompt. */
  conn: Connection;
  cwd: string;
  refresh: () => void;
}

/** `host:port` as server B is saved — what server A dials unless told otherwise. */
export const ownAddress = (c: Connection) =>
  `${c.host ?? ""}:${c.port ?? (c.protocol === "ftp" ? 21 : 22)}`;

/**
 * Server B in the split view: a second saved server, browsed from this PC,
 * whose files are copied to and from server A *by server A* — see
 * `peer.rs`. Drag rows between the panes, or select and use the copy button.
 * The copy itself runs in the main pane, which owns server A's session and
 * the progress bar; this pane hands it B's session through `onHandle`.
 */
export function PeerPane({
  peer,
  hostName,
  route,
  onRouteChange,
  copying,
  onHandle,
  onPull,
  onPush,
}: {
  peer: Connection;
  /** Server A's name, for labels. */
  hostName: string;
  /** Override for where A reaches B; "" uses B's own address. */
  route: string;
  onRouteChange: (route: string) => void;
  /** A copy is running: new ones wait. */
  copying: boolean;
  onHandle: (h: PeerHandle | null) => void;
  /** Copy these rows of B into A's current folder. */
  onPull: (items: DragItem[]) => void;
  /** Copy rows dragged from A into `dir` on B. */
  onPush: (items: DragItem[], dir: string) => void;
}) {
  const isFtp = peer.protocol === "ftp";
  const [id, setId] = useState<string | null>(null);
  /** Same as `peer` unless a retried credential got us in. */
  const [authConn, setAuthConn] = useState(peer);
  const [cwd, setCwd] = useState("");
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [busy, setBusy] = useState(true);
  const [msg, setMsg] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [view, setView] = useFileViewPrefs("peer");
  const [collapsed, toggleGroup] = useCollapsedGroups();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);
  const [editingRoute, setEditingRoute] = useState(false);
  const [routeDraft, setRouteDraft] = useState(route);
  const rootRef = useRef<HTMLDivElement>(null);
  /** One life per mount, so a StrictMode remount can't adopt a stale handshake. */
  const lifeRef = useRef({ dead: false });
  const idRef = useRef<string | null>(null);
  const cwdRef = useRef("");

  const retryField: "password" | "passphrase" | null = isFtp
    ? "password"
    : peer.authMethod === "agent"
      ? null
      : peer.authMethod === "key"
        ? "passphrase"
        : "password";

  const list = useCallback(
    async (handle: string, path: string) => {
      setBusy(true);
      try {
        const res = isFtp ? await ftpList(handle, path) : await sftpList(handle, path);
        if (res.path !== cwdRef.current) {
          setQuery("");
          setSelected(new Set());
          cwdRef.current = res.path;
        }
        setFiles(res.files);
        setCwd(res.path);
        setMsg("");
      } catch (e) {
        setMsg(String(e));
      } finally {
        setBusy(false);
      }
    },
    [isFtp]
  );
  const listRef = useRef(list);
  listRef.current = list;

  const connect = async (secret?: { value: string; username?: string }) => {
    const attempt: Connection =
      secret && retryField
        ? {
            ...peer,
            [retryField]: secret.value,
            ...(secret.username ? { username: secret.username } : {}),
          }
        : peer;
    const life = lifeRef.current;
    setBusy(true);
    setMsg(`connecting to ${peer.name}…`);
    try {
      const handle = isFtp ? await ftpConnect(attempt) : await sftpConnect(attempt);
      if (life.dead) {
        (isFtp ? ftpDisconnect(handle) : sftpDisconnect(handle)).catch(() => {});
        return;
      }
      idRef.current = handle;
      setId(handle);
      setAuthConn(attempt);
      setAuthError(null);
      const store = useStore.getState();
      if (
        secret &&
        retryField &&
        store.settings.saveRetriedCredentials &&
        store.connections.some((c) => c.id === peer.id)
      ) {
        store.updateConnection(peer.id, {
          [retryField]: secret.value,
          ...(secret.username ? { username: secret.username } : {}),
        });
      }
      await list(handle, isFtp ? "/" : ".");
    } catch (e) {
      if (life.dead) return;
      const message = String(e);
      setMsg(message);
      setBusy(false);
      if (retryField && isAuthFailure(message)) setAuthError(message);
    } finally {
      setAuthBusy(false);
    }
  };

  useEffect(() => {
    const life = { dead: false };
    lifeRef.current = life;
    connect();
    return () => {
      life.dead = true;
      const handle = idRef.current;
      idRef.current = null;
      if (handle) (isFtp ? ftpDisconnect(handle) : sftpDisconnect(handle)).catch(() => {});
    };
    // Keyed on the peer by the parent: a different server is a fresh mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tell the main pane what it needs to copy, and that it's gone on unmount.
  const onHandleRef = useRef(onHandle);
  onHandleRef.current = onHandle;
  useEffect(() => {
    onHandleRef.current(
      id ? { id, conn: authConn, cwd, refresh: () => listRef.current(id, cwdRef.current) } : null
    );
  }, [id, authConn, cwd]);
  useEffect(() => () => onHandleRef.current(null), []);

  useEffect(() => setPathDraft(cwd), [cwd]);
  useEffect(() => setRouteDraft(route), [route]);

  const goUp = () => id && list(id, parentDir(cwd));
  const goPath = () => {
    const next = pathDraft.trim();
    if (id && next && next !== cwd) list(id, next);
  };

  const { groups, shown } = useMemo(() => arrangeFiles(files, query, view), [files, query, view]);
  const ordered = useMemo(
    () => groups.flatMap((g) => (g.label && collapsed.has(g.key) ? [] : g.files)),
    [groups, collapsed]
  );
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(ordered.map((f) => f.path));
      const next = new Set([...prev].filter((p) => visible.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [ordered]);
  const selectedItems = useMemo(() => ordered.filter((f) => selected.has(f.path)), [ordered, selected]);
  const allSelected = ordered.length > 0 && selectedItems.length === ordered.length;

  const toggleRow = (f: RemoteFile) => {
    anchorRef.current = f.path;
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(f.path)) next.add(f.path);
      return next;
    });
  };
  const clickRow = (e: React.MouseEvent, f: RemoteFile) => {
    if (e.shiftKey && anchorRef.current) {
      const a = ordered.findIndex((r) => r.path === anchorRef.current);
      const b = ordered.findIndex((r) => r.path === f.path);
      if (a >= 0 && b >= 0) {
        const range = ordered.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.path);
        setSelected((prev) => new Set(e.ctrlKey ? [...prev, ...range] : range));
        return;
      }
    }
    anchorRef.current = f.path;
    if (e.ctrlKey || e.metaKey) toggleRow(f);
    else setSelected(new Set([f.path]));
  };
  const onListKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(new Set(ordered.map((f) => f.path)));
    } else if (e.key === "Escape") {
      setSelected(new Set());
    }
  };

  const ready = id !== null && !copying;
  const via = route.trim() || ownAddress(peer);

  const saveRoute = () => {
    setEditingRoute(false);
    const next = routeDraft.trim();
    // Typing B's own address back in is the same as clearing the override.
    onRouteChange(next === ownAddress(peer) ? "" : next);
  };

  const row = (f: RemoteFile) => {
    const isSelected = selected.has(f.path);
    return (
      <tr
        key={f.path}
        onClick={(e) => clickRow(e, f)}
        onMouseDown={(e) => e.shiftKey && e.preventDefault()}
        onDoubleClick={() => f.isDir && id && list(id, f.path)}
        draggable={ready}
        onDragStart={(e) => {
          const items = isSelected ? selectedItems : [f];
          e.dataTransfer.setData(PEER_MIME, JSON.stringify(dragItems(items)));
          e.dataTransfer.effectAllowed = "copy";
        }}
        className={`group cursor-default border-b border-edge/40 transition ${
          isSelected ? "bg-accent/[0.12] hover:bg-accent/[0.16]" : "hover:bg-bg-hover"
        }`}
      >
        <td className="w-8 py-1.5 pl-3 pr-0" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => toggleRow(f)}
            aria-label={`Select ${f.name}`}
            className="block"
          />
        </td>
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
  };

  return (
    <div
      ref={rootRef}
      className="relative flex min-h-0 flex-1 flex-col bg-bg-base"
      onDragOver={(e) => {
        if (ready && e.dataTransfer.types.includes(ITEMS_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData(ITEMS_MIME);
        setDragOver(false);
        if (!raw || !ready) return;
        e.preventDefault();
        onPush(JSON.parse(raw) as DragItem[], cwd);
      }}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10">
          <span className="max-w-[90%] truncate rounded-md bg-bg-panel px-3 py-1.5 font-mono text-xs text-accent">
            drop to copy into {cwd} — {hostName} sends it
          </span>
        </div>
      )}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-edge bg-bg-panel px-2">
        <button onClick={goUp} className="tb-btn" title="Up one directory" disabled={!id}>
          <ArrowUp size={15} />
        </button>
        <button
          onClick={() => id && list(id, cwd)}
          className="tb-btn"
          title="Refresh"
          disabled={!id}
        >
          <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
        </button>
        <div className="mx-2 flex h-6 min-w-[5rem] flex-1 items-center gap-1.5 rounded-md border border-edge bg-bg-inset px-2 text-ink-mid focus-within:border-accent">
          <Server size={11} className="shrink-0 text-ink-dim" />
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
            spellCheck={false}
            autoComplete="off"
            aria-label={`Directory path on ${peer.name}`}
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

      <div className="relative min-h-0 flex-1">
        <div className="h-full overflow-y-auto outline-none" tabIndex={-1} onKeyDown={onListKey}>
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
                  <th className="w-8 py-2 pl-3 pr-0">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = selectedItems.length > 0 && !allSelected;
                      }}
                      onChange={() =>
                        setSelected(allSelected ? new Set() : new Set(ordered.map((f) => f.path)))
                      }
                      aria-label="Select all"
                      title="Select all (Ctrl+A)"
                      className="block"
                    />
                  </th>
                  <SortTh
                    label={view.sortKey === "type" ? `${peer.name} · type` : peer.name}
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
                        colSpan={4}
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

        {selectedItems.length > 0 && (
          <div className="absolute inset-x-3 bottom-3 z-20 mx-auto flex w-fit max-w-full animate-fade-up items-center gap-1 rounded-lg border border-edge bg-bg-panel/95 py-1 pl-3 pr-1 shadow-[0_12px_32px_-8px_rgba(4,10,20,0.8)] backdrop-blur-sm">
            <span className="mr-2 shrink-0 whitespace-nowrap font-mono text-[11px] text-ink-hi">
              {selectedItems.length} selected
            </span>
            <button
              onClick={() => onPull(dragItems(selectedItems))}
              disabled={!ready}
              className="flex min-w-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi disabled:pointer-events-none disabled:opacity-30"
              title={`${hostName} fetches the selection straight from ${peer.name} into its open folder`}
            >
              <ArrowLeftRight size={13} className="shrink-0" />
              <span className="truncate">Copy to {hostName}</span>
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="tb-btn shrink-0"
              title="Clear selection (Esc)"
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>

      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-edge bg-bg-panel px-3 font-mono text-[10.5px] text-ink-dim">
        {editingRoute ? (
          <input
            autoFocus
            value={routeDraft}
            onChange={(e) => setRouteDraft(e.target.value)}
            onBlur={saveRoute}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveRoute();
              else if (e.key === "Escape") {
                setRouteDraft(route);
                setEditingRoute(false);
              }
            }}
            placeholder={ownAddress(peer)}
            spellCheck={false}
            aria-label={`Address ${hostName} uses to reach ${peer.name}`}
            className="h-5 min-w-0 flex-1 rounded border border-accent bg-bg-inset px-1.5 text-ink-hi outline-none"
          />
        ) : (
          <button
            onClick={() => setEditingRoute(true)}
            className="flex min-w-0 items-center gap-1 rounded px-1 text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi"
            title={`Where ${hostName} connects to reach ${peer.name}. Click to change it if ${hostName} sees ${peer.name} at another address than this PC does (a private IP, say)${
              peer.jumpHost ? ` — ${peer.name}'s jump host isn't used from ${hostName}` : ""
            }.`}
          >
            <Waypoints size={11} className="shrink-0" />
            <span className="truncate">
              {hostName} → {via}
            </span>
          </button>
        )}
        {!editingRoute && (
          <span className="ml-auto min-w-0 truncate text-right" title={msg}>
            {msg || (id ? `${files.length} items` : "")}
          </span>
        )}
      </div>

      {authError !== null && retryField && (
        <PasswordPrompt
          title="Authentication failed"
          target={`${peer.username ? `${peer.username}@` : ""}${peer.host}:${peer.port}`}
          kind={retryField}
          busy={authBusy}
          needsUsername={!peer.username?.trim()}
          onSubmit={(value, username) => {
            setAuthBusy(true);
            connect({ value, username: username || undefined });
          }}
          onCancel={() => setAuthError(null)}
        />
      )}
    </div>
  );
}
