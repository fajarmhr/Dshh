use crate::{next_id, AppState, Connection, Logger};
use russh::client::{self, AuthResult, Handle, Handler};
use russh::keys::*;
use russh::ChannelMsg;
use std::io::Write;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::mpsc;

/// Append bytes to a session log if one is active. Flushes each write so the
/// log survives a crash.
fn log_bytes(logger: &Logger, data: &[u8]) {
    if let Ok(mut guard) = logger.lock() {
        if let Some(file) = guard.as_mut() {
            let _ = file.write_all(data);
            let _ = file.flush();
        }
    }
}

/// russh client handler. We accept the host key on first use (TOFU-style).
/// A production build would persist and verify known-hosts here.
pub struct ClientHandler;

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub enum SshCmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

pub struct SshSession {
    pub tx: mpsc::UnboundedSender<SshCmd>,
    pub logger: Logger,
}

/// Establish a TCP+SSH connection and authenticate. Shared by the SSH shell
/// command and the SFTP module — everything runs in-process via russh.
pub async fn connect_and_auth(conn: &Connection) -> Result<Handle<ClientHandler>, String> {
    let host = conn.host.clone().ok_or("Missing host")?;
    let port = conn.port.unwrap_or(22);
    let user = conn.username.clone().unwrap_or_default();

    let config = Arc::new(client::Config::default());
    let connect_fut = client::connect(config, (host.as_str(), port), ClientHandler);
    let mut handle = tokio::time::timeout(std::time::Duration::from_secs(15), connect_fut)
        .await
        .map_err(|_| format!("Connection to {host}:{port} timed out"))?
        .map_err(|e| format!("Connect failed: {e}"))?;

    let method = conn.auth_method.clone().unwrap_or_else(|| "password".into());
    let auth = match method.as_str() {
        "key" => {
            let path = conn
                .private_key_path
                .clone()
                .ok_or("Missing private key path")?;
            let key = load_secret_key(&path, conn.passphrase.as_deref())
                .map_err(|e| format!("Key load failed: {e}"))?;
            handle
                .authenticate_publickey(
                    user,
                    PrivateKeyWithHashAlg::new(Arc::new(key), None),
                )
                .await
                .map_err(|e| format!("Auth error: {e}"))?
        }
        "agent" => return Err("SSH agent auth not implemented yet".into()),
        _ => {
            let password = conn.password.clone().unwrap_or_default();
            handle
                .authenticate_password(user, password)
                .await
                .map_err(|e| format!("Auth error: {e}"))?
        }
    };

    if !matches!(auth, AuthResult::Success) {
        return Err("Authentication failed".into());
    }
    Ok(handle)
}

#[tauri::command]
pub async fn ssh_connect(
    conn: Connection,
    on_data: Channel<Vec<u8>>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let handle = connect_and_auth(&conn).await?;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(|e| e.to_string())?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| e.to_string())?;

    let (tx, mut rx) = mpsc::unbounded_channel::<SshCmd>();
    let id = next_id("ssh");
    let logger: Logger = crate::new_logger();
    let logger_task = logger.clone();

    tokio::spawn(async move {
        let _keepalive = handle; // hold the connection open for the session's life
        let mut channel = channel;
        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            log_bytes(&logger_task, &data);
                            let _ = on_data.send(data.to_vec());
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            log_bytes(&logger_task, &data);
                            let _ = on_data.send(data.to_vec());
                        }
                        Some(ChannelMsg::Eof) | None => break,
                        _ => {}
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(SshCmd::Data(d)) => { let _ = channel.data(&d[..]).await; }
                        Some(SshCmd::Resize(c, r)) => {
                            let _ = channel.window_change(c, r, 0, 0).await;
                        }
                        Some(SshCmd::Close) | None => {
                            let _ = channel.eof().await;
                            break;
                        }
                    }
                }
            }
        }
    });

    state
        .ssh
        .lock()
        .await
        .insert(id.clone(), SshSession { tx, logger });
    Ok(id)
}

#[tauri::command]
pub async fn ssh_write(id: String, data: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(s) = state.ssh.lock().await.get(&id) {
        let _ = s.tx.send(SshCmd::Data(data.into_bytes()));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(
    id: String,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(s) = state.ssh.lock().await.get(&id) {
        let _ = s.tx.send(SshCmd::Resize(cols, rows));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(s) = state.ssh.lock().await.remove(&id) {
        let _ = s.tx.send(SshCmd::Close);
    }
    Ok(())
}
