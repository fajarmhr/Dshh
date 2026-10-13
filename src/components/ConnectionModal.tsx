import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, RefreshCw, Server } from "lucide-react";
import { useStore } from "../store";
import { serialListPorts, localListShells } from "../lib/api";
import { clamp, overlayDismiss } from "../lib/utils";
import { THEME_ORDER } from "../lib/themes";
import { parseConsoleLink } from "../lib/consoleLink";
import { useSshConnections } from "./ConsoleLinkModal";
import {
  CONNECTION_COLORS,
  DEFAULT_PORTS,
  PROTOCOL_COLORS,
  PROTOCOL_LABELS,
  type AuthMethod,
  type Connection,
  type LocalShell,
  type Protocol,
  type VncMode,
} from "../lib/types";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

const PROTOCOLS: Protocol[] = ["ssh", "sftp", "ftp", "telnet", "vnc", "serial", "local"];
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
  const [shells, setShells] = useState<LocalShell[]>([]);
  const [useJump, setUseJump] = useState(!!initial?.jumpHost);
  const [linkText, setLinkText] = useState("");
  const sshConnections = useSshConnections();

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
    if (form.protocol !== "local") return;
    localListShells()
      .then((list) => {
        setShells(list);
        if (list.length && !list.some((s) => s.id === form.shell)) {
          set("shell", list[0].id);
        }
      })
      .catch(() => setShells([]));
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
    setForm((f) => ({
      ...f,
      protocol: p,
      port: DEFAULT_PORTS[p] || f.port,
      shell: p === "local" ? f.shell ?? "cmd" : f.shell,
      vncMode: p === "vnc" ? f.vncMode ?? "direct" : f.vncMode,
    }));
  };

  const changeVncMode = (m: VncMode) => {
    setForm((f) => ({
      ...f,
      vncMode: m,
      // Swap the stock ports, but leave a port the user typed alone.
      port:
        m === "console" && f.port === 5900
          ? 8002
          : m === "direct" && f.port === 8002
            ? 5900
            : f.port,
    }));
  };

  /** Fill the console fields from a pasted link. Its token is not kept. */
  const applyLink = (text: string) => {
    setLinkText(text);
    const link = parseConsoleLink(text);
    if (!link) return;
    setForm((f) => ({
      ...f,
      host: link.host,
      port: link.port,
      vncTls: link.tls,
      vncPath: link.path?.split("?")[0] || f.vncPath,
      name: f.name.trim() ? f.name : link.name ?? f.name,
    }));
  };

  const pickKey = async () => {
    const picked = await openDialog({ multiple: false });
    if (picked && !Array.isArray(picked)) set("privateKeyPath", picked);
  };

  const pickJumpKey = async () => {
    const picked = await openDialog({ multiple: false });
    if (picked && !Array.isArray(picked)) set("jumpKeyPath", picked);
  };

  const save = () => {
    const name =
      form.name.trim() ||
      (form.protocol === "serial"
        ? form.serialPort || "Serial"
        : form.protocol === "local"
          ? shells.find((s) => s.id === form.shell)?.label ?? "Local terminal"
          : `${form.host}`);
    const payload = { ...form, name };
    if (!useJump || !isSshLike) {
      payload.jumpHost = undefined;
      payload.jumpPort = undefined;
      payload.jumpUsername = undefined;
      payload.jumpAuthMethod = undefined;
      payload.jumpPassword = undefined;
      payload.jumpKeyPath = undefined;
      payload.jumpPassphrase = undefined;
    }
    if (initial) updateConnection(initial.id, payload);
    else addConnection(payload);
    onClose();
  };

  const isSerial = form.protocol === "serial";
  const isLocal = form.protocol === "local";
  const isTelnet = form.protocol === "telnet";
  const isVnc = form.protocol === "vnc";
  const isConsole = isVnc && form.vncMode === "console";
  const isNet = !isSerial && !isLocal && !isVnc;
  const isSshLike = form.protocol === "ssh" || form.protocol === "sftp";

  return (
    <div className="modal-overlay" {...overlayDismiss(onClose)}>
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
          <div className="grid grid-cols-7 gap-1 rounded-lg border border-edge bg-bg-inset p-1">
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label">Accent colour</label>
              <div className="flex flex-wrap items-center gap-1.5 py-1">
                <button
                  onClick={() => set("color", undefined)}
                  title="No accent — use the protocol colour"
                  className={`h-5 w-5 rounded-md border transition ${
                    form.color
                      ? "border-edge hover:border-edge-bright"
                      : "border-accent ring-1 ring-accent/40"
                  }`}
                />
                {CONNECTION_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => set("color", c)}
                    title={c}
                    style={{ backgroundColor: c }}
                    className={`h-5 w-5 rounded-md transition ${
                      form.color === c
                        ? "ring-2 ring-white/70"
                        : "opacity-70 hover:opacity-100"
                    }`}
                  />
                ))}
              </div>
            </div>
            <div>
              <label className="field-label">Tags (comma separated)</label>
              <input
                className="field-input"
                value={(form.tags ?? []).join(", ")}
                placeholder="prod, eu-west, db"
                onChange={(e) =>
                  set(
                    "tags",
                    e.target.value
                      .split(",")
                      .map((t) => t.trim())
                      .filter(Boolean)
                  )
                }
              />
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

              {!isTelnet && (
                <div>
                  <label className="field-label">Username</label>
                  <input
                    className="field-input font-mono text-[13px]"
                    value={form.username ?? ""}
                    placeholder="root"
                    onChange={(e) => set("username", e.target.value)}
                  />
                </div>
              )}

              {isTelnet && (
                <p className="text-[11px] leading-relaxed text-ink-dim">
                  Telnet logs in inside the session itself — the server prompts
                  for username and password in the terminal.
                </p>
              )}

              {isSshLike && (
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

              {(form.protocol === "ftp" || (isSshLike && form.authMethod === "password")) && (
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

              {isSshLike && form.authMethod === "key" && (
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

              {isSshLike && (
                <div className="space-y-3 rounded-lg border border-edge bg-bg-inset/50 p-3">
                  <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-mid">
                    <input
                      type="checkbox"
                      checked={useJump}
                      onChange={(e) => setUseJump(e.target.checked)}
                    />
                    Connect through a jump host (bastion)
                  </label>

                  {useJump && (
                    <>
                      <div className="grid grid-cols-[1fr_90px] gap-3">
                        <div>
                          <label className="field-label">Jump host</label>
                          <input
                            className="field-input font-mono text-[13px]"
                            value={form.jumpHost ?? ""}
                            placeholder="bastion.example.com"
                            onChange={(e) => set("jumpHost", e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="field-label">Port</label>
                          <input
                            className="field-input font-mono text-[13px]"
                            type="number"
                            value={form.jumpPort ?? 22}
                            onChange={(e) => set("jumpPort", Number(e.target.value))}
                          />
                        </div>
                      </div>
                      <div>
                        <label className="field-label">Jump username</label>
                        <input
                          className="field-input font-mono text-[13px]"
                          value={form.jumpUsername ?? ""}
                          placeholder="root"
                          onChange={(e) => set("jumpUsername", e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="field-label">Jump authentication</label>
                        <div className="grid grid-cols-2 gap-1 rounded-lg border border-edge bg-bg-inset p-1">
                          {(["password", "key"] as AuthMethod[]).map((m) => (
                            <button
                              key={m}
                              onClick={() => set("jumpAuthMethod", m)}
                              className={`rounded-md py-1.5 text-xs capitalize transition active:scale-[0.98] ${
                                (form.jumpAuthMethod ?? "password") === m
                                  ? "bg-accent/15 text-accent"
                                  : "text-ink-dim hover:bg-bg-hover hover:text-ink-mid"
                              }`}
                            >
                              {m}
                            </button>
                          ))}
                        </div>
                      </div>
                      {(form.jumpAuthMethod ?? "password") === "password" ? (
                        <div>
                          <label className="field-label">Jump password</label>
                          <input
                            className="field-input font-mono text-[13px]"
                            type="password"
                            value={form.jumpPassword ?? ""}
                            onChange={(e) => set("jumpPassword", e.target.value)}
                          />
                        </div>
                      ) : (
                        <>
                          <div>
                            <label className="field-label">Jump private key</label>
                            <div className="flex gap-2">
                              <input
                                className="field-input flex-1 font-mono text-[13px]"
                                value={form.jumpKeyPath ?? ""}
                                placeholder="~/.ssh/id_ed25519"
                                onChange={(e) => set("jumpKeyPath", e.target.value)}
                              />
                              <button
                                onClick={pickJumpKey}
                                className="rounded-md border border-edge px-3 text-xs text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi"
                              >
                                Browse
                              </button>
                            </div>
                          </div>
                          <div>
                            <label className="field-label">Key passphrase (optional)</label>
                            <input
                              className="field-input font-mono text-[13px]"
                              type="password"
                              value={form.jumpPassphrase ?? ""}
                              onChange={(e) => set("jumpPassphrase", e.target.value)}
                            />
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {isVnc && (
            <>
              <div>
                <label className="field-label">Connect to</label>
                <div className="grid grid-cols-2 gap-1 rounded-lg border border-edge bg-bg-inset p-1">
                  {(["direct", "console"] as VncMode[]).map((m) => (
                    <button
                      key={m}
                      onClick={() => changeVncMode(m)}
                      className={`rounded-md py-1.5 text-xs transition active:scale-[0.98] ${
                        (form.vncMode ?? "direct") === m
                          ? "bg-accent/15 text-accent"
                          : "text-ink-dim hover:bg-bg-hover hover:text-ink-mid"
                      }`}
                    >
                      {m === "direct" ? "VNC server" : "Console link (token)"}
                    </button>
                  ))}
                </div>
              </div>

              {isConsole && (
                <div>
                  <label className="field-label">Paste a console link (optional)</label>
                  <input
                    className="field-input font-mono text-[12px]"
                    value={linkText}
                    placeholder="https://proxy:8002/vnc_auto.html?token=…"
                    onChange={(e) => applyLink(e.target.value)}
                  />
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-dim">
                    {linkText.trim() && !parseConsoleLink(linkText)
                      ? "That link has no token= parameter."
                      : linkText.trim()
                        ? "Filled in the proxy below. The token itself isn't saved."
                        : "Fills in the proxy for you. The token is asked for each time you connect — they expire within minutes."}
                  </p>
                </div>
              )}

              <div className="grid grid-cols-[1fr_100px] gap-3">
                <div>
                  <label className="field-label">{isConsole ? "Console proxy" : "Host"}</label>
                  <div className="flex gap-2">
                    <input
                      className="field-input flex-1 font-mono text-[13px]"
                      value={form.host ?? ""}
                      placeholder={isConsole ? "proxy IP or name" : "192.168.1.10"}
                      onChange={(e) => set("host", e.target.value)}
                    />
                    <SshHostPicker
                      connections={sshConnections}
                      onPick={(host) => set("host", host)}
                    />
                  </div>
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

              {isConsole ? (
                <>
                  <div className="grid grid-cols-[1fr_auto] items-end gap-3">
                    <div>
                      <label className="field-label">WebSocket path</label>
                      <input
                        className="field-input font-mono text-[13px]"
                        value={form.vncPath ?? ""}
                        placeholder="websockify"
                        onChange={(e) => set("vncPath", e.target.value || undefined)}
                      />
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm text-ink-mid">
                      <input
                        type="checkbox"
                        checked={form.vncTls ?? true}
                        onChange={(e) => set("vncTls", e.target.checked)}
                      />
                      HTTPS
                    </label>
                  </div>
                  <div>
                    <label className="field-label">VNC password (optional)</label>
                    <input
                      className="field-input font-mono text-[13px]"
                      type="password"
                      value={form.password ?? ""}
                      placeholder="only if the console asks after the token"
                      onChange={(e) => set("password", e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="field-label">Username (optional)</label>
                    <input
                      className="field-input font-mono text-[13px]"
                      value={form.username ?? ""}
                      placeholder="macOS / VeNCrypt only"
                      onChange={(e) => set("username", e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="field-label">Password</label>
                    <input
                      className="field-input font-mono text-[13px]"
                      type="password"
                      value={form.password ?? ""}
                      onChange={(e) => set("password", e.target.value)}
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="field-label">Route through</label>
                <select
                  className="field-input text-[13px]"
                  value={form.vncViaSsh ?? ""}
                  onChange={(e) => set("vncViaSsh", e.target.value || undefined)}
                >
                  <option value="">Direct connection</option>
                  {sshConnections.map((c) => (
                    <option key={c.id} value={c.id}>
                      SSH · {c.name} ({c.host})
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-dim">
                  {form.vncViaSsh
                    ? "The host above is reached from that SSH server — use localhost for a VNC server running on it."
                    : "Classic VNC traffic is unencrypted; routing it through a saved SSH session protects it."}
                </p>
              </div>

              <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-mid">
                <input
                  type="checkbox"
                  checked={!!form.vncVerifyTls}
                  onChange={(e) => set("vncVerifyTls", e.target.checked)}
                />
                Verify TLS certificate (off accepts self-signed ones)
              </label>
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

          {isLocal && (
            <>
              <div>
                <label className="field-label">Shell</label>
                <select
                  className="field-input font-mono text-[13px]"
                  value={form.shell ?? ""}
                  onChange={(e) => set("shell", e.target.value)}
                >
                  {shells.length === 0 && <option value="">No shells found</option>}
                  {shells.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="field-label">Working directory (optional)</label>
                <input
                  className="field-input font-mono text-[13px]"
                  value={form.cwd ?? ""}
                  placeholder="blank = home directory"
                  onChange={(e) => set("cwd", e.target.value)}
                />
              </div>
              <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-mid">
                <input
                  type="checkbox"
                  checked={!!form.admin}
                  onChange={(e) => set("admin", e.target.checked)}
                />
                Run as Administrator (opens in a separate elevated window)
              </label>
            </>
          )}

          {form.protocol !== "sftp" && form.protocol !== "ftp" && !isVnc && (
            <div className="space-y-3 border-t border-edge pt-4">
              <div>
                <label className="field-label">Run on connect (optional)</label>
                <input
                  className="field-input font-mono text-[13px]"
                  value={form.runOnConnect ?? ""}
                  placeholder="e.g. cd /var/log && tail -f app.log"
                  onChange={(e) => set("runOnConnect", e.target.value)}
                />
                <p className="mt-1 text-[11px] leading-relaxed text-ink-dim">
                  Typed into the session once the shell is ready.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="field-label">Colour scheme</label>
                  <select
                    className="field-input font-mono text-[13px]"
                    value={form.themeId ?? ""}
                    onChange={(e) => set("themeId", e.target.value || undefined)}
                  >
                    <option value="">Use global setting</option>
                    {THEME_ORDER.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label">Font size</label>
                  <input
                    type="number"
                    min={8}
                    max={28}
                    className="field-input font-mono text-[13px]"
                    value={form.fontSize ?? ""}
                    placeholder="global"
                    onChange={(e) =>
                      set(
                        "fontSize",
                        e.target.value
                          ? clamp(Number(e.target.value), 8, 28, 13)
                          : undefined
                      )
                    }
                  />
                </div>
              </div>
            </div>
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

/**
 * Fill the host from a saved SSH session — console proxies and VNC hosts are
 * usually machines already in the list.
 */
function SshHostPicker({
  connections,
  onPick,
}: {
  connections: Connection[];
  onPick: (host: string) => void;
}) {
  /** Where the list is pinned, in viewport pixels; null while closed. */
  const [at, setAt] = useState<React.CSSProperties | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!at) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !listRef.current?.contains(t)) setAt(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [at]);

  // The form scrolls, and a list positioned inside it would be clipped by
  // that scroll box, so it is portalled out and pinned to the button —
  // dropping down where there's room, opening upward where there isn't.
  const toggle = () => {
    if (at) return setAt(null);
    const r = btnRef.current!.getBoundingClientRect();
    const right = window.innerWidth - r.right;
    setAt(
      window.innerHeight - r.bottom > 280
        ? { top: r.bottom + 4, right }
        : { bottom: window.innerHeight - r.top + 4, right }
    );
  };

  const hosts = connections.filter((c) => c.host?.trim());
  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        disabled={hosts.length === 0}
        className="rounded-md border border-edge px-2.5 text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi disabled:opacity-30"
        title={hosts.length ? "Use the host of a saved SSH session" : "No saved SSH sessions"}
      >
        <Server size={14} />
      </button>
      {at &&
        createPortal(
          <div
            ref={listRef}
            style={at}
            className="fixed z-[60] max-h-64 w-64 animate-fade-up overflow-y-auto rounded-lg border border-edge bg-bg-panel/95 py-1 shadow-[0_16px_40px_-10px_rgba(4,10,20,0.85)] backdrop-blur-sm"
          >
            <div className="micro-label px-3 py-1">Host from SSH session</div>
            {hosts.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  onPick(c.host!.trim());
                  setAt(null);
                }}
                className="flex w-full flex-col px-3 py-1.5 text-left transition hover:bg-bg-hover"
              >
                <span className="truncate text-[12.5px] text-ink-hi">{c.name}</span>
                <span className="truncate font-mono text-[10.5px] text-ink-dim">{c.host}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
