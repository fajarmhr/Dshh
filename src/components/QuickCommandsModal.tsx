import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { useStore } from "../store";

export function QuickCommandsModal({ onClose }: { onClose: () => void }) {
  const quickCommands = useStore((s) => s.quickCommands);
  const addQuickCommand = useStore((s) => s.addQuickCommand);
  const updateQuickCommand = useStore((s) => s.updateQuickCommand);
  const removeQuickCommand = useStore((s) => s.removeQuickCommand);

  const [label, setLabel] = useState("");
  const [command, setCommand] = useState("");

  const add = () => {
    if (!command.trim()) return;
    addQuickCommand(label, command);
    setLabel("");
    setCommand("");
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-shell w-[560px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="text-sm font-semibold text-ink-hi">Quick commands</h2>
          <button onClick={onClose} className="tb-btn">
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto px-5 py-4">
          {quickCommands.length === 0 && (
            <div className="rounded-lg border border-dashed border-edge-bright px-4 py-5 font-mono text-[11px] leading-relaxed text-ink-dim">
              no quick commands yet — each one becomes a chip above the compose
              bar. one click sends it to the terminal.
            </div>
          )}

          {quickCommands.map((q) => (
            <div key={q.id} className="flex items-center gap-2">
              <input
                className="field-input w-36 shrink-0"
                value={q.label}
                placeholder="label"
                onChange={(e) => updateQuickCommand(q.id, { label: e.target.value })}
              />
              <input
                className="field-input flex-1 font-mono text-[12.5px]"
                value={q.command}
                placeholder="command"
                onChange={(e) =>
                  updateQuickCommand(q.id, { command: e.target.value })
                }
              />
              <button
                onClick={() => removeQuickCommand(q.id)}
                className="rounded p-1.5 text-ink-dim transition hover:bg-bg-hover hover:text-err"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}

          <div className="flex items-center gap-2 border-t border-edge pt-3">
            <input
              className="field-input w-36 shrink-0"
              value={label}
              placeholder="label"
              onChange={(e) => setLabel(e.target.value)}
            />
            <input
              className="field-input flex-1 font-mono text-[12.5px]"
              value={command}
              placeholder="e.g. tail -f /var/log/syslog"
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <button
              onClick={add}
              disabled={!command.trim()}
              className="rounded-md border border-edge p-1.5 text-ink-mid transition hover:border-accent/50 hover:text-ink-hi active:scale-[0.97] disabled:pointer-events-none disabled:opacity-30"
              title="Add quick command"
            >
              <Plus size={14} />
            </button>
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
