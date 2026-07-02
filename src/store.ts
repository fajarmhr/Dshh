import { create } from "zustand";
import { nanoid } from "nanoid";
import type { Connection, Session, SessionStatus } from "./lib/types";

const STORAGE_KEY = "dshh.connections.v1";
const SETTINGS_KEY = "dshh.settings.v1";

export interface Settings {
  autoLog: boolean;
  logDir: string;
}

const DEFAULT_SETTINGS: Settings = { autoLog: false, logDir: "" };

function loadConnections(): Connection[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Connection[];
  } catch {
    /* ignore corrupt storage */
  }
  return [];
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Settings) };
  } catch {
    /* ignore */
  }
  return DEFAULT_SETTINGS;
}

function persist(conns: Connection[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conns));
}

interface AppState {
  connections: Connection[];
  sessions: Session[];
  activeSessionId: string | null;
  settings: Settings;

  addConnection: (c: Omit<Connection, "id">) => Connection;
  updateConnection: (id: string, patch: Partial<Connection>) => void;
  removeConnection: (id: string) => void;
  duplicateConnection: (id: string) => Connection | undefined;

  openSession: (connectionId: string, title: string) => Session;
  setSessionStatus: (id: string, status: SessionStatus, error?: string) => void;
  closeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;

  setSettings: (patch: Partial<Settings>) => void;
}

export const useStore = create<AppState>((set, get) => ({
  connections: loadConnections(),
  sessions: [],
  activeSessionId: null,
  settings: loadSettings(),

  addConnection: (c) => {
    const conn: Connection = { ...c, id: nanoid() };
    const connections = [...get().connections, conn];
    persist(connections);
    set({ connections });
    return conn;
  },

  updateConnection: (id, patch) => {
    const connections = get().connections.map((c) =>
      c.id === id ? { ...c, ...patch } : c
    );
    persist(connections);
    set({ connections });
  },

  removeConnection: (id) => {
    const connections = get().connections.filter((c) => c.id !== id);
    persist(connections);
    set({ connections });
  },

  duplicateConnection: (id) => {
    const orig = get().connections.find((c) => c.id === id);
    if (!orig) return undefined;
    const { id: _drop, ...rest } = orig;
    const copy: Connection = { ...rest, id: nanoid(), name: `${orig.name} (copy)` };
    const connections = [...get().connections, copy];
    persist(connections);
    set({ connections });
    return copy;
  },

  openSession: (connectionId, title) => {
    const session: Session = {
      id: nanoid(),
      connectionId,
      protocol: get().connections.find((c) => c.id === connectionId)!.protocol,
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
    set({ sessions: remaining, activeSessionId: active });
  },

  setActiveSession: (id) => set({ activeSessionId: id }),

  setSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    set({ settings });
  },
}));
