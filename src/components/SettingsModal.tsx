import { X, FolderOpen } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useStore } from "../store";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);

  const pickDir = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (picked && !Array.isArray(picked)) setSettings({ logDir: picked });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[460px] rounded-xl border border-edge bg-bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="text-sm font-semibold">Settings</h2>
          <button onClick={onClose} className="tb-btn">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-widest text-[#5f6b7a]">
              Session logging
            </div>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={settings.autoLog}
                onChange={(e) => setSettings({ autoLog: e.target.checked })}
              />
              <span className="text-sm">
                Auto-log every session
                <span className="mt-0.5 block text-[11px] text-[#5f6b7a]">
                  Each SSH / serial session is recorded to a timestamped .log file
                  in the folder below, automatically on connect.
                </span>
              </span>
            </label>

            <div className="mt-2">
              <label className="field-label">Logs folder</label>
              <div className="flex gap-2">
                <input
                  className="field-input flex-1"
                  placeholder="Choose where logs are saved..."
                  value={settings.logDir}
                  onChange={(e) => setSettings({ logDir: e.target.value })}
                />
                <button
                  onClick={pickDir}
                  className="flex items-center gap-1.5 rounded-md border border-edge px-3 text-xs text-[#9aa7b6] hover:bg-bg-hover"
                >
                  <FolderOpen size={14} />
                  Browse
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-[#5f6b7a]">
                Also used as the default target for the per-tab{" "}
                <span className="text-[#9aa7b6]">Record</span> button. If empty,
                Record asks where to save each time.
              </p>
            </div>
          </div>
        </div>

        <div className="flex justify-end border-t border-edge px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
