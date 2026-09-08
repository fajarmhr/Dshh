import { useCallback, useEffect, useRef, useState } from "react";
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
} from "lucide-react";
import { LocalPane } from "./LocalPane";
import { PasswordPrompt } from "./PasswordPrompt";
import { TransferBar, type Transfer } from "./TransferBar";
import { FileTypeIcon } from "../lib/fileIcons";
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
} from "../lib/api";
import type { Connection, RemoteFile, Session } from "../lib/types";
import { formatBytes, formatDate, isAuthFailure } from "../lib/utils";

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
  // Latest values for the long-lived drag-drop subscription.
  const dropCtx = useRef({ backendId: null as string | null, cwd, isSftp });
  dropCtx.current = { backendId, cwd, isSftp };

  const list = useCallback(
    async (id: string, path: string) => {
      setBusy(true);
      try {
        const res = isSftp ? await sftpList(id, path) : await ftpList(id, path);
        res.files.sort((a, b) =>
          a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
        );
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
    const parent = cwd.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
    list(backendId, parent);
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
          onClick={() => backendId && list(backendId, cwd)}
          className="tb-btn"
          title="Refresh"
        >
          <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
        </button>
        <button onClick={upload} className="tb-btn" title="Upload file">
          <Upload size={15} />
        </button>
        <div className="mx-2 flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-edge bg-bg-inset px-2 text-ink-mid focus-within:border-accent">
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.length === 0 && !busy ? (
          <div className="flex h-full items-center justify-center">
            <span className="font-mono text-[11px] text-ink-dim">
              {msg || "empty directory"}
            </span>
          </div>
        ) : (
          <table className={`w-full text-[13px] ${busy ? "opacity-60" : ""}`}>
            <thead className="sticky top-0 bg-bg-panel">
              <tr className="micro-label">
                <th className="px-3 py-2 text-left font-medium">name</th>
                <th className="px-3 py-2 text-left font-medium">owner</th>
                <th className="px-3 py-2 text-right font-medium">size</th>
                <th className="px-3 py-2 text-right font-medium">modified</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr
                  key={f.path}
                  onDoubleClick={() => enter(f)}
                  draggable={!f.isDir}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      "application/x-dshh-remote",
                      JSON.stringify({ path: f.path, name: f.name })
                    );
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  className="group cursor-default border-b border-edge/40 transition hover:bg-bg-hover"
                >
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2.5">
                      {f.isDir ? (
                        <Folder size={15} className="shrink-0 text-warn" />
                      ) : (
                        <FileTypeIcon name={f.name} />
                      )}
                      <span className="truncate text-ink-hi">{f.name}</span>
                    </div>
                  </td>
                  <td
                    className="px-3 py-1.5 font-mono text-[11px] text-ink-mid"
                    title={f.group ? `${f.owner ?? "?"}:${f.group}` : undefined}
                  >
                    <span className="truncate">{f.owner || "—"}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[11px] text-ink-mid">
                    {f.isDir ? "—" : formatBytes(f.size)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[11px] text-ink-dim">
                    {formatDate(f.modified)}
                  </td>
                  <td className="px-2">
                    {!f.isDir && (
                      <div className="flex items-center justify-end gap-0.5">
                        {isSftp && (
                          <button
                            onClick={() => editRemote(f)}
                            className="rounded p-1 text-ink-dim opacity-0 transition hover:bg-bg-elev hover:text-ink-hi group-hover:opacity-100"
                            title="Edit in local editor (saves upload automatically)"
                          >
                            <Pencil size={14} />
                          </button>
                        )}
                        <button
                          onClick={() => download(f)}
                          className="rounded p-1 text-ink-dim opacity-0 transition hover:bg-bg-elev hover:text-ink-hi group-hover:opacity-100"
                          title="Download"
                        >
                          <Download size={14} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {transfer && (
        <div className="shrink-0 border-t border-edge bg-bg-panel">
          <TransferBar transfer={transfer} />
        </div>
      )}

      <div className="flex h-7 shrink-0 items-center border-t border-edge bg-bg-panel px-3">
        <span className="truncate font-mono text-[10.5px] text-ink-dim">
          {msg || `${files.length} items`}
        </span>
      </div>
      </div>

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
