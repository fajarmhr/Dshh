use crate::tunnel::{splice, TunnelStats};
use crate::{next_id, AppState, Connection, Logger};
use russh::client::{self, AuthResult, Handle, Handler, Msg, Session};
use russh::keys::agent::AgentIdentity;
use russh::keys::*;
use russh::ChannelMsg;
use std::sync::Arc;
use tauri::ipc::Channel as IpcChannel;
use tauri::State;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;

use crate::logs::log_bytes;

/// Where a remote forward (`ssh -R`) delivers the channels the server pushes
/// back at us, plus the counters the tunnels UI polls.
#[derive(Clone)]
pub struct ForwardTarget {
    pub host: String,
    pub port: u16,
    pub stats: Arc<TunnelStats>,
}

/// russh client handler. We accept the host key on first use (TOFU-style).
/// A production build would persist and verify known-hosts here.
pub struct ClientHandler {
    /// Set only on the dedicated connection behind a remote forward; every
    /// other connection leaves this `None` and declines forwarded channels.
    forward: Option<ForwardTarget>,
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    /// A remote forward fired: something connected to the port the server is
    /// listening on for us, and this channel carries that connection. Pipe it
    /// to the local address the user pointed the forward at.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Some(target) = self.forward.clone() else {
            return Ok(());
        };
        tokio::spawn(async move {
            match tokio::net::TcpStream::connect((target.host.as_str(), target.port)).await {
                Ok(socket) => splice(socket, channel.into_stream(), target.stats).await,
                // Nothing is listening locally. Dropping the channel is as
                // close as SSH gets to handing the remote peer a refusal.
                Err(_) => drop(channel),
            }
        });
        Ok(())
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
        "agent" => return agent_authenticate(handle, &user).await,
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

/// Servers count every public key we offer against `MaxAuthTries` (6 by
/// default) and drop the connection once it is exhausted, so a crowded agent
/// gets truncated rather than disconnected mid-attempt.
const MAX_AGENT_IDENTITIES: usize = 5;

/// Authenticate out of a running SSH agent, so the private key never enters
/// this process. Windows has two agents in common use and no way to tell which
/// one holds the user's keys, so try the OpenSSH service first (it ships with
/// Windows) and fall back to PuTTY's Pageant.
async fn agent_authenticate(
    handle: &mut Handle<ClientHandler>,
    user: &str,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut errors = Vec::new();
        match agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            Ok(mut agent) => match agent_try_identities(handle, user, &mut agent).await {
                Ok(()) => return Ok(()),
                Err(e) => errors.push(e),
            },
            Err(e) => errors.push(format!("OpenSSH agent: {e}")),
        }
        match agent::client::AgentClient::connect_pageant().await {
            Ok(mut agent) => match agent_try_identities(handle, user, &mut agent).await {
                Ok(()) => return Ok(()),
                Err(e) => errors.push(e),
            },
            Err(e) => errors.push(format!("Pageant: {e}")),
        }
        Err(format!("SSH agent authentication failed — {}", errors.join("; ")))
    }
    #[cfg(not(windows))]
    {
        let mut agent = agent::client::AgentClient::connect_env()
            .await
            .map_err(|e| format!("No SSH agent available: {e}"))?;
        agent_try_identities(handle, user, &mut agent).await
    }
}

/// Offer each identity the agent holds until one is accepted. The agent does
/// the signing, which is the whole point: we only ever see public keys.
async fn agent_try_identities<R>(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    agent: &mut agent::client::AgentClient<R>,
) -> Result<(), String>
where
    R: AsyncRead + AsyncWrite + Unpin + Send,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| format!("agent holds no usable keys: {e}"))?;
    if identities.is_empty() {
        return Err("agent is running but holds no keys (ssh-add one first)".into());
    }

    for identity in identities.into_iter().take(MAX_AGENT_IDENTITIES) {
        let auth = match &identity {
            AgentIdentity::PublicKey { key, .. } => {
                let hash = rsa_hash_for(handle, key.algorithm()).await;
                handle
                    .authenticate_publickey_with(user, key.clone(), hash, agent)
                    .await
            }
            AgentIdentity::Certificate { certificate, .. } => {
                let hash = rsa_hash_for(handle, certificate.algorithm()).await;
                handle
                    .authenticate_certificate_with(user, certificate.clone(), hash, agent)
                    .await
            }
        };
        match auth {
            Ok(AuthResult::Success) => return Ok(()),
            // A key the server doesn't know about is the normal case when an
            // agent holds several; keep going rather than reporting failure.
            Ok(_) => continue,
            Err(e) => return Err(format!("agent signing failed: {e}")),
        }
    }
    Err("no key in the agent was accepted by the server".into())
}

/// RSA keys need an explicit SHA-2 signature algorithm; ssh-rsa (SHA-1) is
/// refused by anything current. Ask the server what it accepts and fall back
/// to SHA-512 when it doesn't advertise `server-sig-algs`. Other key types
/// have exactly one algorithm, signalled by `None`.
async fn rsa_hash_for(handle: &Handle<ClientHandler>, algorithm: Algorithm) -> Option<HashAlg> {
    if !matches!(algorithm, Algorithm::Rsa { .. }) {
        return None;
    }
    match handle.best_supported_rsa_hash().await {
        Ok(Some(alg)) => alg,
        _ => Some(HashAlg::Sha512),
    }
}

/// Establish an SSH connection and authenticate. Shared by the shell, SFTP,
/// SCP, tunnel, and edit modules.
pub async fn connect_and_auth(conn: &Connection) -> Result<SshHandle, String> {
    connect_with(conn, None).await
}

/// Like [`connect_and_auth`], but the resulting connection accepts the
/// forwarded-tcpip channels a remote forward (`ssh -R`) makes the server open
/// back towards us, piping each one to `forward`.
pub async fn connect_and_auth_forwarding(
    conn: &Connection,
    forward: ForwardTarget,
) -> Result<SshHandle, String> {
    connect_with(conn, Some(forward)).await
}

/// Connect directly over TCP, or through an optional jump host (`ssh -J`):
/// the jump connection opens a direct-tcpip channel to the target and the
/// target's SSH session runs over that channel.
async fn connect_with(
    conn: &Connection,
    forward: Option<ForwardTarget>,
) -> Result<SshHandle, String> {
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
        // its own, so this recursion always bottoms out on the TCP branch. The
        // jump hop never carries a forward — only the target connection does.
        let jump = Box::pin(connect_with(&jump_conn, None))
            .await
            .map_err(|e| format!("Jump host {jump_host}: {e}"))?;
        let channel = jump
            .channel_open_direct_tcpip(host.clone(), port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| format!("Jump host cannot reach {host}:{port}: {e}"))?;
        let connect_fut = client::connect_stream(
            ssh_config(),
            channel.into_stream(),
            ClientHandler { forward },
        );
        let mut handle = tokio::time::timeout(std::time::Duration::from_secs(15), connect_fut)
            .await
            .map_err(|_| format!("Connection to {host}:{port} via jump timed out"))?
            .map_err(|e| format!("Connect via jump failed: {e}"))?;
        authenticate(&mut handle, conn).await?;
        return Ok(SshHandle { handle, _jump: Some(Box::new(jump)) });
    }

    let connect_fut = client::connect(
        ssh_config(),
        (host.as_str(), port),
        ClientHandler { forward },
    );
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
    on_data: IpcChannel<Vec<u8>>,
    on_closed: IpcChannel<String>,
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
