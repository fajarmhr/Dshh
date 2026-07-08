import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  ChevronUp,
  Circle,
  CircleStop,
  FolderTree,
  Network,
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
  logStart,
  logStop,
  saveTextFile,
} from "../lib/api";
import { registerTerminal, unregisterTerminal } from "../lib/terminalRegistry";
import { applyHighlights, compileRules, type CompiledRule } from "../lib/highlight";
import { TunnelsModal } from "./TunnelsModal";
import type { Connection, Session } from "../lib/types";
import { sanitizeFilename, timestamp } from "../lib/utils";

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

  const isSsh = session.protocol === "ssh";
  const isLocal = session.protocol === "local";
  // Both SSH and local run over a PTY, so both need window-size sync.
  const usesPty = isSsh || isLocal;
  const connected = session.status === "connected";
  const dropped = session.status === "closed" || session.status === "error";
  const runningTunnels = useMemo(
    () => (liveConn.tunnels ?? []).filter((t) => activeTunnels[t.id]).length,
    [liveConn.tunnels, activeTunnels]
  );

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
    pushResize();
  };

  // Single keystroke/paste sink so every transport writes through one place.
  const writeBackend = (data: string) => {
    const id = backendId.current;
    if (!id) return;
    (isSsh ? sshWrite : isLocal ? localWrite : serialWrite)(id, data);
  };

  const connect = async () => {
    const term = termRef.current;
    const life = lifeRef.current;
    if (!term || backendId.current || connectingRef.current) return;
    connectingRef.current = true;
    setStatus(session.id, "connecting");
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
        setRecording(false);
        unregisterTerminal(session.id);
        useStore.getState().setSessionStatus(session.id, "closed");
        term.writeln(`\r\n\x1b[90m· ${isLocal ? "shell exited" : "connection closed"}\x1b[0m`);
      };

      const id = isSsh
        ? await sshConnect(conn, onData, onClosed)
        : isLocal
          ? await localOpen(
              conn.shell ?? "cmd",
              conn.cwd ?? null,
              term.cols,
              term.rows,
              onData,
              onClosed
            )
          : await serialOpen(conn, onData);

      if (life.dead) {
        // Component unmounted while the handshake was in flight.
        (isSsh
          ? sshDisconnect(id)
          : isLocal
            ? localClose(id)
            : serialClose(id)
        ).catch(() => {});
        return;
      }

      backendId.current = id;
      setStatus(session.id, "connected");
      registerTerminal(session.id, {
        send: (d) => writeBackend(d),
        focus: () => term.focus(),
      });

      // Fresh backend PTY defaults to 80×24; force the first size push (the
      // reset defeats pushResize's "unchanged" guard on reconnect). No-op for
      // serial, which has no window size.
      lastSizeRef.current = { cols: 0, rows: 0 };
      pushResize();

      const st = useStore.getState().settings;
      if (st.autoLog && st.logDir) {
        const path = autoLogPath(st.logDir, conn.name);
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
        setStatus(session.id, "error", String(e));
        term.writeln(`\r\n\x1b[31m${String(e)}\x1b[0m`);
      }
    } finally {
      connectingRef.current = false;
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const life = { dead: false };
    lifeRef.current = life;

    const term = new Terminal({
      fontFamily:
        '"JetBrains Mono Variable", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: {
        background: "#070a0f",
        foreground: "#d9e2ec",
        cursor: "#5b8cff",
        cursorAccent: "#070a0f",
        selectionBackground: "#2a3550",
        black: "#0a0e14",
        red: "#f26d78",
        green: "#3ecf8e",
        yellow: "#e8a54c",
        blue: "#5b8cff",
        magenta: "#b78af7",
        cyan: "#4cc9e8",
        white: "#d9e2ec",
        brightBlack: "#5a6878",
        brightRed: "#ff8a93",
        brightGreen: "#5fe3a8",
        brightYellow: "#ffc069",
        brightBlue: "#7ca4ff",
        brightMagenta: "#cfa8ff",
        brightCyan: "#79dcf2",
        brightWhite: "#eef4fa",
      },
    });
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

    term.onData((d) => writeBackend(d));

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
      ro.disconnect();
      unregisterTerminal(session.id);
      if (backendId.current) {
        (isSsh
          ? sshDisconnect(backendId.current)
          : isLocal
            ? localClose(backendId.current)
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
    if (settings.logDir) {
      path = autoLogPath(settings.logDir, conn.name);
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
    term.writeln("");
    connect();
  };

  const statusColor =
    session.status === "connected"
      ? "bg-ok"
      : session.status === "connecting"
        ? "bg-warn animate-pulse"
        : session.status === "error"
          ? "bg-err"
          : "bg-ink-dim";

  return (
    <div className="relative flex h-full w-full flex-col bg-bg-base">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-bg-panel px-2">
        <span className={`ml-1 h-1.5 w-1.5 shrink-0 rounded-full ${statusColor}`} />
        <span className="shrink-0 font-mono text-[10.5px] text-ink-dim">
          {session.protocol === "serial"
            ? `${conn.serialPort} · ${conn.baudRate}`
            : session.protocol === "local"
              ? `local · ${conn.shell ?? "shell"}`
              : `${conn.username ? conn.username + "@" : ""}${conn.host}:${conn.port}`}
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
              <div className="mx-1 h-4 w-px bg-edge" />
            </>
          )}
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
            title={recording ? "Stop recording session log" : "Record session to a log file"}
          >
            {recording ? <CircleStop size={14} /> : <Circle size={14} />}
            {recording ? "Recording" : "Record"}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 p-2">
        <div className="h-full w-full overflow-hidden rounded-lg border border-edge bg-bg-inset p-2">
          <div ref={containerRef} className="h-full w-full" />
        </div>
      </div>

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
    </div>
  );
}

function autoLogPath(dir: string, name: string): string {
  const base = dir.replace(/[\/]+$/, "");
  return `${base}/${sanitizeFilename(name)}_${timestamp()}.log`;
}
