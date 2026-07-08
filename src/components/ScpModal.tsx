import { useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, X } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { scpUpload, scpDownload } from "../lib/api";
import type { Connection } from "../lib/types";

/**
 * SCP file transfer for one SSH connection. Each transfer opens its own SSH
 * session and copies a single file (no directory recursion). Handy for hosts
 * where the SFTP subsystem is disabled but `scp` still works.
 */
export function ScpModal({
  conn,
  onClose,
}: {
  conn: Connection;
  onClose: () => void;
}) {
  const [localUp, setLocalUp] = useState("");
  const [remoteUp, setRemoteUp] = useState("");
  const [remoteDown, setRemoteDown] = useState("");
  const [busy, setBusy] = useState<null | "up" | "down">(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const pickLocal = async () => {
    const picked = await openDialog({ multiple: false });
    if (picked && !Array.isArray(picked)) {
      setLocalUp(picked);
      if (!remoteUp.trim()) setRemoteUp(picked.split(/[\\/]/).pop() ?? "");
    }
  };

  const doUpload = async () => {
    if (!localUp || !remoteUp.trim() || busy) return;
    setBusy("up");
    setError("");
    setMsg("Uploading…");
    try {
      await scpUpload(conn, localUp, remoteUp.trim());
      setMsg(`Uploaded to ${remoteUp.trim()}`);
    } catch (e) {
      setError(String(e));
      setMsg("");
    } finally {
      setBusy(null);
    }
  };

  const doDownload = async () => {
    if (!remoteDown.trim() || busy) return;
    const name = remoteDown.trim().split("/").pop() || "download";
    const local = await saveDialog({ defaultPath: name });
    if (!local) return;
    setBusy("down");
    setError("");
    setMsg("Downloading…");
    try {
      await scpDownload(conn, remoteDown.trim(), local);
      setMsg(`Downloaded to ${local}`);
    } catch (e) {
      setError(String(e));
      setMsg("");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-shell w-[560px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-ink-hi">SCP transfer</h2>
            <div className="mt-0.5 font-mono text-[10.5px] text-ink-dim">
              {conn.username ? `${conn.username}@` : ""}
              {conn.host} · file copy over SSH
            </div>
          </div>
          <button onClick={onClose} className="tb-btn">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          <div className="space-y-2">
            <div className="micro-label flex items-center gap-1.5">
              <ArrowUpFromLine size={12} /> Upload to server
            </div>
            <div className="flex gap-2">
              <input
                className="field-input flex-1 cursor-pointer font-mono text-[12.5px]"
                value={localUp}
                placeholder="click to choose a local file…"
                readOnly
                onClick={pickLocal}
              />
              <button
                onClick={pickLocal}
                className="rounded-md border border-edge px-3 text-xs text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi"
              >
                Browse
              </button>
            </div>
            <div className="flex gap-2">
              <input
                className="field-input flex-1 font-mono text-[12.5px]"
                value={remoteUp}
                placeholder="remote path — /home/user/file or ./file"
                onChange={(e) => setRemoteUp(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doUpload()}
              />
              <button
                onClick={doUpload}
                disabled={!localUp || !remoteUp.trim() || busy !== null}
                className="btn-primary disabled:pointer-events-none disabled:opacity-40"
              >
                {busy === "up" ? "…" : "Upload"}
              </button>
            </div>
          </div>

          <div className="h-px bg-edge" />

          <div className="space-y-2">
            <div className="micro-label flex items-center gap-1.5">
              <ArrowDownToLine size={12} /> Download from server
            </div>
            <div className="flex gap-2">
              <input
                className="field-input flex-1 font-mono text-[12.5px]"
                value={remoteDown}
                placeholder="remote path — /var/log/syslog"
                onChange={(e) => setRemoteDown(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doDownload()}
              />
              <button
                onClick={doDownload}
                disabled={!remoteDown.trim() || busy !== null}
                className="btn-primary disabled:pointer-events-none disabled:opacity-40"
              >
                {busy === "down" ? "…" : "Download"}
              </button>
            </div>
          </div>

          {msg && !error && (
            <div className="rounded-md border border-edge bg-bg-elev px-3 py-2 font-mono text-[11px] text-ink-mid">
              {msg}
            </div>
          )}
          {error && (
            <div className="rounded-md border border-err/40 bg-err/10 px-3 py-2 font-mono text-[11px] text-err">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-edge px-5 py-3">
          <span className="font-mono text-[10px] text-ink-dim">
            single files · recursive directories not supported
          </span>
          <button onClick={onClose} className="btn-ghost">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
