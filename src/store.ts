import { create } from "zustand";
import { nanoid } from "nanoid";
import { readTextFile, saveTextFile } from "./lib/api";
import type {
  Connection,
  HighlightRule,
  Protocol,
  QuickCommand,
  Session,
  SessionStatus,
} from "./lib/types";

const STORAGE_KEY = "dshh.connections.v1";
const SETTINGS_KEY = "dshh.settings.v1";
const QUICKCMD_KEY = "dshh.quickcmds.v1";

export interface Settings {
  autoLog: boolean;
  logDir: string;
  /** Optional folder where saved connections are mirrored as connections.json. */
  sessionsDir: string;
  highlightEnabled: boolean;
  highlightRules: HighlightRule[];
}

const DEFAULT_HIGHLIGHT_RULES: HighlightRule[] = [
  { id: "hl-error", pattern: "error", color: "red" },
  { id: "hl-failed", pattern: "failed", color: "red" },
  { id: "hl-denied", pattern: "denied", color: "red" },
  { id: "hl-warning", pattern: "warning", color: "yellow" },
  { id: "hl-success", pattern: "success", color: "green" },
];

const DEFAULT_SETTINGS: Settings = {
  autoLog: false,
  logDir: "",
  sessionsDir: "",
  highlightEnabled: true,
  highlightRules: DEFAULT_HIGHLIGHT_RULES,
};

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    /* ignore corrupt storage */
  }
  return null;
}

function loadSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...(loadJson<Partial<Settings>>(SETTINGS_KEY) ?? {}) };
}

const persistConnections = (c: Connection[]) =>
  localStorage.setItem(STORAGE_KEY, JSON.stringify(c));

function sessionsFilePath(dir: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/connections.json`;
}

/** Fire-and-forget mirror of saved connections to the optional sessions folder. */
function mirrorToDisk(connections: Connection[], dir: string) {
  if (!dir) return;
  saveTextFile(sessionsFilePath(dir), JSON.stringify(connections, null, 2)).catch(
    () => {}
  );
}
const persistQuickCommands = (q: QuickCommand[]) =>
  localStorage.setItem(QUICKCMD_KEY, JSON.stringify(q));

interface AppState {
  connections: Connection[];
  sessions: Session[];
  activeSessionId: string | null;
  /** Session shown in the right pane of a split view, or null when unsplit. */
  splitSessionId: string | null;
  settings: Settings;
  quickCommands: QuickCommand[];
  /** Running port forwards: tunnel definition id -> backend tunnel id. */
  activeTunnels: Record<string, string>;

  addConnection: (c: Omit<Connection, "id">) => Connection;
  updateConnection: (id: string, patch: Partial<Connection>) => void;
  removeConnection: (id: string) => void;
  duplicateConnection: (id: string) => Connection | undefined;

  openSession: (connectionId: string, title: string, protocol?: Protocol) => Session;
  setSessionStatus: (id: string, status: SessionStatus, error?: string) => void;
  closeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  toggleSplitSession: (id: string) => void;

  setSettings: (patch: Partial<Settings>) => void;

  addQuickCommand: (label: string, command: string) => void;
  updateQuickCommand: (id: string, patch: Partial<Omit<QuickCommand, "id">>) => void;
  removeQuickCommand: (id: string) => void;

  setTunnelActive: (defId: string, backendId: string | null) => void;
}

export const useStore = create<AppState>((set, get) => ({
  connections: loadJson<Connection[]>(STORAGE_KEY) ?? [],
  sessions: [],
  activeSessionId: null,
  splitSessionId: null,
  settings: loadSettings(),
  quickCommands: loadJson<QuickCommand[]>(QUICKCMD_KEY) ?? [],
  activeTunnels: {},

  addConnection: (c) => {
    const conn: Connection = { ...c, id: nanoid() };
    const connections = [...get().connections, conn];
    persistConnections(connections);
    mirrorToDisk(connections, get().settings.sessionsDir);
    set({ connections });
    return conn;
  },

  updateConnection: (id, patch) => {
    const connections = get().connections.map((c) =>
      c.id === id ? { ...c, ...patch } : c
    );
    persistConnections(connections);
    mirrorToDisk(connections, get().settings.sessionsDir);
    set({ connections });
  },

  removeConnection: (id) => {
    const connections = get().connections.filter((c) => c.id !== id);
    persistConnections(connections);
    mirrorToDisk(connections, get().settings.sessionsDir);
    set({ connections });
  },

  duplicateConnection: (id) => {
    const orig = get().connections.find((c) => c.id === id);
    if (!orig) return undefined;
    const { id: _drop, ...rest } = orig;
    const copy: Connection = { ...rest, id: nanoid(), name: `${orig.name} (copy)` };
    const connections = [...get().connections, copy];
    persistConnections(connections);
    mirrorToDisk(connections, get().settings.sessionsDir);
    set({ connections });
    return copy;
  },

  openSession: (connectionId, title, protocol) => {
    const conn = get().connections.find((c) => c.id === connectionId)!;
    const session: Session = {
      id: nanoid(),
      connectionId,
      protocol: protocol ?? conn.protocol,
      title,
      status: "connecting",
    };
    set({ sessions: [...get().sessions, session], activeSessionId: session.id });
    return session;
  },

  setSessionStatus: (id, status, error) =>
    set({
      sessions: get().sessions.map((s) =>
        s.id === id ? { ...s, status, error } : s
      ),
    }),

  closeSession: (id) => {
    const remaining = get().sessions.filter((s) => s.id !== id);
    const active =
      get().activeSessionId === id
        ? remaining.length
          ? remaining[remaining.length - 1].id
          : null
        : get().activeSessionId;
    const split = get().splitSessionId === id ? null : get().splitSessionId;
    set({ sessions: remaining, activeSessionId: active, splitSessionId: split });
  },

  setActiveSession: (id) => {
    // A session can't be both the main pane and the split pane.
    const split = get().splitSessionId === id ? null : get().splitSessionId;
    set({ activeSessionId: id, splitSessionId: split });
  },

  toggleSplitSession: (id) => {
    if (get().splitSessionId === id) {
      set({ splitSessionId: null });
      return;
    }
    if (get().activeSessionId === id) {
      // Splitting the active session: pick another session to keep in the
      // main pane, otherwise there is nothing to split against.
      const other = get().sessions.find((s) => s.id !== id);
      if (!other) return;
      set({ activeSessionId: other.id, splitSessionId: id });
      return;
    }
    set({ splitSessionId: id });
  },

  setSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    set({ settings });
  },

  addQuickCommand: (label, command) => {
    const quickCommands = [
      ...get().quickCommands,
      { id: nanoid(), label: label.trim() || command.trim(), command },
    ];
    persistQuickCommands(quickCommands);
    set({ quickCommands });
  },

  updateQuickCommand: (id, patch) => {
    const quickCommands = get().quickCommands.map((q) =>
      q.id === id ? { ...q, ...patch } : q
    );
    persistQuickCommands(quickCommands);
    set({ quickCommands });
  },

  removeQuickCommand: (id) => {
    const quickCommands = get().quickCommands.filter((q) => q.id !== id);
    persistQuickCommands(quickCommands);
    set({ quickCommands });
  },

  setTunnelActive: (defId, backendId) => {
    const activeTunnels = { ...get().activeTunnels };
    if (backendId === null) delete activeTunnels[defId];
    else activeTunnels[defId] = backendId;
    set({ activeTunnels });
  },
}));

/**
 * Point the app at a saved-sessions folder. If `<dir>/connections.json`
 * exists it becomes the source of truth and is loaded (returns true); if it
 * doesn't exist yet, the folder is seeded with the current list (returns
 * false). A malformed file throws instead of being overwritten.
 */
export async function adoptSessionsDir(dir: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readTextFile(sessionsFilePath(dir));
  } catch {
    mirrorToDisk(useStore.getState().connections, dir);
    return false;
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("connections.json is not a list of sessions");
  }
  const connections = parsed.filter(
    (c): c is Connection => !!c && typeof c === "object" && typeof c.id === "string"
  );
  persistConnections(connections);
  useStore.setState({ connections });
  return true;
}

/** Startup hook: load saved sessions from the configured folder, if any. */
export function initSavedSessions() {
  const dir = useStore.getState().settings.sessionsDir;
  if (dir) {
    adoptSessionsDir(dir).catch((e) =>
      console.warn("Saved-sessions folder unavailable:", e)
    );
  }
}
