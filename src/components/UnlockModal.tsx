import { useState } from "react";
import { Lock } from "lucide-react";
import { unlockMaster, useStore } from "../store";

/**
 * Startup gate shown while a master password is set but not yet entered.
 * Skipping keeps the app usable, but saved passwords stay encrypted, so
 * protected sessions won't authenticate until unlocked (Settings → Security).
 */
export function UnlockModal() {
  const masterLocked = useStore((s) => s.masterLocked);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [skipped, setSkipped] = useState(false);

  if (!masterLocked || skipped) return null;

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      const ok = await unlockMaster(password);
      if (!ok) setError("Wrong master password.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setPassword("");
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-shell w-[380px]">
        <div className="flex items-center gap-2.5 border-b border-edge px-5 py-3">
          <Lock size={15} className="text-accent" />
          <h2 className="text-sm font-semibold text-ink-hi">Unlock Dshh</h2>
        </div>
        <div className="space-y-3 px-5 py-4">
          <p className="text-[11.5px] leading-relaxed text-ink-dim">
            Saved connection passwords are encrypted. Enter your master password
            to use them this session.
          </p>
          <input
            type="password"
            autoFocus
            className="field-input w-full font-mono text-[12.5px]"
            placeholder="master password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          {error && (
            <div className="rounded-md border border-err/40 bg-err/10 px-3 py-2 font-mono text-[11px] text-err">
              {error}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-edge px-5 py-3">
          <button
            onClick={() => setSkipped(true)}
            className="btn-ghost text-xs"
            title="Continue without decrypting saved passwords"
          >
            Skip for now
          </button>
          <button
            onClick={submit}
            disabled={!password || busy}
            className="btn-primary disabled:pointer-events-none disabled:opacity-40"
          >
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </div>
      </div>
    </div>
  );
}
