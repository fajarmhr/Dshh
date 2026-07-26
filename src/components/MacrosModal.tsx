import { useState } from "react";
import { ChevronDown, ChevronRight, Play, Trash2, X } from "lucide-react";
import { useStore } from "../store";
import { sendMacro } from "../lib/terminalRegistry";
import { cn, overlayDismiss } from "../lib/utils";

/**
 * Recorded macros (MobaXterm's macro recorder). Quick commands are the one-shot
 * version; a macro is a sequence, replayed a step at a time into one terminal.
 *
 * Recording itself starts from a terminal's toolbar, because a macro captures
 * what you type in a specific session.
 */
export function MacrosModal({
  onClose,
  runTarget,
}: {
  onClose: () => void;
  /** Session that "run" replays into, or null when no terminal is connected. */
  runTarget: string | null;
}) {
  const macros = useStore((s) => s.macros);
  const updateMacro = useStore((s) => s.updateMacro);
  const removeMacro = useStore((s) => s.removeMacro);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="modal-overlay" {...overlayDismiss(onClose)}>
      <div className="modal-shell w-[580px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-ink-hi">Macros</h2>
            <div className="mt-0.5 font-mono text-[10.5px] text-ink-dim">
              recorded command sequences · replayed one step at a time
            </div>
          </div>
          <button onClick={onClose} className="tb-btn">
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto px-5 py-4">
          {macros.length === 0 && (
            <div className="rounded-lg border border-dashed border-edge-bright px-4 py-5 font-mono text-[11px] leading-relaxed text-ink-dim">
              no macros yet — press{" "}
              <span className="text-ink-mid">Macro</span> in a terminal's toolbar to
              start recording, then run the commands you want captured. Stopping
              the recording saves them here.
            </div>
          )}

          {macros.map((m) => {
            const open = expanded === m.id;
            return (
              <div
                key={m.id}
                className="rounded-lg border border-edge bg-bg-elev px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setExpanded(open ? null : m.id)}
                    className="shrink-0 rounded p-0.5 text-ink-dim transition hover:text-ink-hi"
                    title={open ? "Hide steps" : "Show steps"}
                  >
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <input
                    className="field-input min-w-0 flex-1"
                    value={m.label}
                    placeholder="label"
                    onChange={(e) => updateMacro(m.id, { label: e.target.value })}
                  />
                  <span className="shrink-0 font-mono text-[10px] text-ink-dim">
                    {m.steps.length} step{m.steps.length === 1 ? "" : "s"}
                  </span>
                  <button
                    onClick={() => runTarget && sendMacro(runTarget, m.steps)}
                    disabled={!runTarget}
                    className={cn(
                      "flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition active:scale-[0.97]",
                      "border-edge text-ink-mid hover:border-accent/50 hover:text-ink-hi",
                      "disabled:pointer-events-none disabled:opacity-30"
                    )}
                    title={
                      runTarget
                        ? "Replay into the active terminal"
                        : "Connect a terminal to replay a macro"
                    }
                  >
                    <Play size={10} />
                    run
                  </button>
                  <button
                    onClick={() => removeMacro(m.id)}
                    className="shrink-0 rounded p-1.5 text-ink-dim transition hover:bg-bg-hover hover:text-err"
                    title="Delete macro"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {open && (
                  <ol className="mt-2 space-y-0.5 border-t border-edge pl-6 pt-2 font-mono text-[11.5px] text-ink-mid">
                    {m.steps.map((step, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="w-4 shrink-0 text-right text-ink-dim">
                          {i + 1}
                        </span>
                        <span className="min-w-0 break-all">{step}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-edge px-5 py-3">
          <span className="font-mono text-[10px] text-ink-dim">
            steps are paced 250 ms apart so the shell keeps up
          </span>
          <button onClick={onClose} className="btn-primary">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
