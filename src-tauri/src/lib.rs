mod crypto;
mod ftp;
mod local;
mod logs;
mod scp;
mod serial;
mod sftp;
mod ssh;
mod tunnel;
mod update;

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::Mutex;

/// Connection profile mirrored from the frontend (camelCase JSON).
#[derive(Debug, Clone, Deserialize)]
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
}

/// A file entry returned to the frontend for SFTP/FTP browsing.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RemoteFile {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
}

/// Shared handle to an optional open log file for a streaming session.
/// `None` means logging is off; `Some(file)` means bytes are being recorded.
pub type Logger = std::sync::Arc<std::sync::Mutex<Option<std::fs::File>>>;

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
}

static COUNTER: AtomicU64 = AtomicU64::new(1);

pub fn next_id(prefix: &str) -> String {
    format!("{}-{}", prefix, COUNTER.fetch_add(1, Ordering::Relaxed))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            scp::scp_upload,
            scp::scp_download,
            sftp::sftp_connect,
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_disconnect,
            ftp::ftp_connect,
            ftp::ftp_list,
            ftp::ftp_download,
            ftp::ftp_upload,
            ftp::ftp_disconnect,
            logs::log_start,
            logs::log_stop,
            logs::save_text_file,
            logs::read_text_file,
            tunnel::tunnel_start,
            tunnel::tunnel_stop,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Dshh");
}
