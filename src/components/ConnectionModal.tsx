import { useEffect, useMemo, useState } from "react";
import { X, RefreshCw } from "lucide-react";
import { useStore } from "../store";
import { serialListPorts } from "../lib/api";
import {
  DEFAULT_PORTS,
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[440px] rounded-xl border border-edge bg-bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="text-sm font-semibold">
            {initial ? "Edit connection" : "New connection"}
          </h2>
          <button onClick={onClose} className="tb-btn">
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-4 gap-1.5 rounded-lg bg-bg-base p-1">
            {PROTOCOLS.map((p) => (
              <button
                key={p}
                onClick={() => changeProtocol(p)}
                className={`rounded-md py-1.5 text-xs font-medium transition ${
                  form.protocol === p
                    ? "bg-accent text-white"
                    : "text-[#9aa7b6] hover:bg-bg-hover"
                }`}
              >
                {PROTOCOL_LABELS[p]}
              </button>
            ))}
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
                    className="field-input"
                    value={form.host ?? ""}
                    placeholder="192.168.1.10"
                    onChange={(e) => set("host", e.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label">Port</label>
                  <input
                    className="field-input"
                    type="number"
                    value={form.port ?? 0}
                    onChange={(e) => set("port", Number(e.target.value))}
                  />
                </div>
              </div>

              <div>
                <label className="field-label">Username</label>
                <input
                  className="field-input"
                  value={form.username ?? ""}
                  placeholder="root"
                  onChange={(e) => set("username", e.target.value)}
                />
              </div>

              {form.protocol !== "ftp" && (
                <div>
                  <label className="field-label">Authentication</label>
                  <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-bg-base p-1">
                    {(["password", "key", "agent"] as AuthMethod[]).map((m) => (
                      <button
                        key={m}
                        onClick={() => set("authMethod", m)}
                        className={`rounded-md py-1.5 text-xs capitalize transition ${
                          form.authMethod === m
                            ? "bg-accent-soft text-white"
                            : "text-[#9aa7b6] hover:bg-bg-hover"
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
                    className="field-input"
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
                      className="field-input flex-1"
                      value={form.privateKeyPath ?? ""}
                      placeholder="~/.ssh/id_ed25519"
                      onChange={(e) => set("privateKeyPath", e.target.value)}
                    />
                    <button
                      onClick={pickKey}
                      className="rounded-md border border-edge px-3 text-xs text-[#9aa7b6] hover:bg-bg-hover"
                    >
                      Browse
                    </button>
                  </div>
                </div>
              )}

              {form.protocol === "ftp" && (
                <label className="flex items-center gap-2 text-sm text-[#9aa7b6]">
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
                    className="field-input flex-1"
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
                    className="rounded-md border border-edge px-3 text-[#9aa7b6] hover:bg-bg-hover"
                    title="Rescan ports"
                  >
                    <RefreshCw size={14} />
                  </button>
                </div>
              </div>
              <div>
                <label className="field-label">Baud rate</label>
                <select
                  className="field-input"
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
          <button
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm text-[#9aa7b6] hover:bg-bg-hover"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
