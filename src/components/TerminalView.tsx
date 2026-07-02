import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Save, Circle, CircleStop } from "lucide-react";
import { useStore } from "../store";
import {
  sshConnect,
  sshWrite,
  sshResize,
  sshDisconnect,
  serialOpen,
  serialWrite,
  serialClose,
  logStart,
  logStop,
  saveTextFile,
} from "../lib/api";
import type { Connection, Session } from "../lib/types";
import { sanitizeFilename, timestamp } from "../lib/utils";

export function TerminalView({
  session,
  conn,
}: {
  session: Session;
  conn: Connection;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const backendId = useRef<string | null>(null);
  const setStatus = useStore((s) => s.setSessionStatus);
  const settings = useStore((s) => s.settings);
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState<string>("");

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: {
        background: "#0b0d10",
        foreground: "#dfe6ee",
        cursor: "#5b8cff",
        selectionBackground: "#2a3550",
        black: "#0b0d10",
        brightBlack: "#5f6b7a",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;

    const decoder = new TextDecoder();
    const onData = (bytes: Uint8Array) => term.write(decoder.decode(bytes));

    let disposed = false;

    (async () => {
      try {
        term.writeln(`\x1b[90mConnecting to ${conn.name}...\x1b[0m`);
        const id =
          session.protocol === "ssh"
            ? await sshConnect(conn, onData)
            : await serialOpen(conn, onData);
        if (disposed) return;
        backendId.current = id;
        setStatus(session.id, "connected");

        if (session.protocol === "ssh") {
          sshResize(id, term.cols, term.rows).catch(() => {});
        }

        term.onData((d) => {
          if (!backendId.current) return;
          session.protocol === "ssh"
            ? sshWrite(backendId.current, d)
            : serialWrite(backendId.current, d);
        });

        // Auto-log if enabled in settings.
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
        setStatus(session.id, "error", String(e));
        term.writeln(`\r\n\x1b[31m${String(e)}\x1b[0m`);
      }
    })();

    const doFit = () => {
      fit.fit();
      if (backendId.current && session.protocol === "ssh") {
        sshResize(backendId.current, term.cols, term.rows).catch(() => {});
      }
    };
    const ro = new ResizeObserver(doFit);
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      ro.disconnect();
      if (backendId.current) {
        session.protocol === "ssh"
          ? sshDisconnect(backendId.current).catch(() => {})
          : serialClose(backendId.current).catch(() => {});
      }
      term.dispose();
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
    // Trim trailing blank lines.
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

  const connected = session.status === "connected";

  return (
    <div className="flex h-full w-full flex-col bg-bg-base">
      <div className="flex items-center justify-end gap-1 border-b border-edge bg-bg-panel px-2 py-1">
        {note && (
          <span className="mr-auto truncate pl-1 text-[11px] text-[#5f6b7a]">{note}</span>
        )}
        <button
          onClick={saveOutput}
          disabled={!connected}
          className="tb-btn disabled:opacity-30"
          title="Save output buffer to a file"
        >
          <Save size={15} />
        </button>
        <button
          onClick={toggleRecord}
          disabled={!connected}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition disabled:opacity-30 ${
            recording
              ? "bg-red-500/15 text-red-300 hover:bg-red-500/25"
              : "text-[#9aa7b6] hover:bg-bg-hover hover:text-white"
          }`}
          title={recording ? "Stop recording session log" : "Record session to a log file"}
        >
          {recording ? <CircleStop size={14} /> : <Circle size={14} />}
          {recording ? "Recording" : "Record"}
        </button>
      </div>
      <div className="min-h-0 flex-1 p-2">
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}

function autoLogPath(dir: string, name: string): string {
  const base = dir.replace(/[\/]+$/, "");
  return `${base}/${sanitizeFilename(name)}_${timestamp()}.log`;
}
