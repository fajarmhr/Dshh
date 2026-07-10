import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowUp,
  RefreshCw,
  Download,
  Upload,
  Folder,
  File as FileIcon,
  HardDrive,
  Pencil,
} from "lucide-react";
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
import { formatBytes, formatDate } from "../lib/utils";

export function FileBrowser({
  session,
  conn,
}: {
  session: Session;
  conn: Connection;
}) {
  const isSftp = session.protocol === "sftp";
  const setStatus = useStore((s) => s.setSessionStatus);
  const [backendId, setBackendId] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string>(isSftp ? "." : "/");
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Latest values for the long-lived drag-drop subscription.
  const dropCtx = useRef({ backendId: null as string | null, cwd, isSftp });
  dropCtx.current = { backendId, cwd, isSftp };

  const list = useCallback(
    async (id: string, path: string) => {
      setBusy(true);
      try {
        const entries = isSftp ? await sftpList(id, path) : await ftpList(id, path);
        entries.sort((a, b) =>
          a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
        );
        setFiles(entries);
        setCwd(path);
      } catch (e) {
        setMsg(String(e));
      } finally {
        setBusy(false);
      }
    },
    [isSftp]
  );

  useEffect(() => {
    let disposed = false;
    let localId: string | null = null;
    (async () => {
      try {
        const id = isSftp ? await sftpConnect(conn) : await ftpConnect(conn);
        if (disposed) return;
        localId = id;
        setBackendId(id);
        setStatus(session.id, "connected");
        await list(id, isSftp ? "." : "/");
      } catch (e) {
        setStatus(session.id, "error", String(e));
        setMsg(String(e));
      }
    })();
    return () => {
      disposed = true;
      if (localId) {
        isSftp
          ? sftpDisconnect(localId).catch(() => {})
          : ftpDisconnect(localId).catch(() => {});
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

  const download = async (f: RemoteFile) => {
    if (!backendId || f.isDir) return;
    const local = await saveDialog({ defaultPath: f.name });
    if (!local) return;
    setBusy(true);
    setMsg(`Downloading ${f.name}…`);
    try {
      isSftp
        ? await sftpDownload(backendId, f.path, local)
        : await ftpDownload(backendId, f.path, local);
      setMsg(`Downloaded ${f.name}`);
    } catch (e) {
      setMsg(String(e));
    } finally {
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
      for (const p of paths) {
        const name = p.split(/[\/]/).pop()!;
        const remote = (dir.endsWith("/") ? dir : dir + "/") + name;
        setMsg(`Uploading ${name}…`);
        try {
          sftp ? await sftpUpload(id, p, remote) : await ftpUpload(id, p, remote);
          ok++;
        } catch (e) {
          lastErr = `${name}: ${String(e)}`;
        }
      }
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

  // Drag & drop from Explorer: upload into the current directory. The event
  // is window-global, so only react while the pointer is over this pane.
  useEffect(() => {
    const inBounds = (pos: { x: number; y: number }) => {
      const el = rootRef.current;
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
    <div ref={rootRef} className="relative flex h-full flex-col bg-bg-base">
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10">
          <span className="rounded-md bg-bg-panel px-3 py-1.5 font-mono text-xs text-accent">
            drop to upload into {cwd}
          </span>
        </div>
      )}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-edge bg-bg-panel px-2">
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
        <div className="mx-2 flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-edge bg-bg-inset px-2 text-ink-mid">
          <HardDrive size={11} className="shrink-0 text-ink-dim" />
          <span className="truncate font-mono text-[11px]">{cwd}</span>
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
                  className="group cursor-default border-b border-edge/40 transition hover:bg-bg-hover"
                >
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2.5">
                      {f.isDir ? (
                        <Folder size={15} className="shrink-0 text-warn" />
                      ) : (
                        <FileIcon size={15} className="shrink-0 text-ink-dim" />
                      )}
                      <span className="truncate text-ink-hi">{f.name}</span>
                    </div>
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

      <div className="flex h-7 shrink-0 items-center border-t border-edge bg-bg-panel px-3">
        <span className="truncate font-mono text-[10.5px] text-ink-dim">
          {msg || `${files.length} items`}
        </span>
      </div>
    </div>
  );
}
