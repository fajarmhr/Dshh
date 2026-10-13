import { useEffect, useRef, useState } from "react";
import {
  ClipboardType,
  Eye,
  EyeOff,
  Maximize2,
  Minimize2,
  Power,
  RotateCw,
} from "lucide-react";
import { useStore } from "../store";
import {
  clipboardRead,
  clipboardWrite,
  vncAck,
  vncClipboard,
  vncClose,
  vncConnect,
  vncKey,
  vncPointer,
  vncType,
  type VncEvent,
  type VncHello,
} from "../lib/api";
import { CTRL_ALT_DEL, keyFromEvent, type VncKey } from "../lib/vncKeys";
import { parseConsoleLink } from "../lib/consoleLink";
import { PasswordPrompt } from "./PasswordPrompt";
import { PasteConfirm } from "./PasteConfirm";
import { ConsoleTokenPrompt } from "./ConsoleLinkModal";
import type { Connection, Session } from "../lib/types";
import { cn, formatDuration, isAuthFailure, splitPasteLines } from "../lib/utils";

const FIT_KEY = "dshh.vncFit";
/** Wheel travel (px) per scroll click sent to the server: one mouse notch. */
const WHEEL_STEP = 100;

const PKT_RECT = 1;
const PKT_RESIZE = 2;
const PKT_CURSOR = 3;
const PKT_COPY = 4;

/** DOM `buttons` (left 1, right 2, middle 4) → RFB mask (left 1, middle 2, right 4). */
const rfbButtons = (b: number) => (b & 1) | (b & 4 ? 2 : 0) | (b & 2 ? 4 : 0);

function readFitPref(): boolean {
  try {
    return localStorage.getItem(FIT_KEY) !== "actual";
  } catch {
    return true;
  }
}

/**
 * A VNC session tab: the remote screen on a canvas, with keyboard and mouse
 * forwarded while it has focus. Pixels are decoded in Rust and arrive as
 * ready-to-draw RGBA rectangles (see `vnc/mod.rs` for the packet layout).
 */
export function VncView({ session, conn }: { session: Session; conn: Connection }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const backendId = useRef<string | null>(null);
  const connectingRef = useRef(false);
  // One "life" per mount, as in TerminalView: async results from a previous
  // mount (StrictMode, a closed tab) must not touch this one.
  const lifeRef = useRef<{ dead: boolean }>({ dead: false });
  const fbRef = useRef({ w: 0, h: 0 });
  /** Console token: from the pasted link this tab was opened with, or typed in. */
  const tokenRef = useRef<string | null>(conn.vncToken ?? null);
  /** Host/port/path from a full link pasted into the token prompt. */
  const linkRef = useRef<Partial<Connection>>({});
  /** Keys held down, by physical key, so the release sends what the press did. */
  const pressedRef = useRef(new Map<string, VncKey>());
  const buttonsRef = useRef(0);
  const posRef = useRef({ x: 0, y: 0 });
  const moveRafRef = useRef(0);
  const wheelRef = useRef({ x: 0, y: 0 });
  const viewOnlyRef = useRef(false);
  /** Last clipboard text exchanged either way, so it isn't echoed back. */
  const lastClipRef = useRef<string | null>(null);

  const setStatus = useStore((s) => s.setSessionStatus);
  const settings = useStore((s) => s.settings);
  const connections = useStore((s) => s.connections);

  const [fb, setFb] = useState({ w: 0, h: 0 });
  const [hello, setHello] = useState<VncHello | null>(null);
  const [fit, setFit] = useState(readFitPref);
  const [scale, setScale] = useState(1);
  const [viewOnly, setViewOnly] = useState(false);
  const [cursor, setCursor] = useState("default");
  const [note, setNote] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [tokenAsk, setTokenAsk] = useState<{ error?: string } | null>(null);
  const [typePending, setTypePending] = useState<string | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [uptime, setUptime] = useState("");

  viewOnlyRef.current = viewOnly;
  const isConsole = conn.vncMode === "console";
  const connected = session.status === "connected";
  const dropped = session.status === "closed" || session.status === "error";
  const via = conn.vncViaSsh ? connections.find((c) => c.id === conn.vncViaSsh) : undefined;
  const target =
    `${conn.username ? `${conn.username}@` : ""}${linkRef.current.host ?? conn.host}:` +
    `${linkRef.current.port ?? conn.port ?? (isConsole ? 8002 : 5900)}` +
    (isConsole ? " · console" : "") +
    (via ? ` · via ${via.name}` : "");

  useEffect(() => {
    if (!settings.statusBar || connectedAt === null) {
      setUptime("");
      return;
    }
    const tick = () => setUptime(formatDuration(Date.now() - connectedAt));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [settings.statusBar, connectedAt]);

  const resizeFb = (w: number, h: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = w;
    canvas.height = h;
    fbRef.current = { w, h };
    setFb({ w, h });
  };

  /** Apply one screen packet from the backend to the canvas. */
  const draw = (buf: ArrayBuffer) => {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    const dv = new DataView(buf);
    let p = 0;
    while (p < buf.byteLength) {
      const tag = dv.getUint8(p);
      p += 1;
      if (tag === PKT_RECT || tag === PKT_CURSOR) {
        const x = dv.getUint16(p, true);
        const y = dv.getUint16(p + 2, true);
        const w = dv.getUint16(p + 4, true);
        const h = dv.getUint16(p + 6, true);
        p += 8;
        const len = w * h * 4;
        if (tag === PKT_RECT) {
          if (len) ctx.putImageData(new ImageData(new Uint8ClampedArray(buf, p, len), w, h), x, y);
        } else {
          setCursor(cursorCss(new Uint8ClampedArray(buf.slice(p, p + len)), w, h, x, y));
        }
        p += len;
      } else if (tag === PKT_COPY) {
        const x = dv.getUint16(p, true);
        const y = dv.getUint16(p + 2, true);
        const w = dv.getUint16(p + 4, true);
        const h = dv.getUint16(p + 6, true);
        const sx = dv.getUint16(p + 8, true);
        const sy = dv.getUint16(p + 10, true);
        p += 12;
        if (w && h) ctx.drawImage(canvas, sx, sy, w, h, x, y, w, h);
      } else if (tag === PKT_RESIZE) {
        resizeFb(dv.getUint16(p, true), dv.getUint16(p + 2, true));
        p += 4;
      } else {
        return; // unknown record: the rest of the packet can't be framed
      }
    }
  };

  /**
   * Open the backend session. `secret` overrides the saved password (and
   * fills a missing username) for this attempt only, as in TerminalView.
   */
  const connect = async (secret?: { password: string; username?: string }) => {
    const life = lifeRef.current;
    if (backendId.current || connectingRef.current) return;
    if (isConsole && !tokenRef.current) {
      setTokenAsk({});
      return;
    }
    connectingRef.current = true;
    setStatus(session.id, "connecting");
    setNote("");
    const attempt: Connection = {
      ...conn,
      ...linkRef.current,
      ...(secret ? { password: secret.password } : {}),
      ...(secret?.username ? { username: secret.username } : {}),
    };

    // Per-attempt state: packets can arrive before vncConnect resolves (the
    // first screen is requested during the handshake), and events from an
    // abandoned attempt must not touch a newer one.
    const att = { id: null as string | null, unacked: 0, closed: null as string | null };
    const onFrame = (buf: ArrayBuffer) => {
      if (life.dead) return;
      draw(buf);
      if (att.id) vncAck(att.id).catch(() => {});
      else att.unacked++;
    };
    const onEvent = (ev: VncEvent) => {
      if (life.dead) return;
      if (ev.kind === "closed") {
        if (att.id) handleDrop(att.id, ev.reason);
        else att.closed = ev.reason;
      } else if (ev.kind === "clipboard") {
        lastClipRef.current = ev.text;
        clipboardWrite(ev.text)
          .then(() => setNote("Remote clipboard copied"))
          .catch(() => {});
      }
    };

    try {
      let viaConn: Connection | null = null;
      if (attempt.vncViaSsh) {
        viaConn =
          useStore.getState().connections.find((c) => c.id === attempt.vncViaSsh) ?? null;
        if (!viaConn) {
          throw "The SSH connection this session is routed through no longer exists — edit the connection";
        }
      }
      const h = await vncConnect(
        attempt,
        viaConn,
        isConsole ? tokenRef.current : null,
        onFrame,
        onEvent
      );
      if (life.dead) {
        vncClose(h.id).catch(() => {});
        return;
      }
      att.id = h.id;
      backendId.current = h.id;
      for (; att.unacked > 0; att.unacked--) vncAck(h.id).catch(() => {});
      setHello(h);
      setConnectedAt(Date.now());
      setStatus(session.id, "connected");
      setAuthError(null);

      // Accepted, so now it's worth keeping — never before, or a second wrong
      // guess could overwrite a working password.
      const store = useStore.getState();
      if (
        secret &&
        store.settings.saveRetriedCredentials &&
        store.connections.some((c) => c.id === conn.id)
      ) {
        store.updateConnection(conn.id, {
          password: secret.password,
          ...(secret.username ? { username: secret.username } : {}),
        });
      }
      if (att.closed !== null) handleDrop(h.id, att.closed);
      else canvasRef.current?.focus();
    } catch (e) {
      if (life.dead) return;
      const message = String(e);
      setStatus(session.id, "error", message);
      if (isAuthFailure(message)) setAuthError(message);
      else if (isConsole && /token|console proxy/i.test(message)) setTokenAsk({ error: message });
    } finally {
      if (lifeRef.current === life) connectingRef.current = false;
      setAuthBusy(false);
    }
  };

  const handleDrop = (id: string, reason: string) => {
    if (backendId.current !== id) return;
    backendId.current = null;
    vncClose(id).catch(() => {});
    pressedRef.current.clear();
    buttonsRef.current = 0;
    setConnectedAt(null);
    const failed = reason !== "connection closed";
    setStatus(session.id, failed ? "error" : "closed", failed ? reason : undefined);
  };

  useEffect(() => {
    const life = { dead: false };
    lifeRef.current = life;
    connectingRef.current = false;
    const canvas = canvasRef.current!;
    ctxRef.current = canvas.getContext("2d", { alpha: false });

    // Native listener: React's wheel handler is passive, so it can't stop the
    // page scrolling.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const id = backendId.current;
      if (!id || viewOnlyRef.current) return;
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      const acc = wheelRef.current;
      acc.x += e.deltaX * unit;
      acc.y += e.deltaY * unit;
      const { x, y } = toFb(e.clientX, e.clientY);
      const b = buttonsRef.current;
      // Each scroll step is a press and release of a wheel "button".
      const click = (bit: number) => {
        vncPointer(id, x, y, b | bit).catch(() => {});
        vncPointer(id, x, y, b).catch(() => {});
      };
      for (; acc.y <= -WHEEL_STEP; acc.y += WHEEL_STEP) click(8);
      for (; acc.y >= WHEEL_STEP; acc.y -= WHEEL_STEP) click(16);
      for (; acc.x <= -WHEEL_STEP; acc.x += WHEEL_STEP) click(32);
      for (; acc.x >= WHEEL_STEP; acc.x -= WHEEL_STEP) click(64);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    connect();

    return () => {
      life.dead = true;
      canvas.removeEventListener("wheel", onWheel);
      cancelAnimationFrame(moveRafRef.current);
      if (backendId.current) {
        vncClose(backendId.current).catch(() => {});
        backendId.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scale to fit the pane (both up and down), or show 1:1 and scroll.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const update = () => {
      const { w, h } = fbRef.current;
      if (!fit || !w || !h) {
        setScale(1);
        return;
      }
      // A hidden tab measures 0×0; keep the last scale until it shows again.
      if (!wrap.clientWidth || !wrap.clientHeight) return;
      setScale(Math.min(wrap.clientWidth / w, wrap.clientHeight / h));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [fit, fb]);

  const toggleFit = () => {
    const next = !fit;
    setFit(next);
    try {
      localStorage.setItem(FIT_KEY, next ? "fit" : "actual");
    } catch {
      /* per-viewer nicety only */
    }
  };

  /** Client coordinates → framebuffer pixel, clamped to the screen. */
  const toFb = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const { w, h } = fbRef.current;
    if (!canvas || !w || !h) return { x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    const x = Math.floor(((clientX - r.left) / r.width) * w);
    const y = Math.floor(((clientY - r.top) / r.height) * h);
    return { x: Math.max(0, Math.min(w - 1, x)), y: Math.max(0, Math.min(h - 1, y)) };
  };

  const sendPointer = () => {
    const id = backendId.current;
    if (!id || viewOnlyRef.current) return;
    vncPointer(id, posRef.current.x, posRef.current.y, buttonsRef.current).catch(() => {});
  };

  const onPointerMove = (e: React.PointerEvent) => {
    posRef.current = toFb(e.clientX, e.clientY);
    // At most one motion event per frame; button changes go out immediately.
    if (!moveRafRef.current) {
      moveRafRef.current = requestAnimationFrame(() => {
        moveRafRef.current = 0;
        sendPointer();
      });
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    posRef.current = toFb(e.clientX, e.clientY);
    buttonsRef.current = rfbButtons(e.buttons);
    sendPointer();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    posRef.current = toFb(e.clientX, e.clientY);
    buttonsRef.current = rfbButtons(e.buttons);
    sendPointer();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const id = backendId.current;
    if (!id || viewOnly) return;
    // Everything goes to the remote — Tab, F5, Ctrl+W included — and nothing
    // reaches the app's own shortcuts while the screen has focus.
    e.preventDefault();
    e.stopPropagation();
    const key = keyFromEvent(e.nativeEvent);
    if (!key) return;
    pressedRef.current.set(e.code || e.key, key);
    vncKey(id, key.keysym, key.code, true).catch(() => {});
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    const id = backendId.current;
    if (!id || viewOnly) return;
    e.preventDefault();
    e.stopPropagation();
    const slot = e.code || e.key;
    const key = pressedRef.current.get(slot) ?? keyFromEvent(e.nativeEvent);
    pressedRef.current.delete(slot);
    if (key) vncKey(id, key.keysym, key.code, false).catch(() => {});
  };

  /** Let go of everything held, so leaving the window can't strand a key. */
  const releaseAll = () => {
    const id = backendId.current;
    if (id) {
      for (const k of pressedRef.current.values()) {
        vncKey(id, k.keysym, k.code, false).catch(() => {});
      }
      if (buttonsRef.current) {
        buttonsRef.current = 0;
        sendPointer();
      }
    }
    pressedRef.current.clear();
  };

  // Local clipboard → server when the screen takes focus, the way desktop
  // VNC viewers sync it. Consoles without a clipboard ignore it; for those
  // there is "Type clipboard".
  const onFocus = async () => {
    const id = backendId.current;
    if (!id || viewOnlyRef.current) return;
    try {
      const text = await clipboardRead();
      if (text && text !== lastClipRef.current) {
        lastClipRef.current = text;
        vncClipboard(id, text).catch(() => {});
      }
    } catch {
      /* clipboard unavailable — nothing to sync */
    }
  };

  const sendCtrlAltDel = () => {
    const id = backendId.current;
    if (!id) return;
    for (const k of CTRL_ALT_DEL) vncKey(id, k.keysym, k.code, true).catch(() => {});
    for (const k of [...CTRL_ALT_DEL].reverse()) {
      vncKey(id, k.keysym, k.code, false).catch(() => {});
    }
    setNote("Sent Ctrl+Alt+Del");
    canvasRef.current?.focus();
  };

  const startTyping = (text: string) => {
    const id = backendId.current;
    if (!id) return;
    vncType(id, text)
      .then(() => setNote(`Typing ${[...text].length} characters…`))
      .catch((e) => setNote(String(e)));
    canvasRef.current?.focus();
  };

  /** Type the local clipboard as keystrokes — for consoles with no clipboard. */
  const typeClipboard = async () => {
    if (!backendId.current) return;
    let text = "";
    try {
      text = await clipboardRead();
    } catch (e) {
      setNote(`Clipboard unavailable: ${String(e)}`);
      return;
    }
    if (!text) {
      setNote("Clipboard is empty");
      return;
    }
    // Each newline is an Enter on the remote, same footgun as a terminal paste.
    if (settings.pasteWarnMultiline && splitPasteLines(text).length > 1) {
      setTypePending(text);
      return;
    }
    startTyping(text);
  };

  const reconnect = () => {
    if (connectingRef.current) return;
    setAuthError(null);
    // Console tokens are usually single-use: offer the last one, but let a
    // fresh link be pasted.
    if (isConsole) setTokenAsk({});
    else connect();
  };

  const submitToken = (input: string) => {
    const link = parseConsoleLink(input);
    if (link) {
      tokenRef.current = link.token;
      linkRef.current = {
        host: link.host,
        port: link.port,
        vncTls: link.tls,
        ...(link.path ? { vncPath: link.path } : {}),
      };
    } else {
      tokenRef.current = input;
    }
    setTokenAsk(null);
    connect();
  };

  const retryWithSecret = (password: string, username: string) => {
    setAuthBusy(true);
    connect({ password, username: username || undefined });
  };

  const toggleViewOnly = () => {
    if (!viewOnly) releaseAll();
    setViewOnly(!viewOnly);
    canvasRef.current?.focus();
  };

  const tint = settings.tintByConnection ? conn.color : undefined;
  const statusColor = connected
    ? "bg-ok"
    : session.status === "connecting"
      ? "bg-warn animate-pulse"
      : session.status === "error"
        ? "bg-err"
        : "bg-ink-dim";
  const toolBtn =
    "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi active:scale-[0.97] disabled:pointer-events-none disabled:opacity-30";

  return (
    <div className="relative flex h-full w-full flex-col bg-bg-base effect-base">
      <div
        className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-bg-panel effect-surface px-2"
        style={
          tint
            ? { borderBottomColor: `${tint}59`, boxShadow: `inset 3px 0 0 ${tint}` }
            : undefined
        }
      >
        <span className={`ml-1 h-1.5 w-1.5 shrink-0 rounded-full ${statusColor}`} />
        <span
          className="shrink-0 font-mono text-[10.5px] text-ink-dim"
          style={tint ? { color: tint } : undefined}
        >
          {target}
        </span>
        {note && (
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-dim">
            {note}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            onClick={sendCtrlAltDel}
            disabled={!connected || viewOnly}
            className={toolBtn}
            title="Send Ctrl+Alt+Del to the remote machine"
          >
            <Power size={14} />
            Ctrl+Alt+Del
          </button>
          <button
            onClick={typeClipboard}
            disabled={!connected || viewOnly}
            className={toolBtn}
            title="Type the clipboard as keystrokes — for consoles that have no clipboard (BIOS, KVM, login prompts). US keyboard layout."
          >
            <ClipboardType size={14} />
            Type clipboard
          </button>
          <div className="mx-1 h-4 w-px bg-edge" />
          <button
            onClick={toggleFit}
            className={toolBtn}
            title={fit ? "Show at actual size (scroll to pan)" : "Scale the screen to fit the tab"}
          >
            {fit ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            {fit ? "Fit" : "1:1"}
          </button>
          <button
            onClick={toggleViewOnly}
            className={cn(
              toolBtn,
              viewOnly && "bg-warn/15 text-warn hover:bg-warn/25 hover:text-warn"
            )}
            title={
              viewOnly
                ? "View only: keyboard and mouse are not sent. Click to take control."
                : "Watch without sending keyboard or mouse input"
            }
          >
            {viewOnly ? <EyeOff size={14} /> : <Eye size={14} />}
            {viewOnly ? "View only" : "Control"}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 p-2">
        <div
          ref={wrapRef}
          className={cn(
            "flex h-full w-full rounded-lg border border-edge bg-bg-inset transition-colors focus-within:border-accent/50",
            fit ? "overflow-hidden" : "overflow-auto"
          )}
        >
          <canvas
            ref={canvasRef}
            tabIndex={0}
            className={cn("m-auto block shrink-0 outline-none", !fb.w && "hidden")}
            style={{
              width: fb.w * scale,
              height: fb.h * scale,
              cursor: viewOnly ? "default" : cursor,
            }}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            onBlur={releaseAll}
            onFocus={onFocus}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerMove={onPointerMove}
            onContextMenu={(e) => e.preventDefault()}
          />
          {!fb.w && (
            <div className="m-auto font-mono text-[11px] text-ink-dim">
              {session.status === "connecting"
                ? `connecting to ${conn.name} …`
                : session.status === "error"
                  ? "not connected"
                  : ""}
            </div>
          )}
        </div>
      </div>

      {settings.statusBar && (
        <div
          className="flex h-6 shrink-0 items-center gap-3 border-t border-edge bg-bg-panel effect-surface px-3 font-mono text-[10px] text-ink-dim"
          style={tint ? { borderTopColor: `${tint}66` } : undefined}
        >
          <span className="flex items-center gap-1.5">
            <span className={`h-1 w-1 shrink-0 rounded-full ${statusColor}`} />
            {session.status}
          </span>
          {hello?.name && (
            <span className="min-w-0 truncate text-ink-mid" title="Desktop name">
              {hello.name}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {viewOnly && <span className="text-warn">view only</span>}
            {uptime && <span title="Time connected">{uptime}</span>}
            {fb.w > 0 && (
              <span title="Remote screen size">
                {fb.w}×{fb.h}
                {fit && Math.abs(scale - 1) > 0.01 ? ` · ${Math.round(scale * 100)}%` : ""}
              </span>
            )}
            {hello && (
              <span title="Security and protocol version">
                {hello.security} · RFB {hello.version}
              </span>
            )}
          </div>
        </div>
      )}

      {dropped && !connectingRef.current && !authError && !tokenAsk && (
        <div className="absolute left-1/2 top-12 z-10 flex -translate-x-1/2 animate-fade-up items-center gap-3 rounded-lg border border-edge bg-bg-panel/95 py-1.5 pl-3 pr-1.5 shadow-[0_12px_32px_-8px_rgba(4,10,20,0.8)] backdrop-blur-sm">
          <span className="font-mono text-[11px] text-ink-mid">
            {session.status === "error" ? "connection failed" : "connection closed"}
          </span>
          <button
            onClick={reconnect}
            className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white transition hover:bg-accent-hover active:scale-[0.97]"
          >
            <RotateCw size={12} />
            Reconnect
          </button>
        </div>
      )}

      {typePending !== null && (
        <PasteConfirm
          lines={splitPasteLines(typePending)}
          onConfirm={() => {
            const text = typePending;
            setTypePending(null);
            startTyping(text);
          }}
          onCancel={() => {
            setTypePending(null);
            canvasRef.current?.focus();
          }}
        />
      )}

      {authError !== null && (
        <PasswordPrompt
          title="Authentication failed"
          target={target}
          error={authError}
          kind="password"
          needsUsername={!conn.username?.trim() && /username/i.test(authError)}
          busy={authBusy}
          remembers={settings.saveRetriedCredentials}
          onSubmit={retryWithSecret}
          onCancel={() => setAuthError(null)}
        />
      )}

      {tokenAsk && (
        <ConsoleTokenPrompt
          target={conn.name}
          error={tokenAsk.error}
          initial={tokenRef.current ?? ""}
          onSubmit={submitToken}
          onCancel={() => {
            setTokenAsk(null);
            if (!backendId.current && session.status === "connecting") {
              setStatus(session.id, "closed");
            }
          }}
        />
      )}
    </div>
  );
}

/** CSS `cursor` value for a server-supplied cursor image. */
function cursorCss(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  w: number,
  h: number,
  hx: number,
  hy: number
) {
  if (!w || !h) return "none";
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")?.putImageData(new ImageData(rgba, w, h), 0, 0);
  return `url(${c.toDataURL()}) ${Math.min(hx, w - 1)} ${Math.min(hy, h - 1)}, default`;
}
