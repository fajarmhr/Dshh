import { useState } from "react";
import { KeyRound, X } from "lucide-react";
import { overlayDismiss } from "../lib/utils";

/**
 * Shown when a saved session is rejected by the server: the credential is
 * wrong, so ask for it again rather than leaving a dead tab whose only exit is
 * editing the connection by hand.
 *
 * "Save to this session" is on by default and only writes after the retry
 * actually succeeds — a second wrong password must not overwrite a working one
 * that merely expired in the user's memory.
 */
export function PasswordPrompt({
  title,
  target,
  error,
  /** "password" or "passphrase" — whichever the failing auth method needs. */
  kind,
  busy,
  onSubmit,
  onCancel,
}: {
  title: string;
  target: string;
  error: string;
  kind: "password" | "passphrase";
  busy: boolean;
  onSubmit: (secret: string, remember: boolean) => void;
  onCancel: () => void;
}) {
  const [secret, setSecret] = useState("");
  const [remember, setRemember] = useState(true);

  const submit = () => {
    if (!secret || busy) return;
    onSubmit(secret, remember);
  };

  return (
    <div className="modal-overlay" {...overlayDismiss(onCancel)}>
      <div className="modal-shell w-[440px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <div className="flex items-center gap-2">
            <KeyRound size={15} className="text-warn" />
            <h2 className="text-sm font-semibold text-ink-hi">{title}</h2>
          </div>
          <button onClick={onCancel} className="tb-btn">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="rounded-lg border border-err/40 bg-err/10 px-3 py-2 font-mono text-[11px] leading-relaxed text-err">
            {error}
          </div>

          <div>
            <label className="field-label">{kind} for {target}</label>
            <input
              autoFocus
              type="password"
              className="field-input font-mono"
              value={secret}
              placeholder={kind}
              disabled={busy}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") onCancel();
              }}
            />
          </div>

          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span className="text-sm text-ink-hi">
              Save to this session
              <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-dim">
                Replaces the stored {kind}, but only once this one connects. A
                master password, if set, encrypts it the same as the rest.
              </span>
            </span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-edge px-5 py-3">
          <button onClick={onCancel} className="btn-ghost" disabled={busy}>
            Cancel
          </button>
          <button onClick={submit} disabled={!secret || busy} className="btn-primary disabled:opacity-40">
            {busy ? "Connecting…" : "Retry"}
          </button>
        </div>
      </div>
    </div>
  );
}
