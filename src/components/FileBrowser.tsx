import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowUp,
  RefreshCw,
  Download,
  Upload,
  Folder,
  Columns2,
  HardDrive,
  Pencil,
  FolderOpen,
  FolderSearch,
  Lock,
  Square,
  Trash2,
  UserCog,
  X,
} from "lucide-react";
import { LocalPane } from "./LocalPane";
import { PasswordPrompt } from "./PasswordPrompt";
import {
  ChmodDialog,
  ChownDialog,
  DeleteConfirm,
  formatMode,
  reportText,
} from "./FileActionDialogs";
import { TransferBar, type Transfer } from "./TransferBar";
import {
  GroupRow,
  SearchBox,
  SortTh,
  useCollapsedGroups,
  useFileViewPrefs,
  ViewMenu,
} from "./FileViewControls";
import { FileTypeIcon } from "../lib/fileIcons";
import { arrangeFiles, parentDir, relativeDir } from "../lib/fileView";
import { searchTree, type SearchEnd, type SearchProgress } from "../lib/remoteSearch";
import { useStore } from "../store";
import {
  sftpConnect,
  sftpList,
  sftpDownload,
  sftpUpload,
  sftpDisconnect,
  ftpConnect,
  ftpList,
  ftpDownload,
  ftpUpload,
  ftpDisconnect,
  editStart,
  sftpTree,
  sftpDelete,
  sftpChmod,
  sftpChown,
  sftpPrincipals,
  ftpTree,
  ftpDelete,
  ftpChmod,
  localMkdir,
  type FileTarget,
  type FileTree,
} from "../lib/api";
import type { Connection, RemoteFile, Session } from "../lib/types";
import { formatBytes, formatDate, isAuthFailure } from "../lib/utils";
import { useSaveConnectionPref, wheelSteps } from "../lib/zoom";
import { downloadPath } from "../lib/localPaths";

/** A bulk action waiting on its dialog. */
type PendingAction =
  | { kind: "delete"; items: RemoteFile[]; tree: FileTree | null; error: string | null }
  | { kind: "chmod"; items: RemoteFile[] }
  | { kind: "chown"; items: RemoteFile[]; users: string[]; groups: string[] };

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2;

const targetsOf = (items: RemoteFile[]): FileTarget[] =>
  items.map((f) => ({ path: f.path, isDir: f.isDir, size: f.size }));

/** A recursive name search and what it has found so far. */
interface DeepSearch extends SearchProgress {
  query: string;
  /** Folder the walk started from; results are labelled relative to it. */
  root: string;
  state: "running" | SearchEnd;
}

export function FileBrowser({
  session,
  conn,
}: {
  session: Session;
  conn: Connection;
}) {
  const isSftp = session.protocol === "sftp";
  const setStatus = useStore((s) => s.setSessionStatus);
  const settings = useStore((s) => s.settings);
  const [backendId, setBackendId] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string>(isSftp ? "." : "/");
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  /** The transfer currently in flight, driving the progress bar. */
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [showLocal, setShowLocal] = useState(false);
  // Editable address bar. Kept as a draft so a half-typed path never becomes
  // the real cwd; navigating elsewhere (click, Up, refresh) resyncs it.
  const [pathDraft, setPathDraft] = useState(cwd);
  /** Server rejected our saved credential; holds the message to show. */
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  /** True once the pane is unmounting, so late handshakes clean up after themselves. */
  const disposedRef = useRef(false);
  /** Live backend handle, read by cleanup — a retry replaces it mid-life. */
  const backendRef = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const remoteRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useFileViewPrefs("remote");
  const [collapsed, toggleGroup] = useCollapsedGroups();
  /** Filters whatever is listed as you type; Enter widens it to subfolders. */
  const [query, setQuery] = useState("");
  /** Subfolder search results, shown in place of the listing while set. */
  const [search, setSearch] = useState<DeepSearch | null>(null);
  /** Bumped to cancel a running search: each walk checks it holds the latest ticket. */
  const searchRun = useRef(0);
  /** Ticket of a search the user stopped: it ends, but keeps what it found. */
  const stoppedRun = useRef(0);
  /** A row to scroll to and flash, after "show in folder". */
  const [reveal, setReveal] = useState<string | null>(null);
  /** cwd as the listing callback sees it, to tell a refresh from a move. */
  const cwdRef = useRef(cwd);
  /** Selected rows, by path. Only ever holds rows currently on screen. */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** Where a Shift+click range starts: the last row clicked without Shift. */
  const anchorRef = useRef<string | null>(null);
  const [action, setAction] = useState<PendingAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  /** A multi-file download is running; `bulkStop` asks it to end after the current file. */
  const [bulkRunning, setBulkRunning] = useState(false);
  const bulkStop = useRef(false);
  /** List zoom from Ctrl+scroll, remembered on the connection. */
  const [zoom, setZoom] = useState(conn.fileZoom ?? 1);
  const saveZoom = useSaveConnectionPref(conn.id);
  const listRef = useRef<HTMLDivElement>(null);
  // Latest values for the long-lived drag-drop subscription.
  const dropCtx = useRef({ backendId: null as string | null, cwd, isSftp });
  dropCtx.current = { backendId, cwd, isSftp };

  const list = useCallback(
    async (id: string, path: string) => {
      setBusy(true);
      try {
        const res = isSftp ? await sftpList(id, path) : await ftpList(id, path);
        // Moving to another folder drops the filter and any search results; a
        // refresh in place (after an upload, say) keeps them.
        if (res.path !== cwdRef.current) {
          searchRun.current++;
          setSearch(null);
          setQuery("");
          setSelected(new Set());
          cwdRef.current = res.path;
        }
        setFiles(res.files);
        // Server-resolved path, so the address bar shows where "." landed.
        setCwd(res.path);
      } catch (e) {
        setMsg(String(e));
      } finally {
        setBusy(false);
      }
    },
    [isSftp]
  );

  /**
   * The credential a rejected connection could be retried with. FTP only ever
   * authenticates with a password; SFTP follows the connection's own method,
   * and agent auth has nothing to type.
   */
  const retryField: "password" | "passphrase" | null = !isSftp
    ? "password"
    : conn.authMethod === "agent"
      ? null
      : conn.authMethod === "key"
        ? "passphrase"
        : "password";

  /**
   * Connect the browser pane. `secret` overrides the saved credential for this
   * attempt only, and is written back to the connection just once the server
   * has accepted it.
   */
  const openConnection = async (secret?: { value: string; username?: string }) => {
    const attempt: Connection =
      secret && retryField
        ? {
            ...conn,
            [retryField]: secret.value,
            ...(secret.username ? { username: secret.username } : {}),
          }
        : conn;
    try {
      const id = isSftp ? await sftpConnect(attempt) : await ftpConnect(attempt);
      if (disposedRef.current) {
        // Pane closed mid-handshake — hand the backend handle straight back.
        (isSftp ? sftpDisconnect(id) : ftpDisconnect(id)).catch(() => {});
        return;
      }
      backendRef.current = id;
      setBackendId(id);
      setStatus(session.id, "connected");
      setAuthError(null);
      const store = useStore.getState();
      if (
        secret &&
        retryField &&
        store.settings.saveRetriedCredentials &&
        store.connections.some((c) => c.id === conn.id)
      ) {
        store.updateConnection(conn.id, {
          [retryField]: secret.value,
          ...(secret.username ? { username: secret.username } : {}),
        });
      }
      await list(id, isSftp ? "." : "/");
    } catch (e) {
      if (disposedRef.current) return;
      const message = String(e);
      setStatus(session.id, "error", message);
      setMsg(message);
      if (retryField && isAuthFailure(message)) setAuthError(message);
    } finally {
      setAuthBusy(false);
    }
  };

  useEffect(() => {
    disposedRef.current = false;
    openConnection();
    return () => {
      disposedRef.current = true;
      searchRun.current++;
      const id = backendRef.current;
      if (id) {
        isSftp ? sftpDisconnect(id).catch(() => {}) : ftpDisconnect(id).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enter = (f: RemoteFile) => {
    if (!backendId) return;
    if (!f.isDir) {
      // Double-clicking a file opens it in the local editor (SFTP only).
      if (isSftp) editRemote(f);
      return;
    }
    list(backendId, f.path);
  };

  const goUp = () => {
    if (!backendId) return;
    list(backendId, parentDir(cwd));
  };

  /** Walk the tree under `root` for names matching `q`, streaming results in. */
  const runSearch = async (q: string, root: string) => {
    const id = backendId;
    if (!id || !q.trim()) return;
    const ticket = ++searchRun.current;
    const base = { query: q.trim(), root };
    setSearch({ ...base, results: [], scanned: 0, failed: 0, current: root, state: "running" });
    const outcome = await searchTree({
      root,
      query: base.query,
      list: (p) => (isSftp ? sftpList(id, p) : ftpList(id, p)),
      concurrency: isSftp ? 4 : 1,
      isCancelled: () => searchRun.current !== ticket || stoppedRun.current === ticket,
      onProgress: (p) => {
        // Listings still landing after a stop must not flip it back to running.
        if (searchRun.current === ticket && stoppedRun.current !== ticket) {
          setSearch({ ...base, ...p, state: "running" });
        }
      },
    });
    if (searchRun.current === ticket) setSearch({ ...base, ...outcome, state: outcome.end });
  };

  const stopSearch = () => {
    stoppedRun.current = searchRun.current;
    setSearch((s) => (s && s.state === "running" ? { ...s, current: "", state: "cancelled" } : s));
  };

  const closeSearch = () => {
    searchRun.current++;
    setSearch(null);
  };

  const onQuery = (v: string) => {
    setQuery(v);
    // An emptied box means "no search": back to the plain listing.
    if (!v.trim()) closeSearch();
  };

  /** Leave the results for the folder a match lives in, with the match flashed. */
  const showInFolder = (f: RemoteFile) => {
    if (!backendId) return;
    closeSearch();
    setQuery("");
    setReveal(f.path);
    list(backendId, parentDir(f.path));
  };

  useEffect(() => {
    if (!reveal) return;
    remoteRef.current
      ?.querySelector(`[data-path="${CSS.escape(reveal)}"]`)
      ?.scrollIntoView({ block: "center" });
    const t = setTimeout(() => setReveal(null), 2500);
    return () => clearTimeout(t);
  }, [reveal, files]);

  const refresh = () => {
    if (!backendId) return;
    if (search) runSearch(search.query, search.root);
    else list(backendId, cwd);
  };

  useEffect(() => setPathDraft(cwd), [cwd]);

  // Enter navigates. A bad path leaves cwd untouched and reports through the
  // status bar, so the typed text stays put and can be corrected.
  const goPath = () => {
    const next = pathDraft.trim();
    if (!backendId || !next || next === cwd) return;
    list(backendId, next);
  };

  const download = async (f: RemoteFile) => {
    if (!backendId || f.isDir) return;
    // Offer the file's own type in the save dialog so Windows keeps the
    // original extension instead of defaulting to "All files".
    const dot = f.name.lastIndexOf(".");
    const ext = dot > 0 ? f.name.slice(dot + 1) : "";
    const local = await saveDialog({
      defaultPath: f.name,
      filters: [
        ...(ext ? [{ name: `${ext.toUpperCase()} file`, extensions: [ext] }] : []),
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (!local) return;
    setBusy(true);
    setMsg(`Downloading ${f.name}…`);
    const onProgress = (p: { done: number; total: number }) =>
      setTransfer({ name: f.name, dir: "down", ...p });
    try {
      isSftp
        ? await sftpDownload(backendId, f.path, local, onProgress)
        : await ftpDownload(backendId, f.path, local, onProgress);
      setMsg(`Downloaded ${f.name}`);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setTransfer(null);
      setBusy(false);
    }
  };

  const uploadPaths = useCallback(
    async (paths: string[]) => {
      const { backendId: id, cwd: dir, isSftp: sftp } = dropCtx.current;
      if (!id || paths.length === 0) return;
      setBusy(true);
      let ok = 0;
      let lastErr = "";
      for (const [i, p] of paths.entries()) {
        // Windows paths use "\", so split on both separators — otherwise the
        // whole local path gets baked into the remote file name.
        const name = p.split(/[\\/]/).pop()!;
        const remote = (dir.endsWith("/") ? dir : dir + "/") + name;
        setMsg(`Uploading ${name}…`);
        // A dropped folder of files is one batch: the bar names the file and
        // its place in the queue rather than flickering with no context.
        const batch: [number, number] | undefined =
          paths.length > 1 ? [i + 1, paths.length] : undefined;
        const onProgress = (prog: { done: number; total: number }) =>
          setTransfer({ name, dir: "up", batch, ...prog });
        try {
          sftp
            ? await sftpUpload(id, p, remote, onProgress)
            : await ftpUpload(id, p, remote, onProgress);
          ok++;
        } catch (e) {
          lastErr = `${name}: ${String(e)}`;
        }
      }
      setTransfer(null);
      setMsg(
        lastErr
          ? `Uploaded ${ok}/${paths.length} — ${lastErr}`
          : `Uploaded ${ok} file${ok === 1 ? "" : "s"}`
      );
      await list(id, dir);
      setBusy(false);
    },
    [list]
  );

  const upload = async () => {
    if (!backendId) return;
    const picked = await openDialog({ multiple: true });
    if (!picked) return;
    await uploadPaths(Array.isArray(picked) ? picked : [picked]);
  };

  // Download a remote file into a local directory (drop on the local pane).
  const downloadTo = useCallback(
    async (file: { path: string; name: string }, dir: string) => {
      const { backendId: id, isSftp: sftp } = dropCtx.current;
      if (!id) return;
      const sep = /^[A-Za-z]:/.test(dir) || dir.includes("\\") ? "\\" : "/";
      const local =
        dir.endsWith("\\") || dir.endsWith("/") ? dir + file.name : dir + sep + file.name;
      const onProgress = (p: { done: number; total: number }) =>
        setTransfer({ name: file.name, dir: "down", ...p });
      try {
        sftp
          ? await sftpDownload(id, file.path, local, onProgress)
          : await ftpDownload(id, file.path, local, onProgress);
      } finally {
        setTransfer(null);
      }
    },
    []
  );

  // Drag & drop from Explorer: upload into the current directory. The event
  // is window-global, so only react while the pointer is over this pane.
  useEffect(() => {
    const inBounds = (pos: { x: number; y: number }) => {
      const el = remoteRef.current;
      if (!el) return false;
      const scale = window.devicePixelRatio || 1;
      const r = el.getBoundingClientRect();
      const x = pos.x / scale;
      const y = pos.y / scale;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "over") {
        setDragOver(inBounds(p.position));
      } else if (p.type === "drop") {
        setDragOver(false);
        if (inBounds(p.position)) uploadPaths(p.paths);
      } else if (p.type === "leave") {
        setDragOver(false);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [uploadPaths]);

  // Open in the local default editor; saves upload back automatically.
  const editRemote = async (f: RemoteFile) => {
    if (f.isDir || !isSftp) return;
    setMsg(`Opening ${f.name} in your editor…`);
    try {
      await editStart(conn, f.path, (ev) =>
        setMsg(ev.startsWith("error") ? ev : `${f.name}: ${ev} — saved to server`)
      );
      setMsg(`${f.name} opened — saving in your editor uploads automatically`);
    } catch (e) {
      setMsg(String(e));
    }
  };

  const source = search ? search.results : files;
  const { groups, shown } = useMemo(
    () => arrangeFiles(source, query, view),
    [source, query, view]
  );
  /** Rows on screen, top to bottom — what selection and Shift ranges work over. */
  const ordered = useMemo(
    () => groups.flatMap((g) => (g.label && collapsed.has(g.key) ? [] : g.files)),
    [groups, collapsed]
  );
  // Selection follows what is visible: filtering, folding a group or a
  // refresh that drops a file also drops it from the selection, so an action
  // never reaches rows the user can't see.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(ordered.map((f) => f.path));
      const next = new Set([...prev].filter((p) => visible.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [ordered]);
  const selectedItems = useMemo(
    () => ordered.filter((f) => selected.has(f.path)),
    [ordered, selected]
  );
  const allSelected = ordered.length > 0 && selectedItems.length === ordered.length;

  /** Explorer rules: click selects one, Ctrl toggles, Shift extends a range. */
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

  const toggleRow = (f: RemoteFile) => {
    anchorRef.current = f.path;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(f.path)) next.delete(f.path);
      else next.add(f.path);
      return next;
    });
  };

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(ordered.map((f) => f.path)));

  const onListKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(new Set(ordered.map((f) => f.path)));
    } else if (e.key === "Escape") {
      setSelected(new Set());
    } else if (e.key === "Delete" && selectedItems.length) {
      e.preventDefault();
      openDelete();
    } else if (e.ctrlKey && e.key === "0") {
      e.preventDefault();
      applyZoom(1);
    }
  };

  const applyZoom = (z: number) => {
    const next = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 10) / 10;
    setZoom(next);
    saveZoom({ fileZoom: next === 1 ? undefined : next });
  };
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const applyZoomRef = useRef(applyZoom);
  applyZoomRef.current = applyZoom;

  // Ctrl+scroll over the list zooms it. A native listener, because React's
  // wheel handler is passive and can't stop the page from scrolling.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const acc = { v: 0 };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const steps = wheelSteps(acc, e);
      if (steps) applyZoomRef.current(zoomRef.current + steps * 0.1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ---- Bulk actions on the selection ----

  const finishAction = (text: string) => {
    setMsg(text);
    setAction(null);
    setSelected(new Set());
    refresh();
  };

  const openDelete = () => {
    if (!backendId || selectedItems.length === 0) return;
    const items = selectedItems;
    setAction({ kind: "delete", items, tree: null, error: null });
    // Count first: the warning should say what a folder actually holds.
    (isSftp ? sftpTree : ftpTree)(backendId, targetsOf(items))
      .then((tree) =>
        setAction((a) => (a?.kind === "delete" && a.items === items ? { ...a, tree } : a))
      )
      .catch((e) =>
        setAction((a) =>
          a?.kind === "delete" && a.items === items ? { ...a, error: String(e) } : a
        )
      );
  };

  const confirmDelete = async () => {
    if (!backendId || action?.kind !== "delete") return;
    setActionBusy(true);
    try {
      const r = await (isSftp ? sftpDelete : ftpDelete)(backendId, targetsOf(action.items));
      finishAction(reportText("Deleted", r));
    } catch (e) {
      finishAction(String(e));
    } finally {
      setActionBusy(false);
    }
  };

  const applyChmod = async (mode: number, recursive: boolean, dirExec: boolean) => {
    if (!backendId || action?.kind !== "chmod") return;
    setActionBusy(true);
    try {
      const r = await (isSftp ? sftpChmod : ftpChmod)(
        backendId,
        targetsOf(action.items),
        mode,
        recursive,
        dirExec
      );
      finishAction(reportText(`Set ${formatMode(mode)} on`, r));
    } catch (e) {
      finishAction(String(e));
    } finally {
      setActionBusy(false);
    }
  };

  const openChown = () => {
    if (!backendId || !isSftp || selectedItems.length === 0) return;
    const items = selectedItems;
    setAction({ kind: "chown", items, users: [], groups: [] });
    sftpPrincipals(backendId)
      .then(({ users, groups }) =>
        setAction((a) => (a?.kind === "chown" && a.items === items ? { ...a, users, groups } : a))
      )
      .catch(() => {});
  };

  const applyChown = async (owner: string | null, group: string | null, recursive: boolean) => {
    if (!backendId || action?.kind !== "chown") return;
    setActionBusy(true);
    try {
      const r = await sftpChown(backendId, targetsOf(action.items), owner, group, recursive);
      finishAction(reportText(`Gave ${[owner, group].filter(Boolean).join(":")}`, r));
    } catch (e) {
      // A name the server doesn't know is worth correcting, not a dead end.
      setMsg(String(e));
    } finally {
      setActionBusy(false);
    }
  };

  /**
   * Download the selection into a local folder, folders as folders: the tree
   * under each is recreated and every file copied, one at a time with the
   * progress bar counting through the batch.
   */
  const downloadSelected = async () => {
    const id = backendId;
    const items = selectedItems;
    if (!id || items.length === 0) return;
    if (items.length === 1 && !items[0].isDir) {
      download(items[0]);
      return;
    }
    const dir = await openDialog({ directory: true, title: "Download to folder" });
    if (!dir || Array.isArray(dir)) return;
    const localFor = (path: string) => downloadPath(dir, items, path);
    bulkStop.current = false;
    setBulkRunning(true);
    setBusy(true);
    try {
      setMsg("Working out what to download…");
      const tree: FileTree = items.some((f) => f.isDir)
        ? await (isSftp ? sftpTree : ftpTree)(id, targetsOf(items))
        : {
            entries: items.map((f) => ({ path: f.path, isDir: false, size: f.size, link: false })),
            unreadable: [],
          };
      for (const d of tree.entries.filter((e) => e.isDir)) await localMkdir(localFor(d.path));
      const files = tree.entries.filter((e) => !e.isDir);
      let ok = 0;
      let failed = 0;
      let firstErr = "";
      for (const [i, f] of files.entries()) {
        if (bulkStop.current) break;
        const name = f.path.split("/").pop() ?? f.path;
        const batch: [number, number] | undefined =
          files.length > 1 ? [i + 1, files.length] : undefined;
        setTransfer({ name, dir: "down", batch, done: 0, total: f.size });
        try {
          await (isSftp ? sftpDownload : ftpDownload)(id, f.path, localFor(f.path), (p) =>
            setTransfer({ name, dir: "down", batch, ...p })
          );
          ok++;
        } catch (e) {
          failed++;
          firstErr ||= `${name}: ${String(e)}`;
        }
      }
      const stopped = bulkStop.current && ok + failed < files.length;
      const skipped = tree.unreadable.length
        ? ` · ${tree.unreadable.length} unreadable folder${tree.unreadable.length === 1 ? "" : "s"} skipped`
        : "";
      setMsg(
        `${stopped ? "Stopped after" : "Downloaded"} ${ok} of ${files.length} file${
          files.length === 1 ? "" : "s"
        } to ${dir}${skipped}${failed ? ` — ${failed} failed: ${firstErr}` : ""}`
      );
    } catch (e) {
      setMsg(String(e));
    } finally {
      setTransfer(null);
      setBulkRunning(false);
      setBusy(false);
    }
  };
  const filtering = query.trim() !== "";
  const searching = search?.state === "running";

  let emptyText: string;
  if (search) {
    emptyText =
      search.results.length > 0
        ? `none of the ${search.results.length} results match "${query.trim()}"`
        : searching
          ? "searching subfolders…"
          : `nothing matching "${search.query}" under ${search.root}`;
  } else if (files.length === 0) {
    emptyText = msg || "empty directory";
  } else {
    emptyText = `nothing here matches "${query.trim()}" — press Enter to search subfolders`;
  }

  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  let counts: string;
  if (search) {
    const total = search.results.length;
    counts = [
      shown === total ? plural(total, "match", "matches") : `${shown} of ${total} matches`,
      `${plural(search.scanned, "folder")} scanned`,
      search.failed ? `${search.failed} unreadable` : "",
      search.state === "cancelled" ? "stopped" : search.state === "limit" ? "stopped at the limit" : "",
    ]
      .filter(Boolean)
      .join(" · ");
  } else {
    counts = filtering ? `${shown} of ${plural(files.length, "item")}` : plural(files.length, "item");
  }

  const row = (f: RemoteFile) => {
    const isSelected = selected.has(f.path);
    return (
      <tr
        key={f.path}
        data-path={f.path}
        onClick={(e) => clickRow(e, f)}
        onMouseDown={(e) => e.shiftKey && e.preventDefault()}
        onDoubleClick={() => enter(f)}
        draggable={!f.isDir}
        onDragStart={(e) => {
          e.dataTransfer.setData(
            "application/x-dshh-remote",
            JSON.stringify({ path: f.path, name: f.name })
          );
          e.dataTransfer.effectAllowed = "copy";
        }}
        className={`group cursor-default border-b border-edge/40 transition ${
          isSelected ? "bg-accent/[0.12] hover:bg-accent/[0.16]" : "hover:bg-bg-hover"
        } ${reveal === f.path ? "bg-accent/15" : ""}`}
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
            <span className="min-w-[3rem] truncate text-ink-hi" title={f.name}>
              {f.name}
            </span>
            {search && (
              <span
                className="min-w-0 shrink-[4] truncate font-mono text-[10.5px] text-ink-dim"
                title={f.path}
              >
                {relativeDir(search.root, f.path)}/
              </span>
            )}
          </div>
        </td>
        <td
          className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-ink-mid"
          title={f.group ? `${f.owner ?? "?"}:${f.group}` : undefined}
        >
          {f.owner || "—"}
        </td>
        <td
          className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-ink-dim"
          title={f.mode != null ? `${f.mode.toString(8).padStart(3, "0")}` : undefined}
        >
          {f.mode != null ? formatMode(f.mode) : "—"}
        </td>
        <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-[11px] text-ink-mid">
          {f.isDir ? "—" : formatBytes(f.size)}
        </td>
        <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-[11px] text-ink-dim">
          {formatDate(f.modified)}
        </td>
        <td className="px-2">
          <div className="flex items-center justify-end gap-0.5">
            {search && (
              <button
                onClick={() => showInFolder(f)}
                className="rounded p-1 text-ink-dim opacity-0 transition hover:bg-bg-elev hover:text-ink-hi group-hover:opacity-100"
                title="Show in folder"
              >
                <FolderOpen size={14} />
              </button>
            )}
            {!f.isDir && isSftp && (
              <button
                onClick={() => editRemote(f)}
                className="rounded p-1 text-ink-dim opacity-0 transition hover:bg-bg-elev hover:text-ink-hi group-hover:opacity-100"
                title="Edit in local editor (saves upload automatically)"
              >
                <Pencil size={14} />
              </button>
            )}
            {!f.isDir && (
              <button
                onClick={() => download(f)}
                className="rounded p-1 text-ink-dim opacity-0 transition hover:bg-bg-elev hover:text-ink-hi group-hover:opacity-100"
                title="Download"
              >
                <Download size={14} />
              </button>
            )}
          </div>
        </td>
      </tr>
    );
  };

  const selFiles = selectedItems.filter((f) => !f.isDir).length;
  const selDirs = selectedItems.length - selFiles;
  const barBtn =
    "flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11.5px] text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi disabled:pointer-events-none disabled:opacity-30";

  return (
    <div ref={rootRef} className="flex h-full bg-bg-base">
      {showLocal && <LocalPane onRemoteDrop={downloadTo} />}
      <div
        ref={remoteRef}
        className="relative flex h-full min-w-0 flex-1 flex-col"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("application/x-dshh-local")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          if (!remoteRef.current?.contains(e.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData("application/x-dshh-local");
          setDragOver(false);
          if (!raw) return;
          e.preventDefault();
          const file = JSON.parse(raw) as { path: string };
          uploadPaths([file.path]);
        }}
      >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10">
          <span className="rounded-md bg-bg-panel px-3 py-1.5 font-mono text-xs text-accent">
            drop to upload into {cwd}
          </span>
        </div>
      )}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-edge bg-bg-panel px-2">
        <button
          onClick={() => setShowLocal((v) => !v)}
          className={`tb-btn ${showLocal ? "text-accent" : ""}`}
          title="Split view: local disk pane for drag & drop"
        >
          <Columns2 size={15} />
        </button>
        <button onClick={goUp} className="tb-btn" title="Up one directory">
          <ArrowUp size={15} />
        </button>
        <button
          onClick={refresh}
          className="tb-btn"
          title={search ? "Run the search again" : "Refresh"}
        >
          <RefreshCw size={15} className={busy || searching ? "animate-spin" : ""} />
        </button>
        <button onClick={upload} className="tb-btn" title="Upload file">
          <Upload size={15} />
        </button>
        <div className="mx-2 flex h-6 min-w-[5rem] flex-1 items-center gap-1.5 rounded-md border border-edge bg-bg-inset px-2 text-ink-mid focus-within:border-accent">
          <HardDrive size={11} className="shrink-0 text-ink-dim" />
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
            aria-label="Directory path"
            title="Type a path and press Enter"
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none placeholder:text-ink-dim"
          />
        </div>
        <SearchBox
          value={query}
          onChange={onQuery}
          onSubmit={() => runSearch(query, cwd)}
          placeholder="Filter"
          title="Filters this folder as you type · Enter searches subfolders too · * is a wildcard"
        />
        <ViewMenu prefs={view} onChange={setView} />
      </div>

      {search && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-edge bg-accent/[0.06] pl-3 pr-1.5">
          {searching ? (
            <RefreshCw size={12} className="shrink-0 animate-spin text-accent" />
          ) : (
            <FolderSearch size={13} className="shrink-0 text-accent" />
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-mid">
            {searching ? (
              <>
                searching for <span className="text-ink-hi">"{search.query}"</span> in{" "}
                {search.current}
              </>
            ) : (
              <>
                <span className="text-ink-hi">"{search.query}"</span> in {search.root} and
                its subfolders
              </>
            )}
          </span>
          {searching && (
            <button
              onClick={stopSearch}
              className="shrink-0 rounded-md px-2 py-0.5 font-mono text-[10.5px] text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi"
            >
              stop
            </button>
          )}
          <button onClick={closeSearch} className="tb-btn shrink-0" title="Back to the folder listing">
            <X size={13} />
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
      <div
        ref={listRef}
        tabIndex={-1}
        onKeyDown={onListKey}
        className={`h-full overflow-y-auto outline-none ${selectedItems.length ? "pb-14" : ""}`}
      >
        {shown === 0 && !busy ? (
          <div className="flex h-full items-center justify-center px-4 text-center">
            <span className="font-mono text-[11px] text-ink-dim">{emptyText}</span>
          </div>
        ) : (
          <table
            className={`w-full text-[13px] ${busy ? "opacity-60" : ""}`}
            style={zoom !== 1 ? { zoom } : undefined}
          >
            <thead className="sticky top-0 z-10 bg-bg-panel">
              <tr className="micro-label">
                <th className="w-8 py-2 pl-3 pr-0">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = selectedItems.length > 0 && !allSelected;
                    }}
                    onChange={toggleAll}
                    aria-label="Select all"
                    title="Select all (Ctrl+A)"
                    className="block"
                  />
                </th>
                <SortTh
                  label={view.sortKey === "type" ? "name · type" : "name"}
                  sortKey="name"
                  alias="type"
                  prefs={view}
                  onChange={setView}
                />
                <th className="px-3 py-2 text-left font-medium">owner</th>
                <th className="px-3 py-2 text-left font-medium">perms</th>
                <SortTh label="size" sortKey="size" prefs={view} onChange={setView} align="right" />
                <SortTh
                  label="modified"
                  sortKey="modified"
                  prefs={view}
                  onChange={setView}
                  align="right"
                />
                <th className="w-10"></th>
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
                      colSpan={7}
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
          <div className="absolute bottom-3 left-1/2 z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 animate-fade-up items-center gap-1 rounded-lg border border-edge bg-bg-panel/95 py-1 pl-3 pr-1 shadow-[0_12px_32px_-8px_rgba(4,10,20,0.8)] backdrop-blur-sm">
            <span className="mr-2 min-w-0 shrink truncate font-mono text-[11px] text-ink-mid">
              <span className="text-ink-hi">{selectedItems.length} selected</span>
              {" · "}
              {[
                selFiles ? `${selFiles} file${selFiles === 1 ? "" : "s"}` : "",
                selDirs ? `${selDirs} folder${selDirs === 1 ? "" : "s"}` : "",
              ]
                .filter(Boolean)
                .join(", ")}
            </span>
            {bulkRunning ? (
              <button
                onClick={() => (bulkStop.current = true)}
                className={barBtn}
                title="Stop after the file being copied now"
              >
                <Square size={12} />
                Stop
              </button>
            ) : (
              <>
                <button
                  onClick={downloadSelected}
                  disabled={busy}
                  className={barBtn}
                  title="Download the selection — folders with everything inside"
                >
                  <Download size={13} />
                  Download
                </button>
                <button
                  onClick={() => setAction({ kind: "chmod", items: selectedItems })}
                  disabled={busy}
                  className={barBtn}
                  title={isSftp ? "Change permissions (chmod)" : "Change permissions (SITE CHMOD)"}
                >
                  <Lock size={13} />
                  Permissions
                </button>
                {isSftp && (
                  <button
                    onClick={openChown}
                    disabled={busy}
                    className={barBtn}
                    title="Change owner and group (chown)"
                  >
                    <UserCog size={13} />
                    Owner
                  </button>
                )}
                <button
                  onClick={openDelete}
                  disabled={busy}
                  className={`${barBtn} hover:!bg-err/15 hover:!text-err`}
                  title="Delete the selection (Del)"
                >
                  <Trash2 size={13} />
                  Delete
                </button>
              </>
            )}
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
      {transfer && (
        <div className="shrink-0 border-t border-edge bg-bg-panel">
          <TransferBar transfer={transfer} />
        </div>
      )}

      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-edge bg-bg-panel px-3 font-mono text-[10.5px] text-ink-dim">
        <span className="min-w-0 flex-1 truncate" title={msg}>
          {msg}
        </span>
        {zoom !== 1 && (
          <button
            onClick={() => applyZoom(1)}
            className="shrink-0 rounded px-1 text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi"
            title="Zoom (Ctrl+scroll) — click or Ctrl+0 to reset"
          >
            {Math.round(zoom * 100)}%
          </button>
        )}
        <span className="shrink-0">{counts}</span>
      </div>
      </div>

      {action?.kind === "delete" && (
        <DeleteConfirm
          items={action.items}
          tree={action.tree}
          error={action.error}
          busy={actionBusy}
          onConfirm={confirmDelete}
          onCancel={() => !actionBusy && setAction(null)}
        />
      )}
      {action?.kind === "chmod" && (
        <ChmodDialog
          items={action.items}
          initial={
            action.items.find((f) => f.mode != null)?.mode ??
            (action.items.every((f) => f.isDir) ? 0o755 : 0o644)
          }
          ftp={!isSftp}
          busy={actionBusy}
          onApply={applyChmod}
          onCancel={() => !actionBusy && setAction(null)}
        />
      )}
      {action?.kind === "chown" && (
        <ChownDialog
          items={action.items}
          users={action.users}
          groups={action.groups}
          busy={actionBusy}
          onApply={applyChown}
          onCancel={() => !actionBusy && setAction(null)}
        />
      )}

      {authError !== null && retryField && (
        <PasswordPrompt
          title="Authentication failed"
          target={`${conn.username ? `${conn.username}@` : ""}${conn.host}:${conn.port}`}
          error={authError}
          kind={retryField}
          busy={authBusy}
          needsUsername={!conn.username?.trim()}
          remembers={settings.saveRetriedCredentials}
          onSubmit={(value, username) => {
            setAuthBusy(true);
            openConnection({ value, username: username || undefined });
          }}
          onCancel={() => setAuthError(null)}
        />
      )}
    </div>
  );
}
