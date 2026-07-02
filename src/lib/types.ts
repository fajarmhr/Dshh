export type Protocol = "ssh" | "sftp" | "ftp" | "serial";

export type AuthMethod = "password" | "key" | "agent";

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
}

export type SessionStatus = "connecting" | "connected" | "error" | "closed";

export interface Session {
  id: string;
  connectionId: string;
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

export const DEFAULT_PORTS: Record<Protocol, number> = {
  ssh: 22,
  sftp: 22,
  ftp: 21,
  serial: 0,
};

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  ssh: "SSH",
  sftp: "SFTP",
  ftp: "FTP",
  serial: "Serial",
};

export const PROTOCOL_COLORS: Record<Protocol, string> = {
  ssh: "#5b8cff",
  sftp: "#37c6a4",
  ftp: "#f0a54a",
  serial: "#c07cff",
};

export const UNGROUPED = "Ungrouped";
