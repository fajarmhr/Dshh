export type Protocol = "ssh" | "sftp" | "ftp" | "serial" | "local" | "telnet";

export type AuthMethod = "password" | "key" | "agent";

/**
 * Which direction a forward runs, mirroring OpenSSH's flags:
 * `local` = `-L`, `remote` = `-R`, `dynamic` = `-D` (a SOCKS5 proxy).
 */
export type TunnelKind = "local" | "remote" | "dynamic";

/** A saved port forward attached to a connection. */
export interface TunnelDef {
  id: string;
  /** Absent on tunnels saved before 0.6 — read those as local forwards. */
  kind?: TunnelKind;
  localPort: number;
  /** Unused for `dynamic`, where the client picks the destination per request. */
  remoteHost: string;
  remotePort: number;
}

export interface Connection {
  id: string;
  name: string;
  protocol: Protocol;
  group?: string;
  // Network protocols (ssh/sftp/ftp)
  host?: string;
  port?: number;
  username?: string;
  authMethod?: AuthMethod;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  // FTP
  ftpSecure?: boolean; // FTPS
  // Serial
  serialPort?: string;
  baudRate?: number;
  // Presentation: an accent colour (sidebar bar, tab underline) and free-form
  // tags, so "am I on prod?" is answerable at a glance.
  color?: string;
  tags?: string[];
  /** Sent once the shell is ready, like MobaXterm's "execute on login". */
  runOnConnect?: string;
  // Per-session terminal overrides; fall back to the global settings.
  themeId?: string;
  fontSize?: number;
  // SSH extras
  tunnels?: TunnelDef[];
  // Optional SSH jump host (bastion) — one hop.
  jumpHost?: string;
  jumpPort?: number;
  jumpUsername?: string;
  jumpAuthMethod?: AuthMethod;
  jumpPassword?: string;
  jumpKeyPath?: string;
  jumpPassphrase?: string;
  // Local terminal: shell id (from local_list_shells), optional working dir,
  // and whether to launch elevated (opens in a separate UAC window).
  shell?: string;
  cwd?: string;
  admin?: boolean;
}

/** A local shell the backend can launch, from `local_list_shells`. */
export interface LocalShell {
  id: string;
  label: string;
}

export type SessionStatus = "connecting" | "connected" | "error" | "closed";

export interface Session {
  id: string;
  connectionId: string;
  /** May differ from the connection's protocol, e.g. an SFTP view opened from an SSH session. */
  protocol: Protocol;
  title: string;
  status: SessionStatus;
  error?: string;
}

export interface RemoteFile {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number | null; // epoch seconds
}

/** A listing plus the path the server resolved it to ("." → "/home/you"). */
export interface Listing {
  path: string;
  files: RemoteFile[];
}

/** One-click command snippet sent to the active terminal (XShell "quick command"). */
export interface QuickCommand {
  id: string;
  label: string;
  command: string;
}

/** Terminal cursor shape, matching xterm.js's `cursorStyle`. */
export type CursorStyle = "block" | "bar" | "underline";

/**
 * A recorded sequence of commands replayed into a terminal (MobaXterm's macro
 * recorder). Quick commands are one-shot; a macro is the multi-step version.
 */
export interface Macro {
  id: string;
  label: string;
  steps: string[];
}

/** Accent colours offered for a connection, tuned to the app's palette. */
export const CONNECTION_COLORS: string[] = [
  "#5b8cff",
  "#3ecf8e",
  "#e8a54c",
  "#f26d78",
  "#b78af7",
  "#5fd0c5",
  "#e87a9c",
  "#94a3b8",
];

export type HighlightColor = "red" | "yellow" | "green" | "blue" | "magenta" | "cyan";

/** Case-insensitive keyword colorized in terminal output (XShell "highlight set"). */
export interface HighlightRule {
  id: string;
  pattern: string;
  color: HighlightColor;
}

export const DEFAULT_PORTS: Record<Protocol, number> = {
  ssh: 22,
  sftp: 22,
  ftp: 21,
  serial: 0,
  local: 0,
  telnet: 23,
};

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  ssh: "SSH",
  sftp: "SFTP",
  ftp: "FTP",
  serial: "Serial",
  local: "Local",
  telnet: "Telnet",
};

export const PROTOCOL_COLORS: Record<Protocol, string> = {
  ssh: "#5b8cff",
  sftp: "#3ecf8e",
  ftp: "#e8a54c",
  serial: "#b78af7",
  local: "#5fd0c5",
  telnet: "#e87a9c",
};

export const UNGROUPED = "Ungrouped";
