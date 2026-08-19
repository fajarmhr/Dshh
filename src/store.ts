import { create } from "zustand";
import { nanoid } from "nanoid";
import {
  masterLock,
  masterSetup,
  masterUnlock,
  readTextFile,
  saveTextFile,
  secretsDecrypt,
  secretsEncrypt,
  setWindowEffect,
} from "./lib/api";
import { DEFAULT_THEME_ID } from "./lib/themes";
import { moveItem } from "./lib/utils";
import type {
  Connection,
  CursorStyle,
  HighlightRule,
  Macro,
  Protocol,
  QuickCommand,
  Session,
  SessionStatus,
} from "./lib/types";

const STORAGE_KEY = "dshh.connections.v1";
const SETTINGS_KEY = "dshh.settings.v1";
const QUICKCMD_KEY = "dshh.quickcmds.v1";
const MACRO_KEY = "dshh.macros.v1";

/**
 * Backdrop behind the app chrome. Mica and acrylic are Windows 11 only and
 * degrade to a plain opaque window elsewhere.
 */
export type WindowEffect = "opaque" | "mica" | "acrylic";

export interface Settings {
  autoLog: boolean;
  logDir: string;
  /** Optional folder where saved connections are mirrored as connections.json. */
  sessionsDir: string;
  /** Sidebar groups start folded; expanding one lasts until the app restarts. */
  collapseGroupsByDefault: boolean;
  /** Persistent bar under the terminal showing host, latency and encoding. */
  statusBar: boolean;
  /** Windows 11 backdrop behind the app chrome. */
  windowEffect: WindowEffect;
  // ---- Terminal appearance (MobaXterm's Terminal settings tab) ----
  /** Built-in palette id; see lib/themes.ts. */
  themeId: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  /** Show the paste preview before sending clipboard text with 2+ lines. */
  pasteWarnMultiline: boolean;
  highlightEnabled: boolean;
  highlightRules: HighlightRule[];
  /** Highest default-rule set merged into highlightRules (see loadSettings). */
  rulesVersion: number;
  /** Master-password KDF salt (base64). Empty = no master password set. */
  masterSalt: string;
  /** Verifier blob used to check an entered master password. */
  masterCheck: string;
}

/** Rules added in 0.5.1 — kept separate so the loader can append exactly
 *  these to an existing install without resurrecting user-deleted rules. */
const RULES_ADDED_V2: HighlightRule[] = [
  { id: "hl-fatal", pattern: "fatal", color: "red" },
  { id: "hl-critical", pattern: "critical", color: "red" },
  { id: "hl-refused", pattern: "refused", color: "red" },
  { id: "hl-exception", pattern: "exception", color: "red" },
  { id: "hl-deprecated", pattern: "deprecated", color: "yellow" },
  { id: "hl-timeout", pattern: "timeout", color: "yellow" },
  { id: "hl-retrying", pattern: "retrying", color: "yellow" },
  { id: "hl-completed", pattern: "completed", color: "green" },
  { id: "hl-established", pattern: "established", color: "green" },
  { id: "hl-accepted", pattern: "accepted", color: "green" },
  { id: "hl-listening", pattern: "listening", color: "cyan" },
];

const RULES_VERSION = 2;

const DEFAULT_HIGHLIGHT_RULES: HighlightRule[] = [
  { id: "hl-error", pattern: "error", color: "red" },
  { id: "hl-failed", pattern: "failed", color: "red" },
  { id: "hl-denied", pattern: "denied", color: "red" },
  { id: "hl-warning", pattern: "warning", color: "yellow" },
  { id: "hl-success", pattern: "success", color: "green" },
  ...RULES_ADDED_V2,
];

const DEFAULT_SETTINGS: Settings = {
  autoLog: false,
  logDir: "",
  sessionsDir: "",
  collapseGroupsByDefault: true,
  statusBar: true,
  windowEffect: "opaque",
  themeId: DEFAULT_THEME_ID,
  fontFamily: '"JetBrains Mono Variable", "Cascadia Code", Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.2,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 10000,
  pasteWarnMultiline: true,
  highlightEnabled: true,
  highlightRules: DEFAULT_HIGHLIGHT_RULES,
  rulesVersion: RULES_VERSION,
  masterSalt: "",
  masterCheck: "",
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
  const saved = loadJson<Partial<Settings>>(SETTINGS_KEY) ?? {};
  const s = { ...DEFAULT_SETTINGS, ...saved };
  // Releases can grow the default highlight set. Append only the rules the
  // saved install predates, so rules the user deleted stay deleted.
  if (saved.highlightRules && (saved.rulesVersion ?? 1) < RULES_VERSION) {
    const have = new Set(saved.highlightRules.map((r) => r.id));
    s.highlightRules = [
      ...saved.highlightRules,
      ...RULES_ADDED_V2.filter((r) => !have.has(r.id)),
    ];
  }
  s.rulesVersion = RULES_VERSION;
  return s;
}

function sessionsFilePath(dir: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/connections.json`;
}

/**
 * Apply `fn` to the secret fields (password, passphrase) of every connection
 * in one batched backend call, returning new connection objects.
 */
async function mapSecrets(
  conns: Connection[],
  fn: (values: string[]) => Promise<string[]>
): Promise<Connection[]> {
  const values: string[] = [];
  for (const c of conns) {
    values.push(
      c.password ?? "",
      c.passphrase ?? "",
      c.jumpPassword ?? "",
      c.jumpPassphrase ?? ""
    );
  }
  const out = await fn(values);
  return conns.map((c, i) => ({
    ...c,
    password: out[i * 4] || undefined,
    passphrase: out[i * 4 + 1] || undefined,
    jumpPassword: out[i * 4 + 2] || undefined,
    jumpPassphrase: out[i * 4 + 3] || undefined,
  }));
}

/** Shape of connections.json when a master password is set (v2). */
interface MirrorV2 {
  dshh: 2;
  master: { salt: string; check: string };
  connections: Connection[];
}

/**
 * Persist connections to localStorage and the optional sessions folder.
 * With a master password set and unlocked, secrets are encrypted first; while
 * locked the in-memory values are still encrypted, so they pass through
 * unchanged. Writes are chained so rapid updates can't land out of order.
 */
let persistChain: Promise<void> = Promise.resolve();
function persistAll(connections: Connection[]) {
  persistChain = persistChain.then(async () => {
    const { settings, masterLocked } = useStore.getState();
    let stored = connections;
    if (settings.masterSalt && !masterLocked) {
      try {
        stored = await mapSecrets(connections, secretsEncrypt);
      } catch {
        return; // key unavailable — don't write plaintext while protected
      }
    }
    const payload: Connection[] | MirrorV2 = settings.masterSalt
      ? {
          dshh: 2,
          master: { salt: settings.masterSalt, check: settings.masterCheck },
          connections: stored,
        }
      : stored;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    if (settings.sessionsDir) {
      saveTextFile(
        sessionsFilePath(settings.sessionsDir),
        JSON.stringify(payload, null, 2)
      ).catch(() => {});
    }
  });
}
const persistQuickCommands = (q: QuickCommand[]) =>
  localStorage.setItem(QUICKCMD_KEY, JSON.stringify(q));
const persistMacros = (m: Macro[]) =>
  localStorage.setItem(MACRO_KEY, JSON.stringify(m));

interface AppState {
  connections: Connection[];
  /**
   * True while a master password is set but not yet entered this run: secret
   * fields in `connections` still hold `enc:v1:` blobs and can't be used.
   */
  masterLocked: boolean;
  /** In-memory connections behind one-off local terminals; never persisted. */
  transientConnections: Connection[];
  sessions: Session[];
  activeSessionId: string | null;
  /** Session shown in the right pane of a split view, or null when unsplit. */
  splitSessionId: string | null;
  settings: Settings;
  quickCommands: QuickCommand[];
  macros: Macro[];
  /** Session currently capturing typed commands into a macro, if any. */
  recordingMacroFor: string | null;
  /** Commands captured so far in the in-progress recording. */
  recordingSteps: string[];
  /** Running port forwards: tunnel definition id -> backend tunnel id. */
  activeTunnels: Record<string, string>;
  /** Multi-execution: typed input mirrors to every connected terminal. */
  broadcastInput: boolean;
  toggleBroadcast: () => void;

  addConnection: (c: Omit<Connection, "id">) => Connection;
  updateConnection: (id: string, patch: Partial<Connection>) => void;
  removeConnection: (id: string) => void;
  duplicateConnection: (id: string) => Connection | undefined;

  openSession: (connectionId: string, title: string, protocol?: Protocol) => Session;
  /** Open a one-off local shell tab backed by a transient connection. */
  openLocalTerminal: (opts: { shell: string; label: string; cwd?: string }) => void;
  setSessionStatus: (id: string, status: SessionStatus, error?: string) => void;
  closeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  toggleSplitSession: (id: string) => void;

  setSettings: (patch: Partial<Settings>) => void;

  addQuickCommand: (label: string, command: string) => void;
  updateQuickCommand: (id: string, patch: Partial<Omit<QuickCommand, "id">>) => void;
  removeQuickCommand: (id: string) => void;
  /** Move a quick command; the dock renders its chips in this order. */
  reorderQuickCommands: (from: number, to: number) => void;

  /** Begin capturing commands typed in `sessionId` into a new macro. */
  startRecording: (sessionId: string) => void;
  /** Append one captured command line to the in-progress recording. */
  recordStep: (command: string) => void;
  /** Finish recording; saves under `label` when at least one step was captured. */
  stopRecording: (label: string) => void;
  /** Discard an in-progress recording without saving anything. */
  cancelRecording: () => void;
  updateMacro: (id: string, patch: Partial<Omit<Macro, "id">>) => void;
  removeMacro: (id: string) => void;
  /** Move a macro; the dock renders its chips in this order. */
  reorderMacros: (from: number, to: number) => void;

  setTunnelActive: (defId: string, backendId: string | null) => void;
}

export const useStore = create<AppState>((set, get) => ({
  connections: loadJson<Connection[]>(STORAGE_KEY) ?? [],
  masterLocked: !!loadSettings().masterSalt,
  transientConnections: [],
  sessions: [],
  activeSessionId: null,
  splitSessionId: null,
  settings: loadSettings(),
  quickCommands: loadJson<QuickCommand[]>(QUICKCMD_KEY) ?? [],
  macros: loadJson<Macro[]>(MACRO_KEY) ?? [],
  recordingMacroFor: null,
  recordingSteps: [],
  activeTunnels: {},
  broadcastInput: false,

  toggleBroadcast: () => set({ broadcastInput: !get().broadcastInput }),

  addConnection: (c) => {
    const conn: Connection = { ...c, id: nanoid() };
    const connections = [...get().connections, conn];
    set({ connections });
    persistAll(connections);
    return conn;
  },

  updateConnection: (id, patch) => {
    const connections = get().connections.map((c) =>
      c.id === id ? { ...c, ...patch } : c
    );
    set({ connections });
    persistAll(connections);
  },

  removeConnection: (id) => {
    const connections = get().connections.filter((c) => c.id !== id);
    set({ connections });
    persistAll(connections);
  },

  duplicateConnection: (id) => {
    const orig = get().connections.find((c) => c.id === id);
    if (!orig) return undefined;
    const { id: _drop, ...rest } = orig;
    const copy: Connection = { ...rest, id: nanoid(), name: `${orig.name} (copy)` };
    const connections = [...get().connections, copy];
    set({ connections });
    persistAll(connections);
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

  openLocalTerminal: ({ shell, label, cwd }) => {
    // A one-off local terminal has no saved profile, so it rides on a transient
    // connection kept only in memory. TerminalView reads `shell`/`cwd` from it.
    const conn: Connection = { id: nanoid(), name: label, protocol: "local", shell, cwd };
    const session: Session = {
      id: nanoid(),
      connectionId: conn.id,
      protocol: "local",
      title: label,
      status: "connecting",
    };
    set({
      transientConnections: [...get().transientConnections, conn],
      sessions: [...get().sessions, session],
      activeSessionId: session.id,
    });
  },

  setSessionStatus: (id, status, error) =>
    set({
      sessions: get().sessions.map((s) =>
        s.id === id ? { ...s, status, error } : s
      ),
    }),

  closeSession: (id) => {
    const closing = get().sessions.find((s) => s.id === id);
    const remaining = get().sessions.filter((s) => s.id !== id);
    const active =
      get().activeSessionId === id
        ? remaining.length
          ? remaining[remaining.length - 1].id
          : null
        : get().activeSessionId;
    const split = get().splitSessionId === id ? null : get().splitSessionId;
    // Reap the transient connection behind a local terminal once nothing else
    // references it, so the in-memory list doesn't grow without bound.
    let transientConnections = get().transientConnections;
    if (
      closing &&
      transientConnections.some((c) => c.id === closing.connectionId) &&
      !remaining.some((s) => s.connectionId === closing.connectionId)
    ) {
      transientConnections = transientConnections.filter(
        (c) => c.id !== closing.connectionId
      );
    }
    // A macro recording belongs to the session it was capturing; closing that
    // session ends it rather than leaving the recorder pointed at a dead tab.
    const recording = get().recordingMacroFor === id ? null : get().recordingMacroFor;
    set({
      sessions: remaining,
      activeSessionId: active,
      splitSessionId: split,
      transientConnections,
      recordingMacroFor: recording,
      recordingSteps: recording ? get().recordingSteps : [],
    });
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

  reorderQuickCommands: (from, to) => {
    const current = get().quickCommands;
    const quickCommands = moveItem(current, from, to);
    if (quickCommands === current) return;
    persistQuickCommands(quickCommands);
    set({ quickCommands });
  },

  startRecording: (sessionId) =>
    set({ recordingMacroFor: sessionId, recordingSteps: [] }),

  recordStep: (command) => {
    const line = command.trim();
    // Blank lines are how people scroll a prompt; they aren't macro steps.
    if (!get().recordingMacroFor || !line) return;
    set({ recordingSteps: [...get().recordingSteps, line] });
  },

  stopRecording: (label) => {
    const steps = get().recordingSteps;
    if (steps.length) {
      const macros = [
        ...get().macros,
        { id: nanoid(), label: label.trim() || steps[0], steps },
      ];
      persistMacros(macros);
      set({ macros });
    }
    set({ recordingMacroFor: null, recordingSteps: [] });
  },

  cancelRecording: () => set({ recordingMacroFor: null, recordingSteps: [] }),

  updateMacro: (id, patch) => {
    const macros = get().macros.map((m) => (m.id === id ? { ...m, ...patch } : m));
    persistMacros(macros);
    set({ macros });
  },

  removeMacro: (id) => {
    const macros = get().macros.filter((m) => m.id !== id);
    persistMacros(macros);
    set({ macros });
  },

  reorderMacros: (from, to) => {
    const current = get().macros;
    const macros = moveItem(current, from, to);
    if (macros === current) return;
    persistMacros(macros);
    set({ macros });
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
 *
 * Accepts both formats: a plain array (v1, plaintext) and the v2 wrapper
 * `{ dshh: 2, master, connections }`. Adopting a v2 file also adopts its
 * master password and locks the app until that password is entered.
 */
export async function adoptSessionsDir(dir: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readTextFile(sessionsFilePath(dir));
  } catch {
    persistAll(useStore.getState().connections);
    return false;
  }
  const parsed = JSON.parse(raw);
  let list: unknown;
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.connections)) {
    list = parsed.connections;
    const master = parsed.master;
    if (master && typeof master.salt === "string" && master.salt) {
      const { settings } = useStore.getState();
      if (settings.masterSalt !== master.salt) {
        // Different key than ours — adopt it and require its password.
        useStore.getState().setSettings({
          masterSalt: master.salt,
          masterCheck: String(master.check ?? ""),
        });
        await masterLock().catch(() => {});
        useStore.setState({ masterLocked: true });
      }
    }
  } else {
    throw new Error("connections.json is not a list of sessions");
  }
  let connections = (list as unknown[]).filter(
    (c): c is Connection =>
      !!c && typeof c === "object" && typeof (c as Connection).id === "string"
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));
  const { settings, masterLocked } = useStore.getState();
  if (settings.masterSalt && !masterLocked) {
    // Same key, already unlocked — keep in-memory copies usable.
    try {
      connections = await mapSecrets(connections, secretsDecrypt);
    } catch {
      /* leave encrypted; unlock will decrypt */
    }
  }
  useStore.setState({ connections });
  return true;
}

/** Enter the master password to decrypt saved secrets for this run. */
export async function unlockMaster(password: string): Promise<boolean> {
  const { settings, connections } = useStore.getState();
  const ok = await masterUnlock(password, settings.masterSalt, settings.masterCheck);
  if (!ok) return false;
  const decrypted = await mapSecrets(connections, secretsDecrypt);
  useStore.setState({ connections: decrypted, masterLocked: false });
  persistAll(decrypted); // normalize storage to fully-encrypted form
  return true;
}

/** Turn on master-password protection and encrypt everything saved. */
export async function enableMaster(password: string): Promise<void> {
  const meta = await masterSetup(password);
  useStore.getState().setSettings({ masterSalt: meta.salt, masterCheck: meta.check });
  useStore.setState({ masterLocked: false });
  persistAll(useStore.getState().connections);
}

/** Verify the current password, then store everything as plain text again. */
export async function disableMaster(password: string): Promise<boolean> {
  const { settings, connections, masterLocked } = useStore.getState();
  const ok = await masterUnlock(password, settings.masterSalt, settings.masterCheck);
  if (!ok) return false;
  // If we were locked, in-memory secrets are still encrypted — decrypt now.
  const plain = masterLocked ? await mapSecrets(connections, secretsDecrypt) : connections;
  useStore.getState().setSettings({ masterSalt: "", masterCheck: "" });
  useStore.setState({ connections: plain, masterLocked: false });
  await masterLock().catch(() => {});
  persistAll(plain);
  return true;
}

/** Re-key: verify the current password, then re-encrypt with a new one. */
export async function changeMaster(current: string, next: string): Promise<boolean> {
  const { settings, connections, masterLocked } = useStore.getState();
  const ok = await masterUnlock(current, settings.masterSalt, settings.masterCheck);
  if (!ok) return false;
  const plain = masterLocked ? await mapSecrets(connections, secretsDecrypt) : connections;
  const meta = await masterSetup(next);
  useStore.getState().setSettings({ masterSalt: meta.salt, masterCheck: meta.check });
  useStore.setState({ connections: plain, masterLocked: false });
  persistAll(plain);
  return true;
}

/**
 * Apply the saved backdrop. The `data-effect` attribute — which is what dims
 * the app's own backgrounds — is only set once the backend confirms the
 * material is really in place; a translucent app over a window that never got
 * its mica would just look washed out. Returns an error message, or null.
 */
export async function applyWindowEffect(effect: WindowEffect): Promise<string | null> {
  try {
    await setWindowEffect(effect);
    document.documentElement.dataset.effect = effect;
    return null;
  } catch (e) {
    document.documentElement.dataset.effect = "opaque";
    return String(e);
  }
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
