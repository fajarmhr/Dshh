mod clipboard;
mod crypto;
mod edit;
mod effects;
mod fileops;
mod ftp;
mod local;
mod localfs;
mod logs;
mod ocr;
mod peer;
mod portable;
mod progress;
mod scp;
mod serial;
mod sftp;
mod ssh;
mod telnet;
mod tunnel;
mod update;
mod vnc;

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::Mutex;

/// Connection profile mirrored from the frontend (camelCase JSON).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub auth_method: Option<String>,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
    pub ftp_secure: Option<bool>,
    pub serial_port: Option<String>,
    pub baud_rate: Option<u32>,
    // Optional SSH jump host (bastion). One hop; auth mirrors the main fields.
    pub jump_host: Option<String>,
    pub jump_port: Option<u16>,
    pub jump_username: Option<String>,
    pub jump_auth_method: Option<String>,
    pub jump_password: Option<String>,
    pub jump_key_path: Option<String>,
    pub jump_passphrase: Option<String>,
    // VNC: "direct" (RFB over TCP or an SSH channel) or "console" (a noVNC
    // proxy reached over a WebSocket, as OpenStack console links are).
    pub vnc_mode: Option<String>,
    /// Console WebSocket path; defaults to noVNC's `websockify`.
    pub vnc_path: Option<String>,
    /// Console over https/wss (the default) rather than http/ws.
    pub vnc_tls: Option<bool>,
    /// Check TLS certificates instead of accepting self-signed ones.
    pub vnc_verify_tls: Option<bool>,
}

/// A file entry returned to the frontend for SFTP/FTP browsing.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
    /// Owning user and its group, when the server reports them: SFTP sends
    /// numeric ids (resolved against the host's `/etc/passwd` where readable),
    /// FTP carries the names in its `LIST` output. `None` where neither is
    /// available — Windows SFTP servers, MLSD listings, local files.
    pub owner: Option<String>,
    pub group: Option<String>,
    /// Permission bits (`0o755`, plus setuid/setgid/sticky), when the server
    /// reports them — SFTP attributes, or a POSIX `LIST` line over FTP.
    pub mode: Option<u32>,
}

/// A directory listing plus the path the server actually resolved it to, so
/// the address bar can show where a relative request like "." landed.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub files: Vec<RemoteFile>,
}

/// Shared handle to an optional session log for a streaming session.
/// `None` means logging is off; `Some(sink)` means output is being recorded
/// (filtered to readable plain text by [`logs::LogSink`]).
pub type Logger = std::sync::Arc<std::sync::Mutex<Option<logs::LogSink>>>;

pub fn new_logger() -> Logger {
    std::sync::Arc::new(std::sync::Mutex::new(None))
}

/// Global backend state: one map per protocol keyed by an opaque session id.
#[derive(Default)]
pub struct AppState {
    pub ssh: Mutex<HashMap<String, ssh::SshSession>>,
    pub sftp: Mutex<HashMap<String, sftp::SftpConn>>,
    pub ftp: Mutex<HashMap<String, ftp::FtpConn>>,
    pub serial: Mutex<HashMap<String, serial::SerialSession>>,
    pub local: Mutex<HashMap<String, local::LocalSession>>,
    pub tunnels: Mutex<HashMap<String, tunnel::TunnelSession>>,
    pub telnet: Mutex<HashMap<String, telnet::TelnetSession>>,
    pub edits: Mutex<HashMap<String, edit::EditSession>>,
    pub vnc: Mutex<HashMap<String, vnc::VncSession>>,
    /// Server-to-server copies in flight, by the job id the frontend chose.
    pub peer_jobs: Mutex<HashMap<String, std::sync::Arc<tokio::sync::Notify>>>,
}

static COUNTER: AtomicU64 = AtomicU64::new(1);

pub fn next_id(prefix: &str) -> String {
    format!("{}-{}", prefix, COUNTER.fetch_add(1, Ordering::Relaxed))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Must precede the builder: WebView2 reads its user-data folder from the
    // environment when the webview is created, and that folder is where
    // localStorage — settings, saved connections — actually lives.
    portable::init();
    update::cleanup_stale_update();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(crypto::CryptoState::default())
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            serial::serial_list_ports,
            serial::serial_open,
            serial::serial_write,
            serial::serial_close,
            local::local_list_shells,
            local::local_open,
            local::local_write,
            local::local_resize,
            local::local_close,
            local::local_open_admin,
            localfs::local_fs_home,
            localfs::local_fs_list,
            localfs::local_mkdir,
            scp::scp_upload,
            scp::scp_download,
            sftp::sftp_connect,
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_disconnect,
            sftp::sftp_tree,
            sftp::sftp_delete,
            sftp::sftp_chmod,
            sftp::sftp_chown,
            sftp::sftp_principals,
            ftp::ftp_connect,
            ftp::ftp_list,
            ftp::ftp_download,
            ftp::ftp_upload,
            ftp::ftp_disconnect,
            ftp::ftp_tree,
            ftp::ftp_delete,
            ftp::ftp_chmod,
            peer::peer_copy,
            peer::peer_cancel,
            logs::log_start,
            logs::log_stop,
            logs::save_text_file,
            logs::read_text_file,
            clipboard::clipboard_read,
            clipboard::clipboard_write,
            tunnel::tunnel_start,
            tunnel::tunnel_stop,
            tunnel::tunnel_stats,
            telnet::telnet_open,
            telnet::telnet_write,
            telnet::telnet_close,
            vnc::vnc_connect,
            vnc::vnc_key,
            vnc::vnc_pointer,
            vnc::vnc_clipboard,
            vnc::vnc_type,
            vnc::vnc_ack,
            vnc::vnc_close,
            ocr::ocr_image,
            edit::edit_start,
            edit::edit_stop,
            crypto::master_setup,
            crypto::master_unlock,
            crypto::master_lock,
            crypto::secrets_encrypt,
            crypto::secrets_decrypt,
            update::app_version,
            update::update_check,
            update::update_apply,
            update::update_restart,
            update::open_url,
            portable::portable_data_dir,
            portable::default_log_dir,
            effects::set_window_effect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Dshh");
}
