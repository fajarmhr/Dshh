import { useEffect, useMemo, useState } from "react";
import { Link2, MonitorPlay, X } from "lucide-react";
import { useStore } from "../store";
import { clipboardRead } from "../lib/api";
import { parseConsoleLink } from "../lib/consoleLink";
import { overlayDismiss } from "../lib/utils";
import type { Connection } from "../lib/types";

/** Saved SSH connections a VNC session can be tunnelled through. */
export function useSshConnections(): Connection[] {
  const connections = useStore((s) => s.connections);
  return useMemo(
    () =>
      connections
        .filter((c) => c.protocol === "ssh" || c.protocol === "sftp")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [connections]
  );
}

function maskToken(token: string): string {
  return token.length <= 10 ? token : `${token.slice(0, 6)}…${token.slice(-4)}`;
}

/**
 * Open a VNC console straight from the link a cloud console hands out
 * (FusionSphere / OpenStack `vnc_auto.html?token=…`). Nothing is saved: the
 * token in the link expires within minutes, so the tab rides on a transient
 * connection.
 */
export function ConsoleLinkModal({ onClose }: { onClose: () => void }) {
  const openTransient = useStore((s) => s.openTransient);
  const sshConnections = useSshConnections();
  const [text, setText] = useState("");
  const [password, setPassword] = useState("");
  const [via, setVia] = useState("");
  const link = useMemo(() => parseConsoleLink(text), [text]);

  // Most of the time the link was just copied, so offer it straight away.
  useEffect(() => {
    clipboardRead()
      .then((clip) => {
        if (parseConsoleLink(clip)) setText((t) => t || clip.trim());
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const open = () => {
    if (!link) return;
    openTransient({
      name: link.name ?? link.host,
      protocol: "vnc",
      vncMode: "console",
      host: link.host,
      port: link.port,
      vncTls: link.tls,
      vncPath: link.path,
      vncToken: link.token,
      password: password || undefined,
      vncViaSsh: via || undefined,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" {...overlayDismiss(onClose)}>
      <div className="modal-shell w-[480px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <div className="flex items-center gap-2">
            <MonitorPlay size={15} className="text-proto-vnc" />
            <h2 className="text-sm font-semibold text-ink-hi">Open VNC console link</h2>
          </div>
          <button onClick={onClose} className="tb-btn">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="field-label">Console link</label>
            <textarea
              autoFocus
              rows={3}
              className="field-input resize-none break-all font-mono text-[12px] leading-relaxed"
              value={text}
              placeholder="https://proxy:8002/vnc_auto.html?token=…&name=VM"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  open();
                }
              }}
            />
            {text.trim() && !link ? (
              <p className="mt-1 text-[11px] text-err">
                Not a console link — it needs a <span className="font-mono">token=</span>{" "}
                parameter.
              </p>
            ) : (
              <p className="mt-1 text-[11px] leading-relaxed text-ink-dim">
                The link from your cloud console (FusionSphere, OpenStack). Tokens are
                short-lived, so open it soon after copying.
              </p>
            )}
          </div>

          {link && (
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-edge bg-bg-inset/60 px-3 py-2 font-mono text-[11px]">
              <span className="text-ink-dim">proxy</span>
              <span className="truncate text-ink-hi">
                {link.tls ? "https" : "http"}://{link.host}:{link.port}
              </span>
              {link.name && (
                <>
                  <span className="text-ink-dim">vm</span>
                  <span className="truncate text-ink-hi">{link.name}</span>
                </>
              )}
              <span className="text-ink-dim">token</span>
              <span className="truncate text-ink-mid">{maskToken(link.token)}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label">VNC password (optional)</label>
              <input
                type="password"
                className="field-input font-mono text-[13px]"
                value={password}
                placeholder="only if asked"
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label">Route through</label>
              <select
                className="field-input text-[13px]"
                value={via}
                onChange={(e) => setVia(e.target.value)}
              >
                <option value="">Direct</option>
                {sshConnections.map((c) => (
                  <option key={c.id} value={c.id}>
                    SSH · {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-edge px-5 py-3">
          <button onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button onClick={open} disabled={!link} className="btn-primary disabled:opacity-40">
            Open console
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Asked when a saved console connection opens: its token can't be saved, so
 * it is pasted fresh — either the bare token or the whole console link.
 */
export function ConsoleTokenPrompt({
  target,
  error,
  initial,
  onSubmit,
  onCancel,
}: {
  target: string;
  error?: string;
  initial: string;
  onSubmit: (input: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const link = parseConsoleLink(value);
  const ready = !!value.trim();
  const submit = () => ready && onSubmit(value.trim());

  return (
    <div className="modal-overlay" {...overlayDismiss(onCancel)}>
      <div className="modal-shell w-[460px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <div className="flex items-center gap-2">
            <Link2 size={15} className="text-proto-vnc" />
            <h2 className="text-sm font-semibold text-ink-hi">Console token</h2>
          </div>
          <button onClick={onCancel} className="tb-btn">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          {error && (
            <div className="rounded-lg border border-err/40 bg-err/10 px-3 py-2 font-mono text-[11px] leading-relaxed text-err">
              {error}
            </div>
          )}
          <div>
            <label className="field-label">token or console link for {target}</label>
            <input
              autoFocus
              className="field-input font-mono text-[12px]"
              value={value}
              placeholder="paste the link or just its token"
              onChange={(e) => setValue(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") onCancel();
              }}
            />
            <p className="mt-1 text-[11px] leading-relaxed text-ink-dim">
              {link
                ? `Link for ${link.host}:${link.port}${link.name ? ` · ${link.name}` : ""}`
                : "Tokens expire within minutes and are often single-use."}
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-edge px-5 py-3">
          <button onClick={onCancel} className="btn-ghost">
            Cancel
          </button>
          <button onClick={submit} disabled={!ready} className="btn-primary disabled:opacity-40">
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
