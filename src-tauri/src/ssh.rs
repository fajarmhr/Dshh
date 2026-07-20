use crate::{next_id, AppState, Connection, Logger};
use russh::client::{self, AuthResult, Handle, Handler};
use russh::keys::*;
use russh::ChannelMsg;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::mpsc;

use crate::logs::log_bytes;

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

/// An authenticated SSH connection. When the target was reached through a
/// jump host, the jump connection is owned here too so the tunnel stays up
/// exactly as long as the target session. Derefs to the russh `Handle`, so
/// call sites use it like a plain handle.
pub struct SshHandle {
    handle: Handle<ClientHandler>,
    _jump: Option<Box<SshHandle>>,
}

impl std::ops::Deref for SshHandle {
    type Target = Handle<ClientHandler>;
    fn deref(&self) -> &Self::Target {
        &self.handle
    }
}

fn ssh_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        // Protocol-level keepalive so idle sessions survive NAT/firewall
        // timeouts and dead peers are detected instead of hanging forever.
        keepalive_interval: Some(std::time::Duration::from_secs(20)),
        keepalive_max: 3,
        ..client::Config::default()
    })
}

async fn authenticate(handle: &mut Handle<ClientHandler>, conn: &Connection) -> Result<(), String> {
    let user = conn.username.clone().unwrap_or_default();
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
    Ok(())
}

/// Establish an SSH connection and authenticate — directly over TCP, or
/// through an optional jump host (`ssh -J`): the jump connection opens a
/// direct-tcpip channel to the target and the target's SSH session runs over
/// that channel. Shared by the shell, SFTP, SCP, tunnel, and edit modules.
pub async fn connect_and_auth(conn: &Connection) -> Result<SshHandle, String> {
    let host = conn.host.clone().ok_or("Missing host")?;
    let port = conn.port.unwrap_or(22);

    let jump_host = conn.jump_host.clone().unwrap_or_default();
    if !jump_host.is_empty() {
        let jump_conn = Connection {
            id: format!("{}-jump", conn.id),
            name: format!("{} (jump)", conn.name),
            protocol: "ssh".into(),
            host: Some(jump_host.clone()),
            port: Some(conn.jump_port.unwrap_or(22)),
            username: conn.jump_username.clone(),
            auth_method: conn.jump_auth_method.clone(),
            password: conn.jump_password.clone(),
            private_key_path: conn.jump_key_path.clone(),
            passphrase: conn.jump_passphrase.clone(),
            ftp_secure: None,
            serial_port: None,
            baud_rate: None,
            jump_host: None,
            jump_port: None,
            jump_username: None,
            jump_auth_method: None,
            jump_password: None,
            jump_key_path: None,
            jump_passphrase: None,
        };
        // One level only: the synthesized jump connection carries no jump of
        // its own, so this recursion always bottoms out on the TCP branch.
        let jump = Box::pin(connect_and_auth(&jump_conn))
            .await
            .map_err(|e| format!("Jump host {jump_host}: {e}"))?;
        let channel = jump
            .channel_open_direct_tcpip(host.clone(), port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| format!("Jump host cannot reach {host}:{port}: {e}"))?;
        let connect_fut = client::connect_stream(ssh_config(), channel.into_stream(), ClientHandler);
        let mut handle = tokio::time::timeout(std::time::Duration::from_secs(15), connect_fut)
            .await
            .map_err(|_| format!("Connection to {host}:{port} via jump timed out"))?
            .map_err(|e| format!("Connect via jump failed: {e}"))?;
        authenticate(&mut handle, conn).await?;
        return Ok(SshHandle { handle, _jump: Some(Box::new(jump)) });
    }

    let connect_fut = client::connect(ssh_config(), (host.as_str(), port), ClientHandler);
    let mut handle = tokio::time::timeout(std::time::Duration::from_secs(15), connect_fut)
        .await
        .map_err(|_| format!("Connection to {host}:{port} timed out"))?
        .map_err(|e| format!("Connect failed: {e}"))?;
    authenticate(&mut handle, conn).await?;
    Ok(SshHandle { handle, _jump: None })
}

#[tauri::command]
pub async fn ssh_connect(
    conn: Connection,
    on_data: Channel<Vec<u8>>,
    on_closed: Channel<String>,
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
        // Tell the frontend the shell ended (remote hangup, network drop,
        // or a local close). The UI decides whether to offer a reconnect.
        let _ = on_closed.send("closed".into());
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
