import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleStop,
  Clock,
  FolderTree,
  ListVideo,
  Network,
  RadioTower,
  RotateCw,
  Save,
  Search,
  X,
} from "lucide-react";
import { useStore } from "../store";
import {
  sshConnect,
  sshWrite,
  sshResize,
  sshDisconnect,
  serialOpen,
  serialWrite,
  serialClose,
  localOpen,
  localWrite,
  localResize,
  localClose,
  telnetOpen,
  telnetWrite,
  telnetClose,
  logStart,
  logStop,
  saveTextFile,
  defaultLogDir,
  clipboardRead,
  clipboardWrite,
  appVersion,
} from "../lib/api";
import {
  broadcastToTerminals,
  registerTerminal,
  unregisterTerminal,
} from "../lib/terminalRegistry";
import { applyHighlights, compileRules, type CompiledRule } from "../lib/highlight";
import { resolveTheme } from "../lib/themes";
import { connectBanner } from "../lib/banner";
import { PasteConfirm } from "./PasteConfirm";
import { PasswordPrompt } from "./PasswordPrompt";
import { TunnelsModal } from "./TunnelsModal";
import { ScpModal } from "./ScpModal";
import type { Connection, Session } from "../lib/types";
import {
  cn,
  formatClock,
  formatDuration,
  isAuthFailure,
  sanitizeFilename,
  splitPasteLines,
  timestamp,
} from "../lib/utils";

const SEARCH_DECORATIONS = {
  matchBackground: "#33415e",
  matchOverviewRuler: "#5b8cff",
  activeMatchBackground: "#5b8cff",
  activeMatchColorOverviewRuler: "#7ca4ff",
};

export function TerminalView({
  session,
  conn,
}: {
  session: Session;
  conn: Connection;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const backendId = useRef<string | null>(null);
  const connectingRef = useRef(false);
  // One "life" per mount; async callbacks compare against the current one so
  // a StrictMode remount or a stale connect can't leak a live connection.
  const lifeRef = useRef<{ dead: boolean }>({ dead: false });
  // Last terminal size pushed to the backend PTY. Lets every path that re-fits
  // the grid (font load, container resize, reconnect) keep the remote shell's
  // wrap width in lock-step with what xterm actually renders, and guards
  // against redundant window-change spam.
  const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });

  const setStatus = useStore((s) => s.setSessionStatus);
  const openSession = useStore((s) => s.openSession);
  const settings = useStore((s) => s.settings);
  const activeTunnels = useStore((s) => s.activeTunnels);
  const liveConn =
    useStore((s) => s.connections.find((c) => c.id === conn.id)) ?? conn;

  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState<string>("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tunnelsOpen, setTunnelsOpen] = useState(false);
  const [scpOpen, setScpOpen] = useState(false);
  /** Label being typed to save a just-finished macro recording. */
  const [macroLabel, setMacroLabel] = useState<string | null>(null);
  /** Measured terminal grid, shown in the status bar. */
  const [grid, setGrid] = useState({ cols: 0, rows: 0 });
  /** When the current connection came up, for the status bar's uptime. */
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [uptime, setUptime] = useState("");
  /** Server rejected our saved credential; holds the message to show. */
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  /** Wall clock in the status bar, MobaXterm-style. */
  const [clock, setClock] = useState(() => formatClock());

  const recordingMacroFor = useStore((s) => s.recordingMacroFor);
  const recordingSteps = useStore((s) => s.recordingSteps);
  const recordingMacro = recordingMacroFor === session.id;
  // Line assembled from keystrokes while recording. The shell's echo can't be
  // used for this — it carries prompts, colour and completions — so the
  // recorder tracks what was actually typed.
  const macroLineRef = useRef("");

  const isSsh = session.protocol === "ssh";
  const isLocal = session.protocol === "local";
  const isTelnet = session.protocol === "telnet";
  const isSerial = session.protocol === "serial";
  const broadcastInput = useStore((s) => s.broadcastInput);
  const toggleBroadcast = useStore((s) => s.toggleBroadcast);
  // Both SSH and local run over a PTY, so both need window-size sync.
  const usesPty = isSsh || isLocal;
  const connected = session.status === "connected";
  const dropped = session.status === "closed" || session.status === "error";
  const runningTunnels = useMemo(
    () => (liveConn.tunnels ?? []).filter((t) => activeTunnels[t.id]).length,
    [liveConn.tunnels, activeTunnels]
  );

  // Terminal look, with per-connection overrides winning over the global
  // preference — that is what lets one host be marked out with its own palette.
  const appearance = useMemo(
    () => ({
      fontFamily: settings.fontFamily,
      fontSize: liveConn.fontSize ?? settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      scrollback: settings.scrollback,
      theme: resolveTheme(liveConn.themeId ?? settings.themeId).colors,
    }),
    [
      settings.fontFamily,
      settings.fontSize,
      settings.lineHeight,
      settings.cursorStyle,
      settings.cursorBlink,
      settings.scrollback,
      settings.themeId,
      liveConn.fontSize,
      liveConn.themeId,
    ]
  );
  // Read by the mount effect, which must not re-run when appearance changes —
  // rebuilding the Terminal would drop the scrollback and the live connection.
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  // Same reason, for the handlers that only read settings when they fire.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Push appearance changes onto the live terminal instead of recreating it.
  // Font metrics drive the column count, so a size change has to re-fit and
  // re-notify the remote PTY or the shell keeps wrapping at the old width.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = appearance.fontFamily;
    term.options.fontSize = appearance.fontSize;
    term.options.lineHeight = appearance.lineHeight;
    term.options.cursorStyle = appearance.cursorStyle;
    term.options.cursorBlink = appearance.cursorBlink;
    term.options.scrollback = appearance.scrollback;
    term.options.theme = appearance.theme;
    syncSize();
  }, [appearance]);

  // Tick the status bar's uptime. Only runs while the bar is actually visible
  // and a connection is up, so an idle app isn't re-rendering every second.
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

  // Wall clock in the coloured status bar. Ticks on the minute boundary rather
  // than every second, since that is all the display resolves.
  useEffect(() => {
    if (!settings.statusBar || !settings.colorStatusBar) return;
    setClock(formatClock());
    const id = setInterval(() => setClock(formatClock()), 15000);
    return () => clearInterval(id);
  }, [settings.statusBar, settings.colorStatusBar]);

  // Highlight rules live in a ref so the byte pipeline reads the latest
  // settings without re-connecting.
  const rulesRef = useRef<{ enabled: boolean; compiled: CompiledRule[] }>({
    enabled: false,
    compiled: [],
  });
  useEffect(() => {
    rulesRef.current = {
      enabled: settings.highlightEnabled,
      compiled: compileRules(settings.highlightRules),
    };
  }, [settings.highlightEnabled, settings.highlightRules]);

  // Push the current grid size to the backend PTY. A stale width is what makes
  // line editing (←/→, backspace, history recall) smear across the wrong
  // columns until the next fresh prompt. Only emits when the size changed and
  // the grid is actually measured (a hidden split pane fits to 0×0).
  const pushResize = () => {
    const term = termRef.current;
    if (!term || !backendId.current || !usesPty) return;
    const { cols, rows } = term;
    if (!cols || !rows) return;
    if (cols === lastSizeRef.current.cols && rows === lastSizeRef.current.rows) return;
    lastSizeRef.current = { cols, rows };
    (isLocal ? localResize : sshResize)(backendId.current, cols, rows).catch(() => {});
  };

  const syncSize = () => {
    fitRef.current?.fit();
    const term = termRef.current;
    // Mirror the measured grid for the status bar. A hidden split pane fits to
    // 0×0, which is not worth showing.
    if (term?.cols && term?.rows) setGrid({ cols: term.cols, rows: term.rows });
    pushResize();
  };

  // Single keystroke/paste sink so every transport writes through one place.
  const writeBackend = (data: string) => {
    const id = backendId.current;
    if (!id) return;
    (isSsh ? sshWrite : isLocal ? localWrite : isTelnet ? telnetWrite : serialWrite)(
      id,
      data
    );
  };

  /**
   * Feed keystrokes to the macro recorder, reconstructing command lines as they
   * are typed. Only the plain editing keys are honoured: arrow keys, tabs and
   * control sequences depend on shell state we can't replay, so a line that
   * used them is captured as whatever visible text remained.
   */
  const recordKeystrokes = (data: string) => {
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        useStore.getState().recordStep(macroLineRef.current);
        macroLineRef.current = "";
      } else if (ch === "\x7f" || ch === "\b") {
        macroLineRef.current = macroLineRef.current.slice(0, -1);
      } else if (ch === "\x03" || ch === "\x15") {
        // Ctrl+C / Ctrl+U abandon the line rather than submitting it.
        macroLineRef.current = "";
      } else if (ch >= " ") {
        macroLineRef.current += ch;
      }
    }
  };

  // Multi-execution: mirror typed input to every other live terminal.
  const handleInput = (data: string) => {
    if (useStore.getState().recordingMacroFor === session.id) recordKeystrokes(data);
    if (useStore.getState().broadcastInput) {
      const others = useStore
        .getState()
        .sessions.filter((s) => s.id !== session.id && s.status === "connected")
        .map((s) => s.id);
      broadcastToTerminals(others, data);
    }
    writeBackend(data);
  };

  /**
   * Clipboard text waiting on the multi-line confirmation, or null when
   * nothing is pending.
   */
  const [pastePending, setPastePending] = useState<string | null>(null);

  /**
   * Every paste funnels through here. A multi-line paste is the classic
   * footgun — each newline is an Enter to the shell, so a stray copy runs
   * commands instead of typing them — so those stop for confirmation showing
   * the exact lines. Single-line pastes go straight through.
   */
  const guardedPaste = (text: string) => {
    const term = termRef.current;
    if (!term || !text) return;
    if (settingsRef.current.pasteWarnMultiline && splitPasteLines(text).length > 1) {
      setPastePending(text);
      return;
    }
    // paste() rather than writeBackend(): it applies bracketed-paste mode and
    // newline normalisation, and emits through onData, so broadcast and the
    // macro recorder see it exactly like typed input.
    term.paste(text);
  };
  // The DOM paste listener is registered once, on mount; it reads the current
  // guard through this ref rather than closing over a stale render.
  const pasteRef = useRef(guardedPaste);
  pasteRef.current = guardedPaste;

  const confirmPaste = () => {
    const text = pastePending;
    setPastePending(null);
    const term = termRef.current;
    if (term && text) term.paste(text);
    term?.focus();
  };

  const cancelPaste = () => {
    setPastePending(null);
    termRef.current?.focus();
  };

  /**
   * PuTTY/MobaXterm-style right click: copy when text is selected, paste when
   * nothing is. Copying also drops the selection, so "select a line, right
   * click to copy, right click again to paste" falls out of the same gesture
   * with no menu in the way.
   */
  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const term = termRef.current;
    if (!term) return;
    const selection = term.getSelection();
    if (selection) {
      try {
        await clipboardWrite(selection);
        term.clearSelection();
      } catch (err) {
        setNote(`Copy failed: ${String(err)}`);
      }
    } else {
      try {
        guardedPaste(await clipboardRead());
      } catch (err) {
        setNote(`Paste failed: ${String(err)}`);
      }
    }
    term.focus();
  };

  /**
   * The credential a rejected connection could be retried with, or null when
   * there is nothing to type: agent auth keeps the key out of this process,
   * telnet asks in-band, and serial/local don't authenticate at all.
   */
  const retryField: "password" | "passphrase" | null = !isSsh
    ? null
    : liveConn.authMethod === "agent"
      ? null
      : liveConn.authMethod === "key"
        ? "passphrase"
        : "password";

  /**
   * Open the backend connection for this tab.
   *
   * `secret` overrides the saved password/passphrase for this attempt only —
   * that is what lets the retry after an auth failure run without first writing
   * a credential the server hasn't accepted yet.
   */
  const connect = async (secret?: {
    field: "password" | "passphrase";
    value: string;
    /** Write it back to the saved connection once the server accepts it. */
    remember: boolean;
  }) => {
    const term = termRef.current;
    const life = lifeRef.current;
    if (!term || backendId.current || connectingRef.current) return;
    connectingRef.current = true;
    setStatus(session.id, "connecting");
    const attemptConn: Connection = secret
      ? { ...conn, [secret.field]: secret.value }
      : conn;
    try {
      term.writeln(
        `\x1b[90m· ${isLocal ? "starting" : "connecting to"} ${conn.name} …\x1b[0m`
      );
      const decoder = new TextDecoder();
      const onData = (bytes: Uint8Array) => {
        const text = decoder.decode(bytes, { stream: true });
        const { enabled, compiled } = rulesRef.current;
        term.write(enabled && compiled.length ? applyHighlights(text, compiled) : text);
      };
      // Remote hangup / network drop / server-side exit, or a local shell that
      // ran `exit`. The UI then offers a reconnect (respawn for local).
      const onClosed = () => {
        if (life.dead || !backendId.current) return;
        backendId.current = null;
        setConnectedAt(null);
        setRecording(false);
        unregisterTerminal(session.id);
        useStore.getState().setSessionStatus(session.id, "closed");
        term.writeln(`\r\n\x1b[90m· ${isLocal ? "shell exited" : "connection closed"}\x1b[0m`);
      };

      const id = isSsh
        ? await sshConnect(attemptConn, onData, onClosed)
        : isLocal
          ? await localOpen(
              conn.shell ?? "cmd",
              conn.cwd ?? null,
              term.cols,
              term.rows,
              onData,
              onClosed
            )
          : isTelnet
            ? await telnetOpen(attemptConn, onData, onClosed)
            : await serialOpen(conn, onData);

      if (life.dead) {
        // Component unmounted while the handshake was in flight.
        (isSsh
          ? sshDisconnect(id)
          : isLocal
            ? localClose(id)
            : isTelnet
              ? telnetClose(id)
              : serialClose(id)
        ).catch(() => {});
        return;
      }

      backendId.current = id;
      setConnectedAt(Date.now());
      setStatus(session.id, "connected");
      setAuthError(null);

      // The server accepted it, so now it is worth keeping. Transient
      // connections (one-off local shells) aren't in the saved list; writing
      // them back would resurrect a tab the user never saved.
      if (secret?.remember && useStore.getState().connections.some((c) => c.id === conn.id)) {
        useStore.getState().updateConnection(conn.id, { [secret.field]: secret.value });
      }
      registerTerminal(session.id, {
        send: (d) => writeBackend(d),
        focus: () => term.focus(),
      });

      // MobaXterm's login banner: what this tab is attached to, in colour,
      // written before the remote shell's own greeting arrives.
      if (useStore.getState().settings.connectBanner) {
        const version = await appVersion().catch(() => "");
        if (!life.dead && backendId.current === id) {
          for (const line of connectBanner(liveConn, session.protocol, version)) {
            term.writeln(line);
          }
        }
      }

      // Fresh backend PTY defaults to 80×24; force the first size push (the
      // reset defeats pushResize's "unchanged" guard on reconnect). No-op for
      // serial, which has no window size.
      lastSizeRef.current = { cols: 0, rows: 0 };
      pushResize();

      // MobaXterm-style "execute on login". Serial has no shell to greet us,
      // and a remote prompt needs a beat to appear, so give it one before
      // typing — otherwise the line lands mid-banner and gets eaten.
      const onLogin = liveConn.runOnConnect?.trim();
      if (onLogin && !isSerial) {
        setTimeout(() => {
          if (!life.dead && backendId.current === id) writeBackend(`${onLogin}\r`);
        }, 400);
      }

      const st = useStore.getState().settings;
      // No folder chosen falls back to the portable data folder, so auto-log
      // works out of the box instead of silently doing nothing.
      const autoDir = st.logDir || (await defaultLogDir());
      if (st.autoLog && autoDir) {
        const path = autoLogPath(autoDir, conn.name);
        try {
          await logStart(id, path);
          setRecording(true);
          setNote(`Auto-logging to ${path}`);
        } catch (e) {
          setNote(`Auto-log failed: ${String(e)}`);
        }
      }
    } catch (e) {
      if (!life.dead) {
        const message = String(e);
        setStatus(session.id, "error", message);
        term.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
        // A rejected credential is worth asking about rather than leaving a
        // dead tab: the fix is one field, and the user is looking right at it.
        if (retryField && isAuthFailure(message)) setAuthError(message);
      }
    } finally {
      connectingRef.current = false;
      setAuthBusy(false);
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const life = { dead: false };
    lifeRef.current = life;

    // Read through the ref: this effect must not re-run on appearance changes
    // (that would tear down the connection), so a separate effect pushes later
    // edits onto the live terminal.
    const term = new Terminal({ ...appearanceRef.current, allowProposedApi: true });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    term.onData((d) => handleInput(d));

    // Catch every paste route the webview offers — Ctrl+V, Ctrl+Shift+V,
    // Shift+Insert, the webview's own menu — in the capture phase, before
    // xterm's handler on the hidden textarea sees it, so the multi-line guard
    // can't be walked around by using a different shortcut.
    const host = containerRef.current;
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text") ?? "";
      if (!text) return;
      e.preventDefault();
      e.stopPropagation();
      pasteRef.current(text);
    };
    host.addEventListener("paste", onPaste, true);

    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey && (e.key === "f" || e.key === "F")) {
        setSearchOpen(true);
        return false;
      }
      return true;
    });

    // Variable fonts can land after the first fit and change the cell metrics
    // (and therefore the column count). Re-fit AND push the new size, or the
    // remote PTY keeps wrapping at the pre-font width — the root cause of
    // smeared line editing.
    document.fonts?.ready.then(() => {
      if (!life.dead) syncSize();
    });

    connect();

    const ro = new ResizeObserver(() => syncSize());
    ro.observe(containerRef.current);

    return () => {
      life.dead = true;
      host.removeEventListener("paste", onPaste, true);
      ro.disconnect();
      unregisterTerminal(session.id);
      if (backendId.current) {
        (isSsh
          ? sshDisconnect(backendId.current)
          : isLocal
            ? localClose(backendId.current)
            : isTelnet
              ? telnetClose(backendId.current)
              : serialClose(backendId.current)
        ).catch(() => {});
        backendId.current = null;
      }
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dumpBuffer = (): string => {
    const term = termRef.current;
    if (!term) return "";
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n") + "\n";
  };

  const saveOutput = async () => {
    const path = await saveDialog({
      defaultPath: `${sanitizeFilename(conn.name)}_${timestamp()}.txt`,
      filters: [{ name: "Text", extensions: ["txt", "log"] }],
    });
    if (!path) return;
    try {
      await saveTextFile(path, dumpBuffer());
      setNote(`Saved output to ${path}`);
    } catch (e) {
      setNote(`Save failed: ${String(e)}`);
    }
  };

  const toggleRecord = async () => {
    const id = backendId.current;
    if (!id) return;
    if (recording) {
      await logStop(id).catch(() => {});
      setRecording(false);
      setNote("Recording stopped");
      return;
    }
    let path: string | null;
    const dir = settings.logDir || (await defaultLogDir());
    if (dir) {
      path = autoLogPath(dir, conn.name);
    } else {
      path = await saveDialog({
        defaultPath: `${sanitizeFilename(conn.name)}_${timestamp()}.log`,
        filters: [{ name: "Log", extensions: ["log", "txt"] }],
      });
    }
    if (!path) return;
    try {
      await logStart(id, path);
      setRecording(true);
      setNote(`Recording to ${path}`);
    } catch (e) {
      setNote(`Recording failed: ${String(e)}`);
    }
  };

  const toggleMacroRecording = () => {
    const store = useStore.getState();
    if (!recordingMacro) {
      macroLineRef.current = "";
      store.startRecording(session.id);
      setNote("Recording a macro — run the commands you want captured");
      termRef.current?.focus();
      return;
    }
    // Flush a line left sitting on the prompt, so stopping without pressing
    // enter still captures what was typed.
    if (macroLineRef.current.trim()) store.recordStep(macroLineRef.current);
    macroLineRef.current = "";
    // Re-read: recordStep above may have just added the first step.
    if (useStore.getState().recordingSteps.length === 0) {
      store.cancelRecording();
      setNote("Nothing was recorded — macro discarded");
      return;
    }
    setMacroLabel("");
  };

  const saveMacro = () => {
    const steps = useStore.getState().recordingSteps.length;
    useStore.getState().stopRecording(macroLabel ?? "");
    setMacroLabel(null);
    setNote(`Macro saved · ${steps} step${steps === 1 ? "" : "s"}`);
    termRef.current?.focus();
  };

  const discardMacro = () => {
    useStore.getState().cancelRecording();
    setMacroLabel(null);
    setNote("Macro discarded");
    termRef.current?.focus();
  };

  const findNext = (incremental = false) => {
    if (!query) return;
    searchRef.current?.findNext(query, {
      caseSensitive: false,
      incremental,
      decorations: SEARCH_DECORATIONS,
    });
  };
  const findPrev = () => {
    if (!query) return;
    searchRef.current?.findPrevious(query, {
      caseSensitive: false,
      decorations: SEARCH_DECORATIONS,
    });
  };
  const closeSearch = () => {
    searchRef.current?.clearDecorations();
    setSearchOpen(false);
    setQuery("");
    termRef.current?.focus();
  };

  const reconnect = () => {
    const term = termRef.current;
    if (!term || connectingRef.current) return;
    setAuthError(null);
    term.writeln("");
    connect();
  };

  /** Retry with the credential just typed into the prompt. */
  const retryWithSecret = (value: string, remember: boolean) => {
    if (!retryField) return;
    setAuthBusy(true);
    termRef.current?.writeln("");
    connect({ field: retryField, value, remember });
  };

  /** What this session is attached to, as shown in the toolbar and status bar. */
  const target = isSerial
    ? `${conn.serialPort} · ${conn.baudRate}`
    : isLocal
      ? `local · ${conn.shell ?? "shell"}`
      : `${conn.username ? conn.username + "@" : ""}${conn.host}:${conn.port}`;

  const colorBar = settings.colorStatusBar;
  /** The connection's own accent, when tinting is on and one was picked. */
  const tint = settings.tintByConnection ? liveConn.color : undefined;
  /** Status segment background, so "error" reads as red without the dot alone. */
  const segmentTone =
    session.status === "connected"
      ? "bg-ok/15 text-ok"
      : session.status === "connecting"
        ? "bg-warn/15 text-warn"
        : session.status === "error"
          ? "bg-err/15 text-err"
          : "bg-bg-hover text-ink-dim";

  const statusColor =
    session.status === "connected"
      ? "bg-ok"
      : session.status === "connecting"
        ? "bg-warn animate-pulse"
        : session.status === "error"
          ? "bg-err"
          : "bg-ink-dim";

  return (
    <div className="relative flex h-full w-full flex-col bg-bg-base effect-base">
      <div
        className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-bg-panel effect-surface px-2"
        // The connection's accent runs down the left edge and under the bar, so
        // a glance at the chrome answers "which host is this?".
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
          {isSsh && (
            <>
              <button
                onClick={() => openSession(conn.id, conn.name, "sftp")}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink-mid transition hover:bg-bg-hover hover:text-proto-sftp active:scale-[0.97]"
                title="Browse this server's files over SFTP"
              >
                <FolderTree size={14} />
                Files
              </button>
              <button
                onClick={() => setTunnelsOpen(true)}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi active:scale-[0.97]"
                title="Port forwarding (ssh -L)"
              >
                <Network size={14} />
                Tunnels
                {runningTunnels > 0 && (
                  <span className="rounded bg-ok/15 px-1 font-mono text-[9px] text-ok">
                    {runningTunnels}
                  </span>
                )}
              </button>
              <button
                onClick={() => setScpOpen(true)}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink-mid transition hover:bg-bg-hover hover:text-ink-hi active:scale-[0.97]"
                title="Copy files over SCP"
              >
                <ArrowLeftRight size={14} />
                SCP
              </button>
              <div className="mx-1 h-4 w-px bg-edge" />
            </>
          )}
          <button
            onClick={toggleBroadcast}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition active:scale-[0.97] ${
              broadcastInput
                ? "bg-warn/15 text-warn hover:bg-warn/25"
                : "text-ink-mid hover:bg-bg-hover hover:text-ink-hi"
            }`}
            title="Multi-execution: send typed input to every connected terminal"
          >
            <RadioTower size={14} />
            {broadcastInput ? "Broadcast ON" : "Broadcast"}
          </button>
          <button
            onClick={toggleMacroRecording}
            disabled={!connected || (!!recordingMacroFor && !recordingMacro)}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition active:scale-[0.97] disabled:pointer-events-none disabled:opacity-30 ${
              recordingMacro
                ? "bg-accent/15 text-accent hover:bg-accent/25"
                : "text-ink-mid hover:bg-bg-hover hover:text-ink-hi"
            }`}
            title={
              recordingMacro
                ? "Stop recording and name this macro"
                : recordingMacroFor
                  ? "Another session is recording a macro"
                  : "Record the commands you type into a replayable macro"
            }
          >
            <ListVideo size={14} />
            {recordingMacro ? `Macro ${recordingSteps.length}` : "Macro"}
          </button>
          <button
            onClick={() => setSearchOpen(true)}
            className="tb-btn"
            title="Search buffer (Ctrl+F)"
          >
            <Search size={15} />
          </button>
          <button
            onClick={saveOutput}
            disabled={!connected}
            className="tb-btn"
            title="Save output buffer to a file"
          >
            <Save size={15} />
          </button>
          <button
            onClick={toggleRecord}
            disabled={!connected}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition active:scale-[0.97] disabled:pointer-events-none disabled:opacity-30 ${
              recording
                ? "bg-err/15 text-err hover:bg-err/25"
                : "text-ink-mid hover:bg-bg-hover hover:text-ink-hi"
            }`}
            title={recording ? "Stop writing the session log" : "Write this session to a log file"}
          >
            {recording ? <CircleStop size={14} /> : <Circle size={14} />}
            {recording ? "Logging" : "Log"}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 p-2">
        <div className="h-full w-full overflow-hidden rounded-lg border border-edge bg-bg-inset p-2">
          <div ref={containerRef} className="h-full w-full" onContextMenu={handleContextMenu} />
        </div>
      </div>

      {settings.statusBar && (
        <div
          className={cn(
            "flex h-6 shrink-0 items-center border-t border-edge bg-bg-panel effect-surface font-mono text-[10px] text-ink-dim",
            colorBar ? "gap-px pl-0 pr-0" : "gap-3 px-3"
          )}
          style={tint ? { borderTopColor: `${tint}66` } : undefined}
        >
          {colorBar ? (
            <>
              <span
                className={cn("flex items-center gap-1.5 px-2 py-[3px]", segmentTone)}
                title="Session status"
              >
                <span className={`h-1 w-1 shrink-0 rounded-full ${statusColor}`} />
                {session.status}
              </span>
              <span
                className="flex min-w-0 items-center gap-1.5 px-2 py-[3px] text-ink-mid"
                style={
                  tint
                    ? { backgroundColor: `${tint}1f`, color: tint }
                    : { backgroundColor: "rgba(91,140,255,0.12)" }
                }
                title="Connected to"
              >
                <span className="truncate">{target}</span>
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-px">
                {recording && <span className="bg-err/15 px-2 py-[3px] text-err">● log</span>}
                {runningTunnels > 0 && (
                  <span className="bg-ok/15 px-2 py-[3px] text-ok">{runningTunnels} fwd</span>
                )}
                {recordingMacro && (
                  <span className="bg-accent/15 px-2 py-[3px] text-accent">● macro</span>
                )}
                <span className="bg-warn/15 px-2 py-[3px] text-warn" title="Local time">
                  <Clock size={9} className="mr-1 inline-block align-[-1px]" />
                  {clock}
                </span>
                {uptime && (
                  <span className="bg-ok/12 px-2 py-[3px] text-ok" title="Time connected">
                    {uptime}
                  </span>
                )}
                {usesPty && grid.cols > 0 && (
                  <span className="px-2 py-[3px]" title="Terminal grid">
                    {grid.cols}×{grid.rows}
                  </span>
                )}
                <span className="px-2 py-[3px]" title="Terminal encoding">
                  UTF-8
                </span>
              </div>
            </>
          ) : (
            <>
              <span className="flex items-center gap-1.5">
                <span className={`h-1 w-1 shrink-0 rounded-full ${statusColor}`} />
                {session.status}
              </span>
              <span className="min-w-0 truncate text-ink-mid">{target}</span>
              <div className="ml-auto flex shrink-0 items-center gap-3">
                {recording && <span className="text-err">● log</span>}
                {runningTunnels > 0 && <span className="text-ok">{runningTunnels} fwd</span>}
                {recordingMacro && <span className="text-accent">● macro</span>}
                {uptime && <span title="Time connected">{uptime}</span>}
                {usesPty && grid.cols > 0 && (
                  <span title="Terminal grid">
                    {grid.cols}×{grid.rows}
                  </span>
                )}
                <span title="Terminal encoding">UTF-8</span>
              </div>
            </>
          )}
        </div>
      )}

      {searchOpen && (
        <div className="absolute right-4 top-11 z-10 flex animate-fade-up items-center gap-1 rounded-lg border border-edge bg-bg-panel/95 px-2 py-1.5 shadow-[0_12px_32px_-8px_rgba(4,10,20,0.8)] backdrop-blur-sm">
          <Search size={13} className="shrink-0 text-ink-dim" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value) {
                searchRef.current?.findNext(e.target.value, {
                  caseSensitive: false,
                  incremental: true,
                  decorations: SEARCH_DECORATIONS,
                });
              } else {
                searchRef.current?.clearDecorations();
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.shiftKey) findPrev();
              else if (e.key === "Enter") findNext();
              else if (e.key === "Escape") closeSearch();
            }}
            placeholder="find in buffer"
            className="w-44 bg-transparent font-mono text-xs text-ink-hi outline-none placeholder:text-ink-dim"
          />
          <button onClick={findPrev} className="tb-btn !p-1" title="Previous (Shift+Enter)">
            <ChevronUp size={13} />
          </button>
          <button onClick={() => findNext()} className="tb-btn !p-1" title="Next (Enter)">
            <ChevronDown size={13} />
          </button>
          <button onClick={closeSearch} className="tb-btn !p-1" title="Close (Esc)">
            <X size={13} />
          </button>
        </div>
      )}

      {macroLabel !== null && (
        <div className="absolute left-1/2 top-12 z-10 flex -translate-x-1/2 animate-fade-up items-center gap-2 rounded-lg border border-edge bg-bg-panel/95 py-1.5 pl-3 pr-1.5 shadow-[0_12px_32px_-8px_rgba(4,10,20,0.8)] backdrop-blur-sm">
          <ListVideo size={13} className="shrink-0 text-accent" />
          <span className="shrink-0 font-mono text-[10.5px] text-ink-dim">
            {recordingSteps.length} step{recordingSteps.length === 1 ? "" : "s"}
          </span>
          <input
            autoFocus
            value={macroLabel}
            onChange={(e) => setMacroLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveMacro();
              else if (e.key === "Escape") discardMacro();
            }}
            placeholder="name this macro"
            className="w-44 bg-transparent font-mono text-xs text-ink-hi outline-none placeholder:text-ink-dim"
          />
          <button onClick={saveMacro} className="btn-primary !px-2.5 !py-1 !text-xs">
            Save
          </button>
          <button onClick={discardMacro} className="tb-btn !p-1" title="Discard (Esc)">
            <X size={13} />
          </button>
        </div>
      )}

      {dropped && !connectingRef.current && (
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

      {tunnelsOpen && (
        <TunnelsModal conn={liveConn} onClose={() => setTunnelsOpen(false)} />
      )}

      {scpOpen && <ScpModal conn={liveConn} onClose={() => setScpOpen(false)} />}

      {pastePending !== null && (
        <PasteConfirm
          lines={splitPasteLines(pastePending)}
          onConfirm={confirmPaste}
          onCancel={cancelPaste}
        />
      )}

      {authError !== null && retryField && (
        <PasswordPrompt
          title="Authentication failed"
          target={target}
          error={authError}
          kind={retryField}
          busy={authBusy}
          onSubmit={retryWithSecret}
          onCancel={() => setAuthError(null)}
        />
      )}
    </div>
  );
}

function autoLogPath(dir: string, name: string): string {
  const base = dir.replace(/[\/]+$/, "");
  return `${base}/${sanitizeFilename(name)}_${timestamp()}.log`;
}
