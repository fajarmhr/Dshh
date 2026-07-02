import { useState } from "react";
import { ArrowRight, Play, Plus, Square, Trash2, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useStore } from "../store";
import { tunnelStart, tunnelStop } from "../lib/api";
import type { Connection, TunnelDef } from "../lib/types";
import { cn } from "../lib/utils";

/**
 * Local port forwards (`ssh -L`) for one connection. Definitions persist on
 * the connection; each running tunnel uses its own SSH connection and keeps
 * running until stopped here or the app exits.
 */
export function TunnelsModal({
  conn,
  onClose,
}: {
  conn: Connection;
  onClose: () => void;
}) {
  const updateConnection = useStore((s) => s.updateConnection);
  const activeTunnels = useStore((s) => s.activeTunnels);
  const setTunnelActive = useStore((s) => s.setTunnelActive);
  const live = useStore((s) => s.connections.find((c) => c.id === conn.id)) ?? conn;
  const tunnels = live.tunnels ?? [];

  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("localhost");
  const [remotePort, setRemotePort] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const validPort = (v: string) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 65535;
  };
  const canAdd = validPort(localPort) && validPort(remotePort) && remoteHost.trim();

  const add = () => {
    if (!canAdd) return;
    const def: TunnelDef = {
      id: nanoid(),
      localPort: Number(localPort),
      remoteHost: remoteHost.trim(),
      remotePort: Number(remotePort),
    };
    updateConnection(live.id, { tunnels: [...tunnels, def] });
    setLocalPort("");
    setRemotePort("");
  };

  const start = async (def: TunnelDef) => {
    setBusyId(def.id);
    setError("");
    try {
      const backendId = await tunnelStart(
        live,
        def.localPort,
        def.remoteHost,
        def.remotePort
      );
      setTunnelActive(def.id, backendId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  const stop = async (def: TunnelDef) => {
    const backendId = activeTunnels[def.id];
    if (!backendId) return;
    setBusyId(def.id);
    try {
      await tunnelStop(backendId);
    } finally {
      setTunnelActive(def.id, null);
      setBusyId(null);
    }
  };

  const remove = async (def: TunnelDef) => {
    if (activeTunnels[def.id]) await stop(def);
    updateConnection(live.id, {
      tunnels: tunnels.filter((t) => t.id !== def.id),
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-shell w-[560px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-ink-hi">Port forwarding</h2>
            <div className="mt-0.5 font-mono text-[10.5px] text-ink-dim">
              {live.username ? `${live.username}@` : ""}
              {live.host} · local forwards (ssh -L)
            </div>
          </div>
          <button onClick={onClose} className="tb-btn">
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto px-5 py-4">
          {tunnels.length === 0 && (
            <div className="rounded-lg border border-dashed border-edge-bright px-4 py-5 font-mono text-[11px] leading-relaxed text-ink-dim">
              no tunnels defined — a local forward exposes a remote service on
              127.0.0.1, e.g. local 5433{" "}
              <ArrowRight size={10} className="inline" /> localhost:5432 for a
              remote database.
            </div>
          )}

          {tunnels.map((t) => {
            const running = !!activeTunnels[t.id];
            const busy = busyId === t.id;
            return (
              <div
                key={t.id}
                className="flex items-center gap-3 rounded-lg border border-edge bg-bg-elev px-3 py-2"
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    running ? "bg-ok" : "bg-ink-dim",
                    busy && "animate-pulse"
                  )}
                />
                <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[12px] text-ink-hi">
                  <span className="text-ink-mid">127.0.0.1:</span>
                  {t.localPort}
                  <ArrowRight size={11} className="shrink-0 text-ink-dim" />
                  <span className="truncate">
                    {t.remoteHost}:{t.remotePort}
                  </span>
                </div>
                <button
                  onClick={() => (running ? stop(t) : start(t))}
                  disabled={busy}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition active:scale-[0.97] disabled:opacity-40",
                    running
                      ? "border-ok/40 bg-ok/10 text-ok hover:bg-ok/20"
                      : "border-edge text-ink-mid hover:border-accent/50 hover:text-ink-hi"
                  )}
                >
                  {running ? <Square size={10} /> : <Play size={10} />}
                  {busy ? "…" : running ? "stop" : "start"}
                </button>
                <button
                  onClick={() => remove(t)}
                  className="rounded p-1 text-ink-dim transition hover:bg-bg-hover hover:text-err"
                  title="Delete tunnel"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}

          <div className="flex items-end gap-2 border-t border-edge pt-3">
            <div className="w-24">
              <label className="field-label">Local port</label>
              <input
                className="field-input font-mono text-[12.5px]"
                value={localPort}
                placeholder="5433"
                onChange={(e) => setLocalPort(e.target.value)}
              />
            </div>
            <div className="flex-1">
              <label className="field-label">Remote host</label>
              <input
                className="field-input font-mono text-[12.5px]"
                value={remoteHost}
                placeholder="localhost"
                onChange={(e) => setRemoteHost(e.target.value)}
              />
            </div>
            <div className="w-24">
              <label className="field-label">Remote port</label>
              <input
                className="field-input font-mono text-[12.5px]"
                value={remotePort}
                placeholder="5432"
                onChange={(e) => setRemotePort(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && add()}
              />
            </div>
            <button
              onClick={add}
              disabled={!canAdd}
              className="mb-px rounded-md border border-edge p-2 text-ink-mid transition hover:border-accent/50 hover:text-ink-hi active:scale-[0.97] disabled:pointer-events-none disabled:opacity-30"
              title="Add tunnel"
            >
              <Plus size={14} />
            </button>
          </div>

          {error && (
            <div className="rounded-md border border-err/40 bg-err/10 px-3 py-2 font-mono text-[11px] text-err">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-edge px-5 py-3">
          <span className="font-mono text-[10px] text-ink-dim">
            tunnels keep running until stopped or the app closes
          </span>
          <button onClick={onClose} className="btn-primary">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
