import { useEffect, useRef } from "react";
import { ClipboardPaste, X } from "lucide-react";
import { overlayDismiss } from "../lib/utils";

/** Lines rendered in the preview; a huge paste is summarised instead. */
const PREVIEW_LIMIT = 60;

/**
 * Confirmation for a multi-line paste, the way MobaXterm and PuTTY ask. Every
 * newline in the clipboard is an Enter as far as the shell is concerned, so a
 * stray copy runs commands rather than typing them — this shows exactly which
 * lines would run before any of them do.
 */
export function PasteConfirm({
  lines,
  onConfirm,
  onCancel,
}: {
  lines: string[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Enter reaches both this handler and the focused button's click, and a
  // double confirm would paste twice. One answer per dialog, whichever
  // route it arrives by.
  const settled = useRef(false);
  const confirm = () => {
    if (settled.current) return;
    settled.current = true;
    onConfirm();
  };
  const cancel = () => {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  };

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
      else if (e.key === "Enter") {
        // Suppresses the click the browser would synthesise on the focused
        // button, which would otherwise be a second confirm.
        e.preventDefault();
        confirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = lines.slice(0, PREVIEW_LIMIT);
  const hidden = lines.length - shown.length;

  return (
    <div className="modal-overlay" {...overlayDismiss(cancel)}>
      <div className="modal-shell w-[560px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-hi">
              <ClipboardPaste size={15} className="text-warn" />
              Paste {lines.length} lines?
            </h2>
            <div className="mt-0.5 font-mono text-[10.5px] text-ink-dim">
              each line ends with Enter — the shell will run them
            </div>
          </div>
          <button onClick={cancel} className="tb-btn" title="Cancel (Esc)">
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[46vh] overflow-y-auto px-5 py-3">
          <div className="rounded-md border border-edge bg-bg-inset">
            {shown.map((line, i) => (
              <div
                key={i}
                className="flex gap-3 px-3 py-[3px] font-mono text-[11.5px] leading-relaxed"
              >
                <span className="w-6 shrink-0 select-none text-right tabular-nums text-ink-dim">
                  {i + 1}
                </span>
                <span className="whitespace-pre-wrap break-all text-ink-hi">
                  {line || " "}
                </span>
              </div>
            ))}
            {hidden > 0 && (
              <div className="border-t border-edge px-3 py-1.5 font-mono text-[11px] text-ink-dim">
                … {hidden} more line{hidden === 1 ? "" : "s"}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-edge px-5 py-3">
          <span className="font-mono text-[10px] text-ink-dim">
            turn this off in Settings › Terminal
          </span>
          <div className="flex gap-2">
            <button onClick={cancel} className="btn-ghost">
              Cancel
            </button>
            <button ref={confirmRef} onClick={confirm} className="btn-primary">
              Paste
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
