import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ClipboardPaste,
  Eye,
  EyeOff,
  Maximize2,
  Minimize2,
  Power,
  RotateCw,
  ScanText,
} from "lucide-react";
import { useStore } from "../store";
import {
  clipboardRead,
  clipboardWrite,
  ocrImage,
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
import { VncCopyDialog, VncPasteDialog } from "./VncTextDialogs";
import { revealChrome, useFullScreen } from "../lib/fullscreen";
import { ConsoleTokenPrompt } from "./ConsoleLinkModal";
import type { Connection, Session } from "../lib/types";
import { cn, formatDuration, isAuthFailure } from "../lib/utils";
import { useSaveConnectionPref, wheelSteps } from "../lib/zoom";

/** Ctrl+scroll zoom range and step (each notch is ×1.1). */
const SCALE_MIN = 0.1;
const SCALE_MAX = 4;
const SCALE_STEP = 1.1;
/** Wheel travel (px) per scroll click sent to the server: one mouse notch. */
const WHEEL_STEP = 100;
/**
 * Waits before each automatic reconnect after a console drops: quick for a
 * network blip, then spaced out, about two minutes in all before giving up.
 */
const RETRY_DELAYS = [1000, 2000, 5000, 10_000, 20_000, 30_000, 30_000];
/** A console up this long before it dropped gets a fresh set of retries. */
const RETRY_STABLE_MS = 30_000;

const PKT_RECT = 1;
const PKT_RESIZE = 2;
const PKT_CURSOR = 3;
const PKT_COPY = 4;

/** DOM `buttons` (left 1, right 2, middle 4) → RFB mask (left 1, middle 2, right 4). */
const rfbButtons = (b: number) => (b & 1) | (b & 4 ? 2 : 0) | (b & 2 ? 4 : 0);

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
  /** Bumped per screen reading, so a stale one can't land in a newer dialog. */
  const ocrSeqRef = useRef(0);
  /** Automatic console reconnects: the pending timer, retries used, last connect time. */
  const retryRef = useRef({ timer: 0, attempt: 0, since: 0 });

  const setStatus = useStore((s) => s.setSessionStatus);
  const settings = useStore((s) => s.settings);
  const connections = useStore((s) => s.connections);

  const [fb, setFb] = useState({ w: 0, h: 0 });
  const [hello, setHello] = useState<VncHello | null>(null);
  /**
   * Zoom set with Ctrl+scroll or the 1:1 button, remembered on the
   * connection; `null` scales the screen to fit the tab.
   */
  const [manualScale, setManualScale] = useState<number | null>(conn.vncScale ?? null);
  const fit = manualScale === null;
  const saveScale = useSaveConnectionPref(conn.id);
  const [fitScale, setFitScale] = useState(1);
  const scale = manualScale ?? fitScale;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  /** Framebuffer point to keep under the pointer across a wheel zoom. */
  const anchorRef = useRef<{ fx: number; fy: number; cx: number; cy: number } | null>(null);
  const [viewOnly, setViewOnly] = useState(false);
  const [cursor, setCursor] = useState("default");
  const [note, setNote] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [tokenAsk, setTokenAsk] = useState<{ error?: string } | null>(null);
  /** Text being reviewed before it goes to the remote; `null` when shut. */
  const [pasteText, setPasteText] = useState<string | null>(null);
  /** Text read off the screen; `text` is `null` while it's being read. */
  const [ocr, setOcr] = useState<{ text: string | null; error?: string } | null>(null);
  /** Dragging out an area of the screen to read, and the area so far (client px). */
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null
  );
  /** The window fills the monitor and this tab fills the window. */
  /** Workspace full screen: the remote screen edge to edge, controls on a slide-down bar. */
  const full = useFullScreen((s) => s.on);
  const revealed = useFullScreen((s) => s.revealed);
  const isActive = useStore((s) => s.activeSessionId === session.id);
  /** Hold the full-screen bar open for a moment, to show a note. */
  const [barShown, setBarShown] = useState(false);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [uptime, setUptime] = useState("");
  /** A dropped console is waiting to reconnect on its own. */
  const [retrying, setRetrying] = useState(false);

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
   * `auto` marks a reconnect Dshh started itself after a console dropped.
   */
  const connect = async (secret?: { password: string; username?: string }, auto = false) => {
    const life = lifeRef.current;
    if (backendId.current || connectingRef.current) return;
    window.clearTimeout(retryRef.current.timer);
    if (isConsole && !tokenRef.current) {
      setRetrying(false);
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
      setRetrying(false);
      retryRef.current.since = Date.now();
      if (auto) setNote("Reconnected");

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
      setRetrying(false);
      if (isAuthFailure(message)) setAuthError(message);
      else if (isConsole && /token|console proxy/i.test(message)) setTokenAsk({ error: message });
      // Anything else (network down, proxy unreachable) may pass; the token
      // is still worth trying until the proxy says otherwise.
      else if (auto) retryLater();
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
    // The token was only checked when the console opened, and is usually
    // still good for a while: reconnect with it straight away rather than
    // wait for a click, by which time it may have expired.
    if (isConsole) {
      const r = retryRef.current;
      if (Date.now() - r.since >= RETRY_STABLE_MS) r.attempt = 0;
      retryLater();
    }
  };

  /** Schedule the next automatic reconnect, or give up once they're spent. */
  const retryLater = () => {
    const r = retryRef.current;
    const delay = RETRY_DELAYS[r.attempt];
    if (delay === undefined) {
      setRetrying(false);
      return;
    }
    r.attempt++;
    setRetrying(true);
    window.clearTimeout(r.timer);
    r.timer = window.setTimeout(() => connectRef.current(undefined, true), delay);
  };
  const connectRef = useRef(connect);
  connectRef.current = connect;

  useEffect(() => {
    const life = { dead: false };
    lifeRef.current = life;
    connectingRef.current = false;
    const canvas = canvasRef.current!;
    ctxRef.current = canvas.getContext("2d", { alpha: false });

    // Native listener: React's wheel handler is passive, so it can't stop the
    // page scrolling.
    const zoomAcc = { v: 0 };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey) {
        const steps = wheelSteps(zoomAcc, e);
        if (!steps || !fbRef.current.w) return;
        const r = canvas.getBoundingClientRect();
        anchorRef.current = {
          fx: (e.clientX - r.left) / scaleRef.current,
          fy: (e.clientY - r.top) / scaleRef.current,
          cx: e.clientX,
          cy: e.clientY,
        };
        setZoomRef.current(scaleRef.current * SCALE_STEP ** steps);
        return;
      }
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
      window.clearTimeout(retryRef.current.timer);
      canvas.removeEventListener("wheel", onWheel);
      cancelAnimationFrame(moveRafRef.current);
      if (backendId.current) {
        vncClose(backendId.current).catch(() => {});
        backendId.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The scale that fits the pane (both up and down), tracked even while a
  // manual zoom is showing so switching back to Fit is instant.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const update = () => {
      const { w, h } = fbRef.current;
      // A hidden tab measures 0×0; keep the last scale until it shows again.
      if (!w || !h || !wrap.clientWidth || !wrap.clientHeight) return;
      setFitScale(Math.min(wrap.clientWidth / w, wrap.clientHeight / h));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [fb]);

  /** Set a manual zoom (null = fit) and remember it on the connection. */
  const setZoom = (next: number | null) => {
    const value =
      next === null ? null : Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(next * 100) / 100));
    setManualScale(value);
    saveScale({ vncScale: value ?? undefined });
  };
  const setZoomRef = useRef(setZoom);
  setZoomRef.current = setZoom;

  // Keep the point that was under the pointer there after a wheel zoom, by
  // scrolling the pane once the new size has laid out.
  useLayoutEffect(() => {
    const a = anchorRef.current;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    anchorRef.current = null;
    if (!a || !canvas || !wrap) return;
    const r = canvas.getBoundingClientRect();
    wrap.scrollLeft += r.left + a.fx * scale - a.cx;
    wrap.scrollTop += r.top + a.fy * scale - a.cy;
  }, [scale]);

  /** Fit ↔ the zoom in use; from Fit it goes to 1:1. */
  const toggleFit = () => setZoom(fit ? 1 : null);

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
    if (selecting) {
      if (sel && e.buttons & 1) setSel({ ...sel, x1: e.clientX, y1: e.clientY });
      return;
    }
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
    if (selecting) {
      if (e.button === 0) setSel({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
      else cancelSelect();
      return;
    }
    posRef.current = toFb(e.clientX, e.clientY);
    buttonsRef.current = rfbButtons(e.buttons);
    sendPointer();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (selecting) {
      if (sel) readSelection({ ...sel, x1: e.clientX, y1: e.clientY });
      return;
    }
    posRef.current = toFb(e.clientX, e.clientY);
    buttonsRef.current = rfbButtons(e.buttons);
    sendPointer();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (selecting) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") cancelSelect();
      return;
    }
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
    if (selecting) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
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

  /**
   * Open the review box, prefilled with the local clipboard. Nothing reaches
   * the remote until it's sent from there — typed, or as its clipboard.
   */
  const openPaste = async () => {
    let text = "";
    try {
      text = await clipboardRead();
    } catch {
      /* clipboard unavailable — start empty */
    }
    releaseAll();
    setPasteText(text);
  };

  const closePaste = () => {
    setPasteText(null);
    canvasRef.current?.focus();
  };

  const sendAsClipboard = (text: string) => {
    closePaste();
    const id = backendId.current;
    if (!id) return;
    vncClipboard(id, text)
      .then(() => setNote("Sent to the remote clipboard"))
      .catch((e) => setNote(String(e)));
  };

  /** Drag out an area of the screen to read its text: consoles rarely share a clipboard. */
  const startSelect = () => {
    releaseAll();
    setSel(null);
    setSelecting(true);
    canvasRef.current?.focus();
  };

  const cancelSelect = () => {
    setSelecting(false);
    setSel(null);
  };

  /** Read the text inside a dragged-out area, given in client coordinates. */
  const readSelection = (r: { x0: number; y0: number; x1: number; y1: number }) => {
    cancelSelect();
    const a = toFb(Math.min(r.x0, r.x1), Math.min(r.y0, r.y1));
    const b = toFb(Math.max(r.x0, r.x1), Math.max(r.y0, r.y1));
    const w = b.x - a.x + 1;
    const h = b.y - a.y + 1;
    const ctx = ctxRef.current;
    if (!ctx || w < 4 || h < 4) {
      setNote("Drag over the text to copy");
      return;
    }
    const pixels = ctx.getImageData(a.x, a.y, w, h).data;
    const seq = ++ocrSeqRef.current;
    setOcr({ text: null });
    canvasRef.current?.blur();
    ocrImage(w, h, new Uint8Array(pixels.buffer))
      .then((text) => seq === ocrSeqRef.current && setOcr({ text }))
      .catch((e) => seq === ocrSeqRef.current && setOcr({ text: null, error: String(e) }));
  };

  const closeOcr = () => {
    ocrSeqRef.current++;
    setOcr(null);
    canvasRef.current?.focus();
  };

  const copyText = (text: string) => {
    closeOcr();
    clipboardWrite(text)
      .then(() => setNote("Copied to your clipboard"))
      .catch((e) => setNote(`Copy failed: ${String(e)}`));
  };

  // Full screen came or went — by Ctrl+Alt+Enter, typically, whose Ctrl and
  // Alt already went down on the remote (the Enter never reaches it): let go
  // of them there. Then the visible screen takes the keyboard again, and a
  // leftover note makes way for the exit hint on the bar.
  useEffect(() => {
    releaseAll();
    if (full) setNote("");
    if (isActive) requestAnimationFrame(() => canvasRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full]);

  // Esc pressed outside the screen still cancels a selection.
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancelSelect();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selecting]);

  // In full screen the toolbar's note is out of sight, so a new one opens
  // the bar for a moment instead.
  useEffect(() => {
    if (full && note) setBarShown(true);
  }, [full, note]);

  useEffect(() => {
    if (!barShown) return;
    const t = window.setTimeout(() => setBarShown(false), 2500);
    return () => window.clearTimeout(t);
  }, [barShown, note]);

  const reconnect = () => {
    if (connectingRef.current) return;
    setAuthError(null);
    // Mid-retry, just try the same token now. Otherwise the token may well
    // have expired: offer the last one, but let a fresh link be pasted.
    if (retrying) connect(undefined, true);
    else if (isConsole) setTokenAsk({});
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
    "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi active:scale-[0.97] disabled:pointer-events-none disabled:opacity-30";

  // The same controls sit in the toolbar and on the full-screen bar.
  const actions = (
    <>
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
        onClick={openPaste}
        disabled={!connected || viewOnly}
        className={toolBtn}
        title="Review and edit text — your clipboard to start with — then type it into the remote machine"
      >
        <ClipboardPaste size={14} />
        Paste
      </button>
      <button
        onClick={selecting ? cancelSelect : startSelect}
        disabled={!fb.w}
        className={cn(toolBtn, selecting && "bg-accent/15 text-accent hover:text-accent")}
        title="Copy text off the screen: drag over it, check what was read, then copy it to your clipboard"
      >
        <ScanText size={14} />
        Copy text
      </button>
      <div className="mx-1 h-4 w-px shrink-0 bg-edge" />
      <button
        onClick={toggleFit}
        className={toolBtn}
        title={
          fit
            ? "Scaled to fit · click for actual size · Ctrl+scroll to zoom"
            : "Zoomed · click to fit · Ctrl+scroll to zoom"
        }
      >
        {fit ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        {fit ? "Fit" : `${Math.round(scale * 100)}%`}
      </button>
      <button
        onClick={toggleViewOnly}
        className={cn(toolBtn, viewOnly && "bg-warn/15 text-warn hover:bg-warn/25 hover:text-warn")}
        title={
          viewOnly
            ? "View only: keyboard and mouse are not sent. Click to take control."
            : "Watch without sending keyboard or mouse input"
        }
      >
        {viewOnly ? <EyeOff size={14} /> : <Eye size={14} />}
        {viewOnly ? "View only" : "Control"}
      </button>
    </>
  );

  return (
    <div
      className={cn(
        "flex flex-col",
        "relative h-full w-full",
        full ? "bg-black" : "bg-bg-base effect-base"
      )}
    >
      {!full && (
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
          <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>
        </div>
      )}

      {full && (
        // The toolbar's controls, on a bar that slides down with the tab bar
        // when the pointer touches the top edge (and on its own for a note).
        // Only the bar takes the pointer, so the screen's top stays usable.
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-2">
          <div
            onMouseEnter={() => revealChrome(true)}
            onMouseLeave={() => revealChrome(false)}
            className={cn(
              "pointer-events-auto relative flex min-w-0 max-w-full items-center gap-1 rounded-lg border border-edge bg-bg-panel/95 py-1 pl-3 pr-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.9)] backdrop-blur-sm transition-transform duration-150",
              revealed ? "mt-11" : "mt-1",
              revealed || barShown ? "translate-y-0" : "-translate-y-[calc(100%+48px)]"
            )}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusColor}`} />
            <span className="ml-1 min-w-0 truncate font-mono text-[10.5px] text-ink-dim">{target}</span>
            <span className="ml-2 min-w-0 max-w-[280px] truncate font-mono text-[10.5px] text-ink-mid">
              {note || "Ctrl+Alt+Enter leaves full screen"}
            </span>
            <div className="mx-1 h-4 w-px shrink-0 bg-edge" />
            {actions}
          </div>
        </div>
      )}

      <div className={cn("min-h-0 flex-1", !full && "p-2")}>
        <div
          ref={wrapRef}
          className={cn(
            "flex h-full w-full",
            !full &&
              "rounded-lg border border-edge bg-bg-inset transition-colors focus-within:border-accent/50",
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
              cursor: selecting ? "crosshair" : viewOnly ? "default" : cursor,
            }}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            onBlur={releaseAll}
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

      {settings.statusBar && !full && (
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
                {Math.abs(scale - 1) > 0.01 ? ` · ${Math.round(scale * 100)}%` : ""}
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
            {retrying
              ? "connection lost · reconnecting…"
              : session.status === "error"
                ? "connection failed"
                : "connection closed"}
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

      {selecting &&
        createPortal(
          <>
            <div className="pointer-events-none fixed left-1/2 top-3 z-[80] -translate-x-1/2 animate-fade-up rounded-lg border border-accent/40 bg-bg-panel/95 px-3 py-1.5 font-mono text-[11px] text-ink-mid shadow-[0_12px_32px_-8px_rgba(4,10,20,0.8)] backdrop-blur-sm">
              Drag over the text to copy · Esc cancels
            </div>
            {sel && (
              <div
                className="pointer-events-none fixed z-[80] border border-accent bg-accent/15"
                style={{
                  left: Math.min(sel.x0, sel.x1),
                  top: Math.min(sel.y0, sel.y1),
                  width: Math.abs(sel.x1 - sel.x0),
                  height: Math.abs(sel.y1 - sel.y0),
                }}
              />
            )}
          </>,
          document.body
        )}

      {pasteText !== null && (
        <VncPasteDialog
          initial={pasteText}
          target={conn.name}
          onType={(text) => {
            closePaste();
            startTyping(text);
          }}
          onSendClipboard={sendAsClipboard}
          onCancel={closePaste}
        />
      )}

      {ocr && (
        <VncCopyDialog
          text={ocr.text}
          error={ocr.error}
          onCopy={copyText}
          onReselect={() => {
            closeOcr();
            startSelect();
          }}
          onCancel={closeOcr}
        />
      )}

      {authError !== null && (
        <PasswordPrompt
          title="Authentication failed"
          target={target}
          kind="password"
          needsUsername={!conn.username?.trim() && /username/i.test(authError)}
          busy={authBusy}
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
