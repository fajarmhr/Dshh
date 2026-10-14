import { invoke, Channel } from "@tauri-apps/api/core";
import type { Connection, Listing, LocalShell, RemoteFile, TunnelKind } from "./types";

/**
 * All backend calls funnel through here. Terminal-style byte streams
 * (SSH shell, serial) use Tauri Channels so bytes flow straight from
 * Rust into the frontend without polling. Nothing is shelled out to an
 * external client: every protocol runs inside this app's own executable
 * via Rust crates.
 */

export type ByteHandler = (bytes: Uint8Array) => void;

function byteChannel(onData: ByteHandler): Channel<number[]> {
  const chan = new Channel<number[]>();
  chan.onmessage = (msg) => onData(Uint8Array.from(msg));
  return chan;
}

/** Live byte counts for a running transfer; `total` is 0 when unknown. */
export interface TransferProgress {
  done: number;
  total: number;
}
export type ProgressHandler = (p: TransferProgress) => void;

/**
 * Every transfer command takes a progress channel — the Rust side has no
 * optional-channel argument — so callers that don't draw a bar still get one,
 * with no handler attached.
 */
function progressChannel(onProgress?: ProgressHandler): Channel<TransferProgress> {
  const chan = new Channel<TransferProgress>();
  if (onProgress) chan.onmessage = onProgress;
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

// ---- Local filesystem (dual-pane drag & drop in the file browser) ----
export const localFsHome = () => invoke<string>("local_fs_home");
export const localFsList = (path: string) =>
  invoke<RemoteFile[]>("local_fs_list", { path });

// ---- Telnet ----
export async function telnetOpen(
  conn: Connection,
  onData: ByteHandler,
  onClosed: (reason: string) => void
): Promise<string> {
  const closed = new Channel<string>();
  closed.onmessage = onClosed;
  return invoke<string>("telnet_open", {
    conn,
    onData: byteChannel(onData),
    onClosed: closed,
  });
}
export const telnetWrite = (id: string, data: string) => invoke("telnet_write", { id, data });
export const telnetClose = (id: string) => invoke("telnet_close", { id });

// ---- VNC (remote desktop; screen updates arrive as binary packets) ----
export interface VncHello {
  id: string;
  width: number;
  height: number;
  /** Desktop name from ServerInit. */
  name: string;
  /** RFB version spoken, e.g. "3.8". */
  version: string;
  /** How we logged in, e.g. "vnc password" or "vencrypt · tls · user". */
  security: string;
}
export type VncEvent =
  | { kind: "closed"; reason: string }
  | { kind: "clipboard"; text: string }
  | { kind: "bell" };
export async function vncConnect(
  conn: Connection,
  /** The SSH connection to tunnel through, if any. */
  via: Connection | null,
  /** Console token, for `vncMode: "console"`. */
  token: string | null,
  onFrame: (packet: ArrayBuffer) => void,
  onEvent: (event: VncEvent) => void
): Promise<VncHello> {
  const frames = new Channel<ArrayBuffer>();
  frames.onmessage = onFrame;
  const events = new Channel<VncEvent>();
  events.onmessage = onEvent;
  return invoke<VncHello>("vnc_connect", { conn, via, token, onFrame: frames, onEvent: events });
}
export const vncKey = (id: string, keysym: number, code: number, down: boolean) =>
  invoke("vnc_key", { id, keysym, code, down });
export const vncPointer = (id: string, x: number, y: number, buttons: number) =>
  invoke("vnc_pointer", { id, x, y, buttons });
export const vncClipboard = (id: string, text: string) => invoke("vnc_clipboard", { id, text });
/** Type text as key presses (for consoles without a clipboard). */
export const vncType = (id: string, text: string) => invoke("vnc_type", { id, text });
/** Tell the backend a screen packet has been drawn, so it may ask for more. */
export const vncAck = (id: string) => invoke("vnc_ack", { id });
export const vncClose = (id: string) => invoke("vnc_close", { id });
/**
 * Read the text in an RGBA image with Windows' OCR. The pixels go over as a
 * raw body (a JSON array of a screenful of bytes would be megabytes).
 */
export const ocrImage = (width: number, height: number, rgba: Uint8Array) =>
  invoke<string>("ocr_image", rgba, {
    headers: { "x-width": String(width), "x-height": String(height) },
  });

// ---- Remote file editing (SFTP download → local editor → auto re-upload) ----
export async function editStart(
  conn: Connection,
  remote: string,
  onEvent: (msg: string) => void
): Promise<string> {
  const events = new Channel<string>();
  events.onmessage = onEvent;
  return invoke<string>("edit_start", { conn, remote, onEvent: events });
}
export const editStop = (id: string) => invoke("edit_stop", { id });

// ---- SCP (file copy over the SSH exec channel) ----
export const scpUpload = (
  conn: Connection,
  local: string,
  remote: string,
  onProgress?: ProgressHandler
) => invoke("scp_upload", { conn, local, remote, onProgress: progressChannel(onProgress) });
export const scpDownload = (
  conn: Connection,
  remote: string,
  local: string,
  onProgress?: ProgressHandler
) => invoke("scp_download", { conn, remote, local, onProgress: progressChannel(onProgress) });

// ---- SFTP ----
export const sftpConnect = (conn: Connection) => invoke<string>("sftp_connect", { conn });
export const sftpList = (id: string, path: string) =>
  invoke<Listing>("sftp_list", { id, path });
export const sftpDownload = (
  id: string,
  remote: string,
  local: string,
  onProgress?: ProgressHandler
) => invoke("sftp_download", { id, remote, local, onProgress: progressChannel(onProgress) });
export const sftpUpload = (
  id: string,
  local: string,
  remote: string,
  onProgress?: ProgressHandler
) => invoke("sftp_upload", { id, local, remote, onProgress: progressChannel(onProgress) });
export const sftpDisconnect = (id: string) => invoke("sftp_disconnect", { id });

// ---- Bulk file operations (multi-select in the file browser) ----
/** A selected entry, as the listing described it. */
export interface FileTarget {
  path: string;
  isDir: boolean;
  size?: number;
}
export interface TreeEntry {
  path: string;
  isDir: boolean;
  size: number;
  /** Symlink: never descended into. */
  link: boolean;
}
/** Everything under a selection, selection first. */
export interface FileTree {
  entries: TreeEntry[];
  /** Folders that couldn't be listed (permissions), so weren't walked. */
  unreadable: string[];
}
export interface OpReport {
  files: number;
  dirs: number;
  failed: number;
  /** The first few failures, as "path: reason". */
  errors: string[];
}
export const sftpTree = (id: string, targets: FileTarget[]) =>
  invoke<FileTree>("sftp_tree", { id, targets });
export const sftpDelete = (id: string, targets: FileTarget[]) =>
  invoke<OpReport>("sftp_delete", { id, targets });
export const sftpChmod = (
  id: string,
  targets: FileTarget[],
  mode: number,
  recursive: boolean,
  dirExec: boolean
) => invoke<OpReport>("sftp_chmod", { id, targets, mode, recursive, dirExec });
export const sftpChown = (
  id: string,
  targets: FileTarget[],
  owner: string | null,
  group: string | null,
  recursive: boolean
) => invoke<OpReport>("sftp_chown", { id, targets, owner, group, recursive });
/** User and group names known on the server. */
export const sftpPrincipals = (id: string) =>
  invoke<{ users: string[]; groups: string[] }>("sftp_principals", { id });
export const ftpTree = (id: string, targets: FileTarget[]) =>
  invoke<FileTree>("ftp_tree", { id, targets });
export const ftpDelete = (id: string, targets: FileTarget[]) =>
  invoke<OpReport>("ftp_delete", { id, targets });
/** `SITE CHMOD` — FTP has no ownership command. */
export const ftpChmod = (
  id: string,
  targets: FileTarget[],
  mode: number,
  recursive: boolean,
  dirExec: boolean
) => invoke<OpReport>("ftp_chmod", { id, targets, mode, recursive, dirExec });
export const localMkdir = (path: string) => invoke("local_mkdir", { path });

// ---- FTP ----
export const ftpConnect = (conn: Connection) => invoke<string>("ftp_connect", { conn });
export const ftpList = (id: string, path: string) =>
  invoke<Listing>("ftp_list", { id, path });
export const ftpDownload = (
  id: string,
  remote: string,
  local: string,
  onProgress?: ProgressHandler
) => invoke("ftp_download", { id, remote, local, onProgress: progressChannel(onProgress) });
export const ftpUpload = (
  id: string,
  local: string,
  remote: string,
  onProgress?: ProgressHandler
) => invoke("ftp_upload", { id, local, remote, onProgress: progressChannel(onProgress) });
export const ftpDisconnect = (id: string) => invoke("ftp_disconnect", { id });

// ---- Server-to-server copy (runs on server A, data never passes through here) ----
/** What a copy got through; `failed` is only ever set for an FTP server B. */
export interface PeerCopyReport {
  files: number;
  failed: number;
  firstError: string | null;
  /** Folders under the selection that couldn't be listed. */
  unreadable: number;
}
export interface PeerCopyArgs {
  /** Server A: the SFTP session the file browser holds. */
  id: string;
  /** Server B as it authenticated here — its credentials are used on A. */
  peer: Connection;
  /** Server B's own SFTP/FTP session from this PC, for walking and folders. */
  peerId: string;
  /** Where A dials B (`host[:port]`); null for B's own address. */
  route: string | null;
  /** `push`: A's files to B. `pull`: B's files to A. */
  direction: "push" | "pull";
  items: FileTarget[];
  /** Destination folder on the receiving server. */
  dest: string;
  /** Names the copy for `peerCancel`. */
  job: string;
}
export const peerCopy = (args: PeerCopyArgs, onProgress?: ProgressHandler) =>
  invoke<PeerCopyReport>("peer_copy", { ...args, onProgress: progressChannel(onProgress) });
export const peerCancel = (job: string) => invoke("peer_cancel", { job });

// ---- Port forwarding (ssh -L / -R / -D) ----
export const tunnelStart = (
  conn: Connection,
  kind: TunnelKind,
  localPort: number,
  remoteHost: string,
  remotePort: number
) => invoke<string>("tunnel_start", { conn, kind, localPort, remoteHost, remotePort });
export const tunnelStop = (id: string) => invoke("tunnel_stop", { id });

/** Live byte counters for a forward, as read by the traffic indicators. */
export interface TunnelStats {
  tx: number;
  rx: number;
  open: number;
  total: number;
}
/** Counters for the given backend tunnel ids; ids no longer running are absent. */
export const tunnelStats = (ids: string[]) =>
  invoke<Record<string, TunnelStats>>("tunnel_stats", { ids });

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
/**
 * The portable `data/` folder beside the exe, or "" when the app is running
 * non-portably (settings then live in the per-user WebView2 profile).
 */
export const portableDataDir = () => invoke<string>("portable_data_dir");
/**
 * Where logs land when the user hasn't chosen a folder: `logs` inside the
 * portable data folder, or "" when running non-portably. Memoised — it cannot
 * change while the app is running, and it is read on every Record click.
 */
let logDirDefault: Promise<string> | null = null;
export const defaultLogDir = () =>
  (logDirDefault ??= invoke<string>("default_log_dir").catch(() => ""));
/**
 * Apply a Windows 11 backdrop. Rejects when the material is unavailable (any
 * OS but Windows 11), so callers should only dim their own backgrounds after
 * this resolves.
 */
export const setWindowEffect = (effect: string) =>
  invoke("set_window_effect", { effect });
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

// ---- Clipboard ----
// Goes through Rust rather than `navigator.clipboard`, which can't read the
// clipboard inside a Tauri webview. Reading an empty or non-text clipboard
// yields "" instead of throwing.
export const clipboardRead = () => invoke<string>("clipboard_read");
export const clipboardWrite = (text: string) => invoke("clipboard_write", { text });
