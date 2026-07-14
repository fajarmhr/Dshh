import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Folder, Monitor, RefreshCw } from "lucide-react";
import { localFsHome, localFsList } from "../lib/api";
import { FileTypeIcon } from "../lib/fileIcons";
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

  const list = useCallback(async (path: string) => {
    setBusy(true);
    try {
      const entries = await localFsList(path);
      entries.sort((a, b) =>
        a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
      );
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
        <div className="mx-2 flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-edge bg-bg-inset px-2 text-ink-mid">
          <Monitor size={11} className="shrink-0 text-ink-dim" />
          <span className="truncate font-mono text-[11px]">{cwd || "This PC"}</span>
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
                <th className="px-3 py-2 text-left font-medium">local</th>
                <th className="px-3 py-2 text-right font-medium">size</th>
                <th className="px-3 py-2 text-right font-medium">modified</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr
                  key={f.path}
                  onDoubleClick={() => f.isDir && list(f.path)}
                  draggable={!f.isDir}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      LOCAL_MIME,
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
                  <td className="px-3 py-1.5 text-right font-mono text-[11px] text-ink-mid">
                    {f.isDir ? "—" : formatBytes(f.size)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-[11px] text-ink-dim">
                    {formatDate(f.modified)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex h-7 shrink-0 items-center border-t border-edge bg-bg-panel px-3">
        <span className="truncate font-mono text-[10.5px] text-ink-dim">
          {msg || `${files.length} items · drag onto the remote pane to upload`}
        </span>
      </div>
    </div>
  );
}
