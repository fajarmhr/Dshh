import { useEffect, useRef, useState } from "react";
import { CornerDownLeft, Pencil, RadioTower, Zap } from "lucide-react";
import { useStore } from "../store";
import {
  broadcastToTerminals,
  getTerminal,
} from "../lib/terminalRegistry";
import { cn } from "../lib/utils";
import { QuickCommandsModal } from "./QuickCommandsModal";

/**
 * Bottom dock under the workspace: XShell-style quick command chips plus a
 * compose bar that sends a line to the active terminal or broadcasts it to
 * every connected terminal session.
 */
export function BottomDock() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  const quickCommands = useStore((s) => s.quickCommands);

  const [text, setText] = useState("");
  const [broadcast, setBroadcast] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const terminalSessions = sessions.filter(
    (s) => s.protocol === "ssh" || s.protocol === "serial"
  );
  const connectedIds = terminalSessions
    .filter((s) => s.status === "connected")
    .map((s) => s.id);
  const active = sessions.find((s) => s.id === activeId);
  const activeIsTerminal =
    !!active &&
    (active.protocol === "ssh" || active.protocol === "serial") &&
    active.status === "connected";

  // Ctrl+K focuses the compose bar from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (terminalSessions.length === 0) return null;

  const canSend = broadcast ? connectedIds.length > 0 : activeIsTerminal;

  const deliver = (command: string) => {
    const payload = command + "\r";
    if (broadcast) {
      broadcastToTerminals(connectedIds, payload);
    } else if (active && activeIsTerminal) {
      getTerminal(active.id)?.send(payload);
      getTerminal(active.id)?.focus();
    }
  };

  const sendCompose = () => {
    const line = text.trim();
    if (!line || !canSend) return;
    deliver(text);
    setHistory((h) => [line, ...h.filter((x) => x !== line)].slice(0, 100));
    setHistIdx(-1);
    setText("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      sendCompose();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(histIdx + 1, history.length - 1);
      if (history[next]) {
        setHistIdx(next);
        setText(history[next]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = histIdx - 1;
      setHistIdx(Math.max(next, -1));
      setText(next >= 0 ? history[next] : "");
    }
  };

  return (
    <div className="shrink-0 border-t border-edge bg-bg-panel">
      <div className="flex flex-wrap items-center gap-1 px-2 pt-1.5">
        <Zap size={11} className="mx-1 shrink-0 text-ink-dim" />
        {quickCommands.map((q) => (
          <button
            key={q.id}
            disabled={!canSend}
            onClick={(e) => {
              if (e.altKey) {
                setText(q.command);
                inputRef.current?.focus();
              } else {
                deliver(q.command);
              }
            }}
            className="rounded border border-edge bg-bg-elev px-2 py-0.5 font-mono text-[11px] text-ink-mid transition hover:border-accent/50 hover:text-ink-hi active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
            title={`${q.command}\nclick: send · alt+click: edit before sending`}
          >
            {q.label}
          </button>
        ))}
        {quickCommands.length === 0 && (
          <span className="font-mono text-[10.5px] text-ink-dim">
            quick commands — one click sends to the terminal
          </span>
        )}
        <button
          onClick={() => setManageOpen(true)}
          className="rounded p-1 text-ink-dim transition hover:bg-bg-hover hover:text-ink-hi"
          title="Manage quick commands"
        >
          <Pencil size={11} />
        </button>
      </div>

      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          onClick={() => setBroadcast((b) => !b)}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider transition active:scale-[0.97]",
            broadcast
              ? "border-warn/50 bg-warn/10 text-warn"
              : "border-edge text-ink-dim hover:border-edge-bright hover:text-ink-mid"
          )}
          title={
            broadcast
              ? "Broadcast ON — sends to every connected terminal"
              : "Broadcast OFF — sends to the active terminal only"
          }
        >
          <RadioTower size={12} />
          {broadcast ? `all ${connectedIds.length}` : "active"}
        </button>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            broadcast
              ? `broadcast to ${connectedIds.length} connected session${connectedIds.length === 1 ? "" : "s"}…`
              : "compose a command — enter sends to the active terminal (ctrl+k)"
          }
          className="min-w-0 flex-1 rounded-md border border-edge bg-bg-inset px-3 py-1.5 font-mono text-[12.5px] text-ink-hi outline-none transition placeholder:text-ink-dim focus:border-accent/60"
        />
        <button
          onClick={sendCompose}
          disabled={!canSend || !text.trim()}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:bg-accent-hover active:scale-[0.97] disabled:pointer-events-none disabled:opacity-30"
        >
          <CornerDownLeft size={13} />
          Send
        </button>
      </div>

      {manageOpen && <QuickCommandsModal onClose={() => setManageOpen(false)} />}
    </div>
  );
}
