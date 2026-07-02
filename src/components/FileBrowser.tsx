import { useCallback, useEffect, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowUp,
  RefreshCw,
  Download,
  Upload,
  Folder,
  File as FileIcon,
  HardDrive,
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
    if (!backendId || !f.isDir) return;
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

  const upload = async () => {
    if (!backendId) return;
    const picked = await openDialog({ multiple: false });
    if (!picked || Array.isArray(picked)) return;
    const name = picked.split(/[\/]/).pop()!;
    const remote = (cwd.endsWith("/") ? cwd : cwd + "/") + name;
    setBusy(true);
    setMsg(`Uploading ${name}…`);
    try {
      isSftp
        ? await sftpUpload(backendId, picked, remote)
        : await ftpUpload(backendId, picked, remote);
      setMsg(`Uploaded ${name}`);
      await list(backendId, cwd);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-bg-base">
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
                      <button
                        onClick={() => download(f)}
                        className="rounded p-1 text-ink-dim opacity-0 transition hover:bg-bg-elev hover:text-ink-hi group-hover:opacity-100"
                        title="Download"
                      >
                        <Download size={14} />
                      </button>
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
