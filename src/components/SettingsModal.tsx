import { Database, FolderOpen, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { nanoid } from "nanoid";
import { useStore, adoptSessionsDir } from "../store";
import {
  appVersion,
  openUrl,
  updateApply,
  updateCheck,
  updateRestart,
  type UpdateInfo,
} from "../lib/api";
import type { HighlightColor, HighlightRule } from "../lib/types";

const HL_COLORS: Record<HighlightColor, string> = {
  red: "#f26d78",
  yellow: "#e8a54c",
  green: "#3ecf8e",
  blue: "#5b8cff",
  magenta: "#b78af7",
  cyan: "#4cc9e8",
};

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [newPattern, setNewPattern] = useState("");
  const [newColor, setNewColor] = useState<HighlightColor>("red");
  const [sessionsNote, setSessionsNote] = useState("");

  const [version, setVersion] = useState("");
  const [updState, setUpdState] = useState<
    "idle" | "checking" | "none" | "found" | "downloading" | "ready" | "error"
  >("idle");
  const [updInfo, setUpdInfo] = useState<UpdateInfo | null>(null);
  const [updError, setUpdError] = useState("");

  useEffect(() => {
    appVersion().then(setVersion).catch(() => {});
  }, []);

  const checkUpdates = async () => {
    setUpdState("checking");
    setUpdError("");
    try {
      const info = await updateCheck();
      setUpdInfo(info);
      setUpdState(info.updateAvailable ? "found" : "none");
    } catch (e) {
      setUpdError(String(e));
      setUpdState("error");
    }
  };

  const installUpdate = async () => {
    if (!updInfo) return;
    if (!updInfo.assetUrl) {
      openUrl(updInfo.releaseUrl).catch(() => {});
      return;
    }
    setUpdState("downloading");
    setUpdError("");
    try {
      await updateApply(updInfo.assetUrl);
      setUpdState("ready");
    } catch (e) {
      setUpdError(String(e));
      setUpdState("error");
    }
  };

  const pickDir = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (picked && !Array.isArray(picked)) setSettings({ logDir: picked });
  };

  const applySessionsDir = async (dir: string) => {
    const clean = dir.trim();
    setSettings({ sessionsDir: clean });
    if (!clean) {
      setSessionsNote("");
      return;
    }
    try {
      const loaded = await adoptSessionsDir(clean);
      setSessionsNote(
        loaded
          ? "Loaded saved sessions from this folder."
          : "Folder adopted — your sessions are now mirrored there."
      );
    } catch (e) {
      setSessionsNote(`Could not use folder: ${String(e)}`);
    }
  };

  const pickSessionsDir = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (picked && !Array.isArray(picked)) await applySessionsDir(picked);
  };

  const setRules = (highlightRules: HighlightRule[]) => setSettings({ highlightRules });

  const addRule = () => {
    if (!newPattern.trim()) return;
    setRules([
      ...settings.highlightRules,
      { id: nanoid(), pattern: newPattern.trim(), color: newColor },
    ]);
    setNewPattern("");
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-shell w-[480px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="text-sm font-semibold text-ink-hi">Settings</h2>
          <button onClick={onClose} className="tb-btn">
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-6 overflow-y-auto px-5 py-4">
          <div>
            <div className="micro-label mb-2">Updates</div>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm text-ink-hi">
                Dshh {version ? `v${version}` : ""}
                <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-dim">
                  {updState === "none" && "You are on the latest version."}
                  {updState === "found" && updInfo && `v${updInfo.latest} is available.`}
                  {updState === "ready" && "Update staged — restart to apply."}
                  {(updState === "idle" || updState === "checking") &&
                    "Checked automatically at startup; new versions show a notification."}
                  {updState === "downloading" && "Downloading update…"}
                  {updState === "error" && "Update failed."}
                </span>
              </div>
              {updState === "found" || updState === "downloading" ? (
                <button
                  onClick={installUpdate}
                  disabled={updState === "downloading"}
                  className="btn-primary shrink-0 disabled:pointer-events-none disabled:opacity-40"
                >
                  {updState === "downloading" ? "Downloading…" : "Install"}
                </button>
              ) : updState === "ready" ? (
                <button onClick={() => updateRestart()} className="btn-primary shrink-0">
                  Restart now
                </button>
              ) : (
                <button
                  onClick={checkUpdates}
                  disabled={updState === "checking"}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-xs text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi disabled:pointer-events-none disabled:opacity-40"
                >
                  <RefreshCw size={13} className={updState === "checking" ? "animate-spin" : ""} />
                  {updState === "checking" ? "Checking…" : "Check for updates"}
                </button>
              )}
            </div>
            {updError && (
              <p className="mt-1.5 rounded-md border border-err/40 bg-err/10 px-2 py-1.5 font-mono text-[10.5px] text-err">
                {updError}
              </p>
            )}
          </div>

          <div>
            <div className="micro-label mb-2">Saved sessions</div>
            <label className="field-label">Sessions folder (optional)</label>
            <div className="flex gap-2">
              <input
                className="field-input flex-1 font-mono text-[12.5px]"
                placeholder="Keep in app storage only"
                value={settings.sessionsDir}
                onChange={(e) => setSettings({ sessionsDir: e.target.value })}
                onBlur={(e) => applySessionsDir(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" && applySessionsDir(settings.sessionsDir)
                }
              />
              <button
                onClick={pickSessionsDir}
                className="flex items-center gap-1.5 rounded-md border border-edge px-3 text-xs text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi"
              >
                <Database size={14} />
                Browse
              </button>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-dim">
              Saved connections are mirrored to{" "}
              <span className="font-mono text-ink-mid">connections.json</span> in this
              folder — handy for backups or syncing between machines. If the folder
              already contains one, it is loaded and replaces the current list.
              Passwords stored there are plain text, so pick a private location.
            </p>
            {sessionsNote && (
              <p className="mt-1.5 font-mono text-[11px] text-accent">{sessionsNote}</p>
            )}
          </div>

          <div>
            <div className="micro-label mb-2">Session logging</div>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={settings.autoLog}
                onChange={(e) => setSettings({ autoLog: e.target.checked })}
              />
              <span className="text-sm text-ink-hi">
                Auto-log every session
                <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-dim">
                  Each SSH / serial session is recorded to a timestamped .log file
                  in the folder below, automatically on connect.
                </span>
              </span>
            </label>

            <div className="mt-2">
              <label className="field-label">Logs folder</label>
              <div className="flex gap-2">
                <input
                  className="field-input flex-1 font-mono text-[12.5px]"
                  placeholder="Choose where logs are saved…"
                  value={settings.logDir}
                  onChange={(e) => setSettings({ logDir: e.target.value })}
                />
                <button
                  onClick={pickDir}
                  className="flex items-center gap-1.5 rounded-md border border-edge px-3 text-xs text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi"
                >
                  <FolderOpen size={14} />
                  Browse
                </button>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-dim">
                Also used as the default target for the per-tab{" "}
                <span className="text-ink-mid">Record</span> button. If empty,
                Record asks where to save each time.
              </p>
            </div>
          </div>

          <div>
            <div className="micro-label mb-2">Output highlighting</div>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={settings.highlightEnabled}
                onChange={(e) => setSettings({ highlightEnabled: e.target.checked })}
              />
              <span className="text-sm text-ink-hi">
                Colorize keywords in terminal output
                <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-dim">
                  Case-insensitive. Applied live to SSH and serial output, like
                  XShell highlight sets.
                </span>
              </span>
            </label>

            <div
              className={`mt-1 space-y-1.5 ${
                settings.highlightEnabled ? "" : "pointer-events-none opacity-40"
              }`}
            >
              {settings.highlightRules.map((r) => (
                <div key={r.id} className="flex items-center gap-2">
                  <select
                    value={r.color}
                    onChange={(e) =>
                      setRules(
                        settings.highlightRules.map((x) =>
                          x.id === r.id
                            ? { ...x, color: e.target.value as HighlightColor }
                            : x
                        )
                      )
                    }
                    className="w-28 rounded-md border border-edge bg-bg-inset px-2 py-1.5 font-mono text-[11px] outline-none transition focus:border-accent/60"
                    style={{ color: HL_COLORS[r.color] }}
                  >
                    {(Object.keys(HL_COLORS) as HighlightColor[]).map((c) => (
                      <option key={c} value={c} style={{ color: HL_COLORS[c] }}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <input
                    className="field-input flex-1 !py-1.5 font-mono text-[12px]"
                    value={r.pattern}
                    onChange={(e) =>
                      setRules(
                        settings.highlightRules.map((x) =>
                          x.id === r.id ? { ...x, pattern: e.target.value } : x
                        )
                      )
                    }
                  />
                  <button
                    onClick={() =>
                      setRules(settings.highlightRules.filter((x) => x.id !== r.id))
                    }
                    className="rounded p-1.5 text-ink-dim transition hover:bg-bg-hover hover:text-err"
                    title="Remove rule"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}

              <div className="flex items-center gap-2 pt-1">
                <select
                  value={newColor}
                  onChange={(e) => setNewColor(e.target.value as HighlightColor)}
                  className="w-28 rounded-md border border-edge bg-bg-inset px-2 py-1.5 font-mono text-[11px] outline-none transition focus:border-accent/60"
                  style={{ color: HL_COLORS[newColor] }}
                >
                  {(Object.keys(HL_COLORS) as HighlightColor[]).map((c) => (
                    <option key={c} value={c} style={{ color: HL_COLORS[c] }}>
                      {c}
                    </option>
                  ))}
                </select>
                <input
                  className="field-input flex-1 !py-1.5 font-mono text-[12px]"
                  placeholder="keyword, e.g. timeout"
                  value={newPattern}
                  onChange={(e) => setNewPattern(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addRule()}
                />
                <button
                  onClick={addRule}
                  disabled={!newPattern.trim()}
                  className="rounded-md border border-edge p-1.5 text-ink-mid transition hover:border-accent/50 hover:text-ink-hi active:scale-[0.97] disabled:pointer-events-none disabled:opacity-30"
                  title="Add rule"
                >
                  <Plus size={13} />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end border-t border-edge px-5 py-3">
          <button onClick={onClose} className="btn-primary">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
