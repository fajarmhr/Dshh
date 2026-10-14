import { useEffect, useState } from "react";
import { ClipboardPaste, Copy, Keyboard, Loader2, ScanText, X } from "lucide-react";
import { overlayDismiss } from "../lib/utils";

/** Longest text typing accepts — `MAX_TYPED` in vnc/mod.rs. */
const MAX_TYPED = 10_000;

/** Characters typing has no US-keyboard key for, each listed once. */
const untypable = (text: string) => [
  ...new Set([...text].filter((c) => !/[\x20-\x7e\r\n\t]/.test(c))),
];

const describe = (c: string) =>
  c.trim() ? c : `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

/**
 * Review, and edit, text before it goes to the remote machine — prefilled
 * with the local clipboard. Typing presses keys, which every console takes;
 * "Send as clipboard" only reaches VNC servers that share a clipboard.
 */
export function VncPasteDialog({
  initial,
  target,
  onType,
  onSendClipboard,
  onCancel,
}: {
  initial: string;
  target: string;
  onType: (text: string) => void;
  onSendClipboard: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const chars = [...text].length;
  const enters = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  const odd = untypable(text);
  const tooLong = chars > MAX_TYPED;
  const canType = chars > 0 && !tooLong;

  return (
    <div className="modal-overlay" {...overlayDismiss(onCancel)}>
      <div className="modal-shell w-[600px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <div className="flex items-center gap-2">
            <ClipboardPaste size={15} className="text-proto-vnc" />
            <h2 className="text-sm font-semibold text-ink-hi">Send text to {target}</h2>
          </div>
          <button onClick={onCancel} className="tb-btn" title="Cancel (Esc)">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-2 px-5 py-4">
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancel();
              else if (e.key === "Enter" && e.ctrlKey) {
                e.preventDefault();
                if (canType) onType(text);
              }
            }}
            spellCheck={false}
            rows={10}
            placeholder="Nothing on the clipboard — type or paste the text to send"
            className="field-input min-h-[160px] resize-y whitespace-pre font-mono text-[12px] leading-relaxed"
          />
          <div className="space-y-1 font-mono text-[10.5px] leading-relaxed text-ink-dim">
            <p>
              {chars.toLocaleString()} characters
              {enters > 0 && (
                <span className="text-warn">
                  {" "}
                  · {enters} line break{enters === 1 ? "" : "s"} — each is pressed as Enter
                </span>
              )}
              {tooLong && (
                <span className="text-err"> · too long to type (limit {MAX_TYPED.toLocaleString()})</span>
              )}
            </p>
            {odd.length > 0 && (
              <p className="text-warn">
                No US-keyboard key for {odd.slice(0, 8).map(describe).join(" ")}
                {odd.length > 8 ? " …" : ""} — typing may drop {odd.length === 1 ? "it" : "them"}
              </p>
            )}
            <p>Typed on a US keyboard layout · Ctrl+Enter types it</p>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-edge px-5 py-3">
          <button
            onClick={() => onSendClipboard(text)}
            disabled={!chars}
            className="btn-ghost disabled:opacity-40"
            title="Put the text on the remote clipboard instead of typing it. Only VNC servers that share a clipboard take it — most VM consoles don't."
          >
            Send as clipboard
          </button>
          <div className="ml-auto flex gap-2">
            <button onClick={onCancel} className="btn-ghost">
              Cancel
            </button>
            <button
              onClick={() => onType(text)}
              disabled={!canType}
              className="btn-primary flex items-center gap-1.5 disabled:opacity-40"
            >
              <Keyboard size={14} />
              Type it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Text read off a selected part of the remote screen, to check and edit
 * before it goes on the local clipboard. `text` is `null` while reading.
 */
export function VncCopyDialog({
  text: read,
  error,
  onCopy,
  onReselect,
  onCancel,
}: {
  text: string | null;
  error?: string;
  onCopy: (text: string) => void;
  onReselect: () => void;
  onCancel: () => void;
}) {
  // The editable copy; seeded once the reading lands.
  const [edited, setEdited] = useState<string | null>(null);
  const text = edited ?? read ?? "";
  const busy = read === null && !error;

  // While it's reading nothing has focus, so Esc is caught here rather than
  // by the textarea.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-overlay" {...overlayDismiss(onCancel)}>
      <div className="modal-shell w-[600px] max-w-[92vw]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <div className="flex items-center gap-2">
            <ScanText size={15} className="text-proto-vnc" />
            <h2 className="text-sm font-semibold text-ink-hi">Text from the screen</h2>
          </div>
          <button onClick={onCancel} className="tb-btn" title="Cancel (Esc)">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-2 px-5 py-4">
          {error ? (
            <div className="rounded-lg border border-err/40 bg-err/10 px-3 py-2 font-mono text-[11px] leading-relaxed text-err">
              {error}
            </div>
          ) : busy ? (
            <div className="flex min-h-[160px] items-center justify-center gap-2 font-mono text-[11px] text-ink-dim">
              <Loader2 size={14} className="animate-spin" />
              reading text…
            </div>
          ) : (
            <>
              <textarea
                autoFocus
                value={text}
                onChange={(e) => setEdited(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.ctrlKey) {
                    e.preventDefault();
                    if (text) onCopy(text);
                  }
                }}
                spellCheck={false}
                rows={10}
                placeholder="No text found in that area"
                className="field-input min-h-[160px] resize-y whitespace-pre font-mono text-[12px] leading-relaxed"
              />
              <p className="font-mono text-[10.5px] leading-relaxed text-ink-dim">
                Read by Windows&apos; text recognition — check it before use: 0/O, 1/l/I and
                spacing are easy to get wrong. Ctrl+Enter copies.
              </p>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-edge px-5 py-3">
          <button onClick={onReselect} className="btn-ghost" disabled={busy}>
            Select again
          </button>
          <div className="ml-auto flex gap-2">
            <button onClick={onCancel} className="btn-ghost">
              Cancel
            </button>
            <button
              onClick={() => onCopy(text)}
              disabled={busy || !text}
              className="btn-primary flex items-center gap-1.5 disabled:opacity-40"
            >
              <Copy size={14} />
              Copy
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
