import { invoke, Channel } from "@tauri-apps/api/core";
import type { Connection, LocalShell, RemoteFile } from "./types";

/**
 * All backend calls funnel through here. Terminal-style byte streams
 * (SSH shell, serial) use Tauri Channels so bytes flow straight from
 * Rust into the frontend without polling. No child process named
 * ssh/sftp/ftp is ever spawned: every protocol runs inside this app's
 * own executable via Rust crates.
 */

export type ByteHandler = (bytes: Uint8Array) => void;

function byteChannel(onData: ByteHandler): Channel<number[]> {
  const chan = new Channel<number[]>();
  chan.onmessage = (msg) => onData(Uint8Array.from(msg));
  return chan;
}

// ---- SSH (interactive shell) ----
export async function sshConnect(
  conn: Connection,
  onData: ByteHandler,
  onClosed: (reason: string) => void
): Promise<string> {
  const closed = new Channel<string>();
  closed.onmessage = onClosed;
  return invoke<string>("ssh_connect", {
    conn,
    onData: byteChannel(onData),
    onClosed: closed,
  });
}
export const sshWrite = (id: string, data: string) => invoke("ssh_write", { id, data });
export const sshResize = (id: string, cols: number, rows: number) =>
  invoke("ssh_resize", { id, cols, rows });
export const sshDisconnect = (id: string) => invoke("ssh_disconnect", { id });

// ---- Serial ----
export const serialListPorts = () => invoke<string[]>("serial_list_ports");
export async function serialOpen(conn: Connection, onData: ByteHandler): Promise<string> {
  return invoke<string>("serial_open", { conn, onData: byteChannel(onData) });
}
export const serialWrite = (id: string, data: string) => invoke("serial_write", { id, data });
export const serialClose = (id: string) => invoke("serial_close", { id });

// ---- Local terminal (cmd / PowerShell / … over a PTY) ----
export const localListShells = () => invoke<LocalShell[]>("local_list_shells");
export async function localOpen(
  shell: string,
  cwd: string | null,
  cols: number,
  rows: number,
  onData: ByteHandler,
  onClosed: (reason: string) => void
): Promise<string> {
  const closed = new Channel<string>();
  closed.onmessage = onClosed;
  return invoke<string>("local_open", {
    shell,
    cwd,
    cols,
    rows,
    onData: byteChannel(onData),
    onClosed: closed,
  });
}
export const localWrite = (id: string, data: string) => invoke("local_write", { id, data });
export const localResize = (id: string, cols: number, rows: number) =>
  invoke("local_resize", { id, cols, rows });
export const localClose = (id: string) => invoke("local_close", { id });
/** Launch an elevated shell in a separate UAC window (Windows only). */
export const localOpenAdmin = (shell: string, cwd: string | null) =>
  invoke("local_open_admin", { shell, cwd });

// ---- SCP (file copy over the SSH exec channel) ----
export const scpUpload = (conn: Connection, local: string, remote: string) =>
  invoke("scp_upload", { conn, local, remote });
export const scpDownload = (conn: Connection, remote: string, local: string) =>
  invoke("scp_download", { conn, remote, local });

// ---- SFTP ----
export const sftpConnect = (conn: Connection) => invoke<string>("sftp_connect", { conn });
export const sftpList = (id: string, path: string) =>
  invoke<RemoteFile[]>("sftp_list", { id, path });
export const sftpDownload = (id: string, remote: string, local: string) =>
  invoke("sftp_download", { id, remote, local });
export const sftpUpload = (id: string, local: string, remote: string) =>
  invoke("sftp_upload", { id, local, remote });
export const sftpDisconnect = (id: string) => invoke("sftp_disconnect", { id });

// ---- FTP ----
export const ftpConnect = (conn: Connection) => invoke<string>("ftp_connect", { conn });
export const ftpList = (id: string, path: string) =>
  invoke<RemoteFile[]>("ftp_list", { id, path });
export const ftpDownload = (id: string, remote: string, local: string) =>
  invoke("ftp_download", { id, remote, local });
export const ftpUpload = (id: string, local: string, remote: string) =>
  invoke("ftp_upload", { id, local, remote });
export const ftpDisconnect = (id: string) => invoke("ftp_disconnect", { id });

// ---- Port forwarding (ssh -L) ----
export const tunnelStart = (
  conn: Connection,
  localPort: number,
  remoteHost: string,
  remotePort: number
) => invoke<string>("tunnel_start", { conn, localPort, remoteHost, remotePort });
export const tunnelStop = (id: string) => invoke("tunnel_stop", { id });

// ---- Master password (secrets encrypted at rest with AES-GCM) ----
export interface MasterMeta {
  salt: string;
  check: string;
}
export const masterSetup = (password: string) =>
  invoke<MasterMeta>("master_setup", { password });
export const masterUnlock = (password: string, salt: string, check: string) =>
  invoke<boolean>("master_unlock", { password, salt, check });
export const masterLock = () => invoke("master_lock");
export const secretsEncrypt = (values: string[]) =>
  invoke<string[]>("secrets_encrypt", { values });
export const secretsDecrypt = (values: string[]) =>
  invoke<string[]>("secrets_decrypt", { values });

// ---- Updates (GitHub Releases self-update) ----
export interface UpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
  notes: string;
  /** Direct download of the portable exe, if the release has one. */
  assetUrl: string | null;
  releaseUrl: string;
}
export const appVersion = () => invoke<string>("app_version");
export const updateCheck = () => invoke<UpdateInfo>("update_check");
export const updateApply = (assetUrl: string) => invoke("update_apply", { assetUrl });
export const updateRestart = () => invoke("update_restart");
export const openUrl = (url: string) => invoke("open_url", { url });

// ---- Logging / local files ----
export const logStart = (id: string, path: string) => invoke("log_start", { id, path });
export const logStop = (id: string) => invoke("log_stop", { id });
export const saveTextFile = (path: string, contents: string) =>
  invoke("save_text_file", { path, contents });
export const readTextFile = (path: string) =>
  invoke<string>("read_text_file", { path });
