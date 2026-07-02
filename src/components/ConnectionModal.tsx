import { useEffect, useMemo, useState } from "react";
import { X, RefreshCw } from "lucide-react";
import { useStore } from "../store";
import { serialListPorts } from "../lib/api";
import {
  DEFAULT_PORTS,
  PROTOCOL_COLORS,
  PROTOCOL_LABELS,
  type AuthMethod,
  type Connection,
  type Protocol,
} from "../lib/types";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

const PROTOCOLS: Protocol[] = ["ssh", "sftp", "ftp", "serial"];
const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export function ConnectionModal({
  initial,
  onClose,
}: {
  initial: Connection | null;
  onClose: () => void;
}) {
  const addConnection = useStore((s) => s.addConnection);
  const updateConnection = useStore((s) => s.updateConnection);
  const connections = useStore((s) => s.connections);
  const existingGroups = useMemo(
    () =>
      Array.from(
        new Set(connections.map((c) => c.group?.trim()).filter((g): g is string => !!g))
      ).sort(),
    [connections]
  );

  const [form, setForm] = useState<Omit<Connection, "id">>(
    initial ?? {
      name: "",
      protocol: "ssh",
      host: "",
      port: 22,
      username: "",
      authMethod: "password",
      password: "",
      baudRate: 115200,
      ftpSecure: false,
    }
  );
  const [ports, setPorts] = useState<string[]>([]);

  const set = <K extends keyof Connection>(k: K, v: Connection[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const refreshPorts = () =>
    serialListPorts()
      .then((p) => {
        setPorts(p);
        if (p.length && !form.serialPort) set("serialPort", p[0]);
      })
      .catch(() => setPorts([]));

  useEffect(() => {
    if (form.protocol === "serial") refreshPorts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.protocol]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const changeProtocol = (p: Protocol) => {
    setForm((f) => ({ ...f, protocol: p, port: DEFAULT_PORTS[p] || f.port }));
  };

  const pickKey = async () => {
    const picked = await openDialog({ multiple: false });
    if (picked && !Array.isArray(picked)) set("privateKeyPath", picked);
  };

  const save = () => {
    const name =
      form.name.trim() ||
      (form.protocol === "serial" ? form.serialPort || "Serial" : `${form.host}`);
    const payload = { ...form, name };
    if (initial) updateConnection(initial.id, payload);
    else addConnection(payload);
    onClose();
  };

  const isSerial = form.protocol === "serial";
  const isNet = !isSerial;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-shell w-[460px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="text-sm font-semibold text-ink-hi">
            {initial ? "Edit connection" : "New connection"}
          </h2>
          <button onClick={onClose} className="tb-btn">
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-4 gap-1 rounded-lg border border-edge bg-bg-inset p-1">
            {PROTOCOLS.map((p) => {
              const activeP = form.protocol === p;
              return (
                <button
                  key={p}
                  onClick={() => changeProtocol(p)}
                  className={`rounded-md py-1.5 font-mono text-[11px] uppercase tracking-wider transition active:scale-[0.98] ${
                    activeP ? "bg-bg-elev" : "text-ink-dim hover:bg-bg-hover hover:text-ink-mid"
                  }`}
                  style={activeP ? { color: PROTOCOL_COLORS[p] } : undefined}
                >
                  {PROTOCOL_LABELS[p]}
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label">Name</label>
              <input
                className="field-input"
                value={form.name}
                placeholder="My server"
                onChange={(e) => set("name", e.target.value)}
              />
            </div>
            <div>
              <label className="field-label">Group</label>
              <input
                className="field-input"
                list="dshh-groups"
                value={form.group ?? ""}
                placeholder="e.g. Production"
                onChange={(e) => set("group", e.target.value)}
              />
              <datalist id="dshh-groups">
                {existingGroups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </div>
          </div>

          {isNet && (
            <>
              <div className="grid grid-cols-[1fr_100px] gap-3">
                <div>
                  <label className="field-label">Host</label>
                  <input
                    className="field-input font-mono text-[13px]"
                    value={form.host ?? ""}
                    placeholder="192.168.1.10"
                    onChange={(e) => set("host", e.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label">Port</label>
                  <input
                    className="field-input font-mono text-[13px]"
                    type="number"
                    value={form.port ?? 0}
                    onChange={(e) => set("port", Number(e.target.value))}
                  />
                </div>
              </div>

              <div>
                <label className="field-label">Username</label>
                <input
                  className="field-input font-mono text-[13px]"
                  value={form.username ?? ""}
                  placeholder="root"
                  onChange={(e) => set("username", e.target.value)}
                />
              </div>

              {form.protocol !== "ftp" && (
                <div>
                  <label className="field-label">Authentication</label>
                  <div className="grid grid-cols-3 gap-1 rounded-lg border border-edge bg-bg-inset p-1">
                    {(["password", "key", "agent"] as AuthMethod[]).map((m) => (
                      <button
                        key={m}
                        onClick={() => set("authMethod", m)}
                        className={`rounded-md py-1.5 text-xs capitalize transition active:scale-[0.98] ${
                          form.authMethod === m
                            ? "bg-accent/15 text-accent"
                            : "text-ink-dim hover:bg-bg-hover hover:text-ink-mid"
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {(form.protocol === "ftp" || form.authMethod === "password") && (
                <div>
                  <label className="field-label">Password</label>
                  <input
                    className="field-input font-mono text-[13px]"
                    type="password"
                    value={form.password ?? ""}
                    onChange={(e) => set("password", e.target.value)}
                  />
                </div>
              )}

              {form.protocol !== "ftp" && form.authMethod === "key" && (
                <div>
                  <label className="field-label">Private key</label>
                  <div className="flex gap-2">
                    <input
                      className="field-input flex-1 font-mono text-[13px]"
                      value={form.privateKeyPath ?? ""}
                      placeholder="~/.ssh/id_ed25519"
                      onChange={(e) => set("privateKeyPath", e.target.value)}
                    />
                    <button
                      onClick={pickKey}
                      className="rounded-md border border-edge px-3 text-xs text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi"
                    >
                      Browse
                    </button>
                  </div>
                </div>
              )}

              {form.protocol === "ftp" && (
                <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-mid">
                  <input
                    type="checkbox"
                    checked={!!form.ftpSecure}
                    onChange={(e) => set("ftpSecure", e.target.checked)}
                  />
                  Use FTPS (explicit TLS)
                </label>
              )}
            </>
          )}

          {isSerial && (
            <>
              <div>
                <label className="field-label">Serial port</label>
                <div className="flex gap-2">
                  <select
                    className="field-input flex-1 font-mono text-[13px]"
                    value={form.serialPort ?? ""}
                    onChange={(e) => set("serialPort", e.target.value)}
                  >
                    {ports.length === 0 && <option value="">No ports found</option>}
                    {ports.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={refreshPorts}
                    className="rounded-md border border-edge px-3 text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi"
                    title="Rescan ports"
                  >
                    <RefreshCw size={14} />
                  </button>
                </div>
              </div>
              <div>
                <label className="field-label">Baud rate</label>
                <select
                  className="field-input font-mono text-[13px]"
                  value={form.baudRate ?? 115200}
                  onChange={(e) => set("baudRate", Number(e.target.value))}
                >
                  {BAUD_RATES.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-edge px-5 py-3">
          <button onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button onClick={save} className="btn-primary">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
