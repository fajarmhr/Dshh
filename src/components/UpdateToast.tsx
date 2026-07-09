import { useEffect, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import {
  openUrl,
  updateApply,
  updateCheck,
  updateRestart,
  type UpdateInfo,
} from "../lib/api";

type Phase = "idle" | "downloading" | "ready" | "error";

/**
 * Silent startup update check. Shows a small bottom-right toast only when a
 * newer GitHub release exists; downloading swaps the portable exe in place,
 * then a restart loads the new version.
 */
export function UpdateToast() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    updateCheck()
      .then((i) => {
        if (i.updateAvailable) setInfo(i);
      })
      .catch(() => {
        /* offline or rate-limited — check again next launch */
      });
  }, []);

  if (!info || dismissed) return null;

  const install = async () => {
    if (!info.assetUrl) {
      // Release has no portable asset — send the user to the release page.
      openUrl(info.releaseUrl).catch(() => {});
      return;
    }
    setPhase("downloading");
    setError("");
    try {
      await updateApply(info.assetUrl);
      setPhase("ready");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[340px] rounded-lg border border-edge bg-bg-elev p-4 shadow-xl">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold text-ink-hi">
          {phase === "ready"
            ? "Update installed"
            : `Update available — v${info.latest}`}
        </div>
        <button onClick={() => setDismissed(true)} className="tb-btn" title="Dismiss">
          <X size={14} />
        </button>
      </div>

      {phase !== "ready" && (
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink-dim">
          You are on v{info.current}. The new version replaces this portable exe
          in place.
        </p>
      )}
      {phase === "ready" && (
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink-dim">
          v{info.latest} is staged — restart to start using it.
        </p>
      )}
      {error && (
        <p className="mt-1.5 rounded-md border border-err/40 bg-err/10 px-2 py-1.5 font-mono text-[10.5px] text-err">
          {error}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        {phase === "ready" ? (
          <button onClick={() => updateRestart()} className="btn-primary flex items-center gap-1.5">
            <RefreshCw size={13} /> Restart now
          </button>
        ) : (
          <button
            onClick={install}
            disabled={phase === "downloading"}
            className="btn-primary flex items-center gap-1.5 disabled:pointer-events-none disabled:opacity-40"
          >
            <Download size={13} />
            {phase === "downloading" ? "Downloading…" : "Download & install"}
          </button>
        )}
        <button
          onClick={() => openUrl(info.releaseUrl).catch(() => {})}
          className="btn-ghost text-xs"
        >
          Release notes
        </button>
      </div>
    </div>
  );
}
