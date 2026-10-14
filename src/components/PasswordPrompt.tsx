import { useState } from "react";
import { KeyRound, X } from "lucide-react";
import { overlayDismiss } from "../lib/utils";

/**
 * Shown when a saved session is rejected by the server: the credential is
 * wrong or was never saved, so ask for it again rather than leaving a dead tab
 * whose only exit is editing the connection by hand.
 *
 * What is typed here is written back to the session once the server accepts it
 * — never before, so a second wrong guess can't overwrite a working password.
 * That write is a setting rather than a checkbox on this dialog: being asked at
 * all means the stored credential is wrong, and correcting it every time is
 * what people want. Settings › General turns it off. The dialog itself only
 * says the password was wrong — nothing about what is kept, or the server's
 * own wording.
 */
export function PasswordPrompt({
  title,
  target,
  /** "password" or "passphrase" — whichever the failing auth method needs. */
  kind,
  /** Ask for a username too: the session was saved without one. */
  needsUsername,
  busy,
  onSubmit,
  onCancel,
}: {
  title: string;
  target: string;
  kind: "password" | "passphrase";
  needsUsername: boolean;
  busy: boolean;
  onSubmit: (secret: string, username: string) => void;
  onCancel: () => void;
}) {
  const [secret, setSecret] = useState("");
  const [username, setUsername] = useState("");

  const ready = !!secret && (!needsUsername || !!username.trim());
  const submit = () => {
    if (!ready || busy) return;
    onSubmit(secret, username.trim());
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
            {needsUsername
              ? `Wrong username or ${kind} — enter them again.`
              : `Wrong ${kind} — enter it again.`}
          </div>

          {needsUsername && (
            <div>
              <label className="field-label">username for {target}</label>
              <input
                autoFocus
                className="field-input font-mono"
                value={username}
                placeholder="username"
                disabled={busy}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                  if (e.key === "Escape") onCancel();
                }}
              />
            </div>
          )}

          <div>
            <label className="field-label">
              {kind}
              {needsUsername ? "" : ` for ${target}`}
            </label>
            <input
              autoFocus={!needsUsername}
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
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-edge px-5 py-3">
          <button onClick={onCancel} className="btn-ghost" disabled={busy}>
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!ready || busy}
            className="btn-primary disabled:opacity-40"
          >
            {busy ? "Connecting…" : "Retry"}
          </button>
        </div>
      </div>
    </div>
  );
}
