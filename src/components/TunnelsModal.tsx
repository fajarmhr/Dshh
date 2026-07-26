import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Globe, Play, Plus, Square, Trash2, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useStore } from "../store";
import { tunnelStart, tunnelStats, tunnelStop, type TunnelStats } from "../lib/api";
import { TUNNEL_KIND_LABELS, type Connection, type TunnelDef, type TunnelKind } from "../lib/types";
import { cn, formatBytes, overlayDismiss } from "../lib/utils";

const KINDS: TunnelKind[] = ["local", "remote", "dynamic"];

/** Tunnels saved before kinds existed are local forwards. */
const kindOf = (t: TunnelDef): TunnelKind => t.kind ?? "local";

/**
 * Port forwarding for one connection, covering all three OpenSSH directions.
 * Definitions persist on the connection; each running forward uses its own SSH
 * connection and keeps running until stopped here or the app exits.
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

  const [kind, setKind] = useState<TunnelKind>("local");
  const [localPort, setLocalPort] = useState("");
  const [remoteHost, setRemoteHost] = useState("localhost");
  const [remotePort, setRemotePort] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<Record<string, TunnelStats>>({});

  // Poll the running forwards so each row shows live throughput. Only ids we
  // actually started are asked about, and the map is keyed by backend id.
  const runningIds = tunnels
    .map((t) => activeTunnels[t.id])
    .filter((id): id is string => !!id);
  const runningKey = runningIds.join(",");
  useEffect(() => {
    if (!runningIds.length) {
      setStats({});
      return;
    }
    let alive = true;
    const tick = () => {
      tunnelStats(runningKey.split(","))
        .then((s) => alive && setStats(s))
        .catch(() => {});
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [runningKey]);

  const validPort = (v: string) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 65535;
  };
  // Dynamic forwards have no fixed destination, so only the listen port
  // matters; the other two need a full address on the far end.
  const canAdd =
    kind === "dynamic"
      ? validPort(localPort)
      : validPort(localPort) && validPort(remotePort) && !!remoteHost.trim();

  const add = () => {
    if (!canAdd) return;
    const def: TunnelDef = {
      id: nanoid(),
      kind,
      localPort: Number(localPort),
      remoteHost: kind === "dynamic" ? "" : remoteHost.trim(),
      remotePort: kind === "dynamic" ? 0 : Number(remotePort),
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
        kindOf(def),
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
    <div className="modal-overlay" {...overlayDismiss(onClose)}>
      <div className="modal-shell w-[620px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-ink-hi">Port forwarding</h2>
            <div className="mt-0.5 font-mono text-[10.5px] text-ink-dim">
              {live.username ? `${live.username}@` : ""}
              {live.host} · local, remote and dynamic forwards
            </div>
          </div>
          <button onClick={onClose} className="tb-btn">
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[60vh] space-y-2 overflow-y-auto px-5 py-4">
          {tunnels.length === 0 && (
            <div className="space-y-1.5 rounded-lg border border-dashed border-edge-bright px-4 py-4 font-mono text-[11px] leading-relaxed text-ink-dim">
              <div className="text-ink-mid">no forwards defined</div>
              {KINDS.map((k) => (
                <div key={k}>
                  <span className="text-ink-mid">{TUNNEL_KIND_LABELS[k].flag}</span>{" "}
                  {TUNNEL_KIND_LABELS[k].blurb}
                </div>
              ))}
            </div>
          )}

          {tunnels.map((t) => {
            const backendId = activeTunnels[t.id];
            const running = !!backendId;
            const busy = busyId === t.id;
            const s = backendId ? stats[backendId] : undefined;
            return (
              <TunnelRow
                key={t.id}
                def={t}
                running={running}
                busy={busy}
                stats={s}
                onToggle={() => (running ? stop(t) : start(t))}
                onRemove={() => remove(t)}
              />
            );
          })}

          <div className="border-t border-edge pt-3">
            <div className="flex gap-1 pb-3">
              {KINDS.map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[10.5px] transition active:scale-[0.97]",
                    kind === k
                      ? "border-accent/50 bg-accent/10 text-ink-hi"
                      : "border-edge text-ink-dim hover:border-edge-bright hover:text-ink-mid"
                  )}
                >
                  <span className="font-semibold">{TUNNEL_KIND_LABELS[k].flag}</span>
                  {TUNNEL_KIND_LABELS[k].title}
                </button>
              ))}
            </div>

            <div className="flex items-end gap-2">
              <div className="w-28">
                <label className="field-label">
                  {kind === "remote" ? "Deliver to port" : "Listen port"}
                </label>
                <input
                  className="field-input font-mono text-[12.5px]"
                  value={localPort}
                  placeholder={kind === "dynamic" ? "1080" : "5433"}
                  onChange={(e) => setLocalPort(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && kind === "dynamic" && add()}
                />
              </div>
              {kind !== "dynamic" && (
                <>
                  <div className="flex-1">
                    <label className="field-label">
                      {kind === "remote" ? "Deliver to host" : "Remote host"}
                    </label>
                    <input
                      className="field-input font-mono text-[12.5px]"
                      value={remoteHost}
                      placeholder="localhost"
                      onChange={(e) => setRemoteHost(e.target.value)}
                    />
                  </div>
                  <div className="w-28">
                    <label className="field-label">
                      {kind === "remote" ? "Server listens" : "Remote port"}
                    </label>
                    <input
                      className="field-input font-mono text-[12.5px]"
                      value={remotePort}
                      placeholder={kind === "remote" ? "8080" : "5432"}
                      onChange={(e) => setRemotePort(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && add()}
                    />
                  </div>
                </>
              )}
              <button
                onClick={add}
                disabled={!canAdd}
                className="mb-px rounded-md border border-edge p-2 text-ink-mid transition hover:border-accent/50 hover:text-ink-hi active:scale-[0.97] disabled:pointer-events-none disabled:opacity-30"
                title={`Add ${TUNNEL_KIND_LABELS[kind].title.toLowerCase()} forward`}
              >
                <Plus size={14} />
              </button>
            </div>
            <div className="pt-2 font-mono text-[10px] leading-relaxed text-ink-dim">
              {TUNNEL_KIND_LABELS[kind].flag} {TUNNEL_KIND_LABELS[kind].blurb}
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-err/40 bg-err/10 px-3 py-2 font-mono text-[11px] text-err">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-edge px-5 py-3">
          <span className="font-mono text-[10px] text-ink-dim">
            forwards keep running until stopped or the app closes
          </span>
          <button onClick={onClose} className="btn-primary">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One forward. The indicator goes solid green while the forward is up and
 * flashes whenever bytes moved since the last poll, so an idle forward reads
 * differently from a busy one.
 */
function TunnelRow({
  def,
  running,
  busy,
  stats,
  onToggle,
  onRemove,
}: {
  def: TunnelDef;
  running: boolean;
  busy: boolean;
  stats?: TunnelStats;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const kind = kindOf(def);
  const moved = stats ? stats.tx + stats.rx : 0;
  const prevMoved = useRef(0);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (moved > prevMoved.current) {
      prevMoved.current = moved;
      setActive(true);
      const timer = setTimeout(() => setActive(false), 700);
      return () => clearTimeout(timer);
    }
    prevMoved.current = moved;
  }, [moved]);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-edge bg-bg-elev px-3 py-2">
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full transition-all",
          running ? "bg-ok" : "bg-ink-dim",
          busy && "animate-pulse",
          active && "scale-150 shadow-[0_0_6px_2px_rgba(62,207,142,0.55)]"
        )}
      />
      <span className="shrink-0 font-mono text-[9.5px] font-semibold text-ink-dim">
        {TUNNEL_KIND_LABELS[kind].flag}
      </span>

      <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[12px] text-ink-hi">
        {kind === "dynamic" ? (
          <>
            <Globe size={11} className="shrink-0 text-ink-dim" />
            <span className="text-ink-mid">socks5 127.0.0.1:</span>
            {def.localPort}
          </>
        ) : kind === "remote" ? (
          <>
            <span className="text-ink-mid">server:</span>
            {def.remotePort}
            <ArrowLeft size={11} className="shrink-0 text-ink-dim" />
            <span className="truncate">
              {def.remoteHost}:{def.localPort}
            </span>
          </>
        ) : (
          <>
            <span className="text-ink-mid">127.0.0.1:</span>
            {def.localPort}
            <ArrowRight size={11} className="shrink-0 text-ink-dim" />
            <span className="truncate">
              {def.remoteHost}:{def.remotePort}
            </span>
          </>
        )}
      </div>

      {running && stats && (
        <span
          className="shrink-0 font-mono text-[9.5px] text-ink-dim"
          title={`${stats.open} open · ${stats.total} total connections`}
        >
          {stats.open > 0 && <span className="text-ok">{stats.open}× </span>}
          ↑{formatBytes(stats.tx)} ↓{formatBytes(stats.rx)}
        </span>
      )}

      <button
        onClick={onToggle}
        disabled={busy}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition active:scale-[0.97] disabled:opacity-40",
          running
            ? "border-ok/40 bg-ok/10 text-ok hover:bg-ok/20"
            : "border-edge text-ink-mid hover:border-accent/50 hover:text-ink-hi"
        )}
      >
        {running ? <Square size={10} /> : <Play size={10} />}
        {busy ? "…" : running ? "stop" : "start"}
      </button>
      <button
        onClick={onRemove}
        className="shrink-0 rounded p-1 text-ink-dim transition hover:bg-bg-hover hover:text-err"
        title="Delete forward"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}
