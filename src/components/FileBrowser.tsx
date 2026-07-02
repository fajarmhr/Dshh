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
import { formatBytes } from "../lib/utils";

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
    setMsg(`Downloading ${f.name}...`);
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
    setMsg(`Uploading ${name}...`);
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
      <div className="flex items-center gap-1 border-b border-edge bg-bg-panel px-2 py-1.5">
        <button onClick={goUp} className="tb-btn" title="Up">
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
        <div className="mx-2 flex min-w-0 flex-1 items-center gap-1.5 rounded bg-bg-base px-2 py-1 text-xs text-[#9aa7b6]">
          <HardDrive size={12} />
          <span className="truncate font-mono">{cwd}</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-bg-panel text-[11px] uppercase tracking-wide text-[#5f6b7a]">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Name</th>
              <th className="px-3 py-1.5 text-right font-medium">Size</th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr
                key={f.path}
                onDoubleClick={() => enter(f)}
                className="group cursor-default border-b border-edge/40 hover:bg-bg-hover"
              >
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-2">
                    {f.isDir ? (
                      <Folder size={15} color="#f0a54a" />
                    ) : (
                      <FileIcon size={15} color="#7c8896" />
                    )}
                    <span className="truncate">{f.name}</span>
                  </div>
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-xs text-[#7c8896]">
                  {f.isDir ? "—" : formatBytes(f.size)}
                </td>
                <td className="px-2">
                  {!f.isDir && (
                    <button
                      onClick={() => download(f)}
                      className="rounded p-1 text-[#7c8896] opacity-0 hover:bg-bg-elev hover:text-white group-hover:opacity-100"
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
      </div>

      <div className="border-t border-edge bg-bg-panel px-3 py-1 text-[11px] text-[#5f6b7a]">
        {msg || `${files.length} items`}
      </div>
    </div>
  );
}
