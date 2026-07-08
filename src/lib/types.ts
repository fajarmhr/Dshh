export type Protocol = "ssh" | "sftp" | "ftp" | "serial" | "local";

export type AuthMethod = "password" | "key" | "agent";

/** A saved local port forward (`ssh -L`) attached to a connection. */
export interface TunnelDef {
  id: string;
  localPort: number;
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
  color?: string;
  // SSH extras
  tunnels?: TunnelDef[];
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

/** One-click command snippet sent to the active terminal (XShell "quick command"). */
export interface QuickCommand {
  id: string;
  label: string;
  command: string;
}

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
};

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  ssh: "SSH",
  sftp: "SFTP",
  ftp: "FTP",
  serial: "Serial",
  local: "Local",
};

export const PROTOCOL_COLORS: Record<Protocol, string> = {
  ssh: "#5b8cff",
  sftp: "#3ecf8e",
  ftp: "#e8a54c",
  serial: "#b78af7",
  local: "#5fd0c5",
};

export const UNGROUPED = "Ungrouped";
