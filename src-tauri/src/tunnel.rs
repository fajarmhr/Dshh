use crate::ssh::{connect_and_auth, connect_and_auth_forwarding, ForwardTarget, SshHandle};
use crate::{next_id, AppState, Connection};
use russh::Disconnect;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::State;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Live counters for one forward. The tunnels UI polls these so each row can
/// show a traffic light that actually reflects traffic, rather than only
/// telling you the listener is up.
#[derive(Default)]
pub struct TunnelStats {
    /// Bytes travelling away from this machine.
    tx: AtomicU64,
    /// Bytes arriving.
    rx: AtomicU64,
    /// Connections piped through the forward right now.
    open: AtomicU64,
    /// Connections carried since the forward started.
    total: AtomicU64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatsView {
    pub tx: u64,
    pub rx: u64,
    pub open: u64,
    pub total: u64,
}

impl TunnelStats {
    fn view(&self) -> TunnelStatsView {
        TunnelStatsView {
            tx: self.tx.load(Ordering::Relaxed),
            rx: self.rx.load(Ordering::Relaxed),
            open: self.open.load(Ordering::Relaxed),
            total: self.total.load(Ordering::Relaxed),
        }
    }
}

/// A running port forward. Each one owns a dedicated SSH connection so that
/// closing a terminal never takes a forward down with it.
pub struct TunnelSession {
    /// Held for the forward's lifetime; dropping it closes the connection.
    handle: Arc<SshHandle>,
    /// The local accept loop. Remote forwards have none — there the server
    /// listens and pushes channels at our handler instead.
    accept_task: Option<tokio::task::JoinHandle<()>>,
    /// Port the *server* is listening on, for remote forwards only, so stop
    /// can ask it to stop listening.
    remote_bind_port: Option<u16>,
    stats: Arc<TunnelStats>,
}

/// Copy one direction, counting bytes as they pass. `copy_bidirectional` would
/// be shorter but only reports totals once the transfer is over, which is no
/// use for a live indicator.
async fn copy_counted<R, W>(mut r: R, mut w: W, counter: &AtomicU64) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        let n = r.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        w.write_all(&buf[..n]).await?;
        counter.fetch_add(n as u64, Ordering::Relaxed);
    }
    let _ = w.shutdown().await;
    Ok(())
}

/// Pump a local socket and an SSH channel into each other until both directions
/// hang up, keeping `stats` current throughout. Each half shuts its writer on
/// EOF, so the peer sees the close and the other half finishes too instead of
/// leaving a half-open pipe parked forever.
pub async fn splice<S>(socket: TcpStream, channel: S, stats: Arc<TunnelStats>)
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    stats.open.fetch_add(1, Ordering::Relaxed);
    stats.total.fetch_add(1, Ordering::Relaxed);
    let (local_r, local_w) = tokio::io::split(socket);
    let (chan_r, chan_w) = tokio::io::split(channel);
    let _ = tokio::join!(
        copy_counted(local_r, chan_w, &stats.tx),
        copy_counted(chan_r, local_w, &stats.rx),
    );
    stats.open.fetch_sub(1, Ordering::Relaxed);
}

/// `ssh -L`: listen locally, forward every connection to one fixed address on
/// the far side.
async fn start_local(
    conn: &Connection,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    stats: Arc<TunnelStats>,
) -> Result<TunnelSession, String> {
    let listener = bind_local(local_port).await?;
    let handle = Arc::new(connect_and_auth(conn).await?);
    let ssh = handle.clone();
    let accepted = stats.clone();

    let accept_task = tokio::spawn(async move {
        while let Ok((socket, peer)) = listener.accept().await {
            let ssh = ssh.clone();
            let stats = accepted.clone();
            let remote_host = remote_host.clone();
            tokio::spawn(async move {
                match ssh
                    .channel_open_direct_tcpip(
                        remote_host,
                        remote_port as u32,
                        "127.0.0.1",
                        peer.port() as u32,
                    )
                    .await
                {
                    Ok(channel) => splice(socket, channel.into_stream(), stats).await,
                    Err(_) => drop(socket),
                }
            });
        }
    });

    Ok(TunnelSession {
        handle,
        accept_task: Some(accept_task),
        remote_bind_port: None,
        stats,
    })
}

/// `ssh -R`: the server listens on `remote_port` and hands us each connection,
/// which we deliver to `host:port` as reached from this machine.
async fn start_remote(
    conn: &Connection,
    host: String,
    port: u16,
    remote_port: u16,
    stats: Arc<TunnelStats>,
) -> Result<TunnelSession, String> {
    let handle = Arc::new(
        connect_and_auth_forwarding(conn, ForwardTarget { host, port, stats: stats.clone() })
            .await?,
    );
    // An empty bind address asks for every interface the server permits;
    // sshd's GatewayPorts setting decides whether that is honoured or quietly
    // narrowed to loopback.
    handle
        .tcpip_forward("", remote_port as u32)
        .await
        .map_err(|e| {
            format!("Server refused to listen on port {remote_port}: {e} — check sshd's GatewayPorts and that the port is free")
        })?;

    Ok(TunnelSession {
        handle,
        accept_task: None,
        remote_bind_port: Some(remote_port),
        stats,
    })
}

/// `ssh -D`: a SOCKS5 proxy on localhost. Unlike the other two kinds the
/// destination is not fixed — each client request names its own.
async fn start_dynamic(
    conn: &Connection,
    local_port: u16,
    stats: Arc<TunnelStats>,
) -> Result<TunnelSession, String> {
    let listener = bind_local(local_port).await?;
    let handle = Arc::new(connect_and_auth(conn).await?);
    let ssh = handle.clone();
    let accepted = stats.clone();

    let accept_task = tokio::spawn(async move {
        while let Ok((mut socket, peer)) = listener.accept().await {
            let ssh = ssh.clone();
            let stats = accepted.clone();
            tokio::spawn(async move {
                let Ok((host, port)) = socks5_target(&mut socket).await else {
                    return;
                };
                match ssh
                    .channel_open_direct_tcpip(
                        host,
                        port as u32,
                        "127.0.0.1",
                        peer.port() as u32,
                    )
                    .await
                {
                    Ok(channel) => {
                        if socks5_reply(&mut socket, SOCKS5_OK).await.is_ok() {
                            splice(socket, channel.into_stream(), stats).await;
                        }
                    }
                    Err(_) => {
                        let _ = socks5_reply(&mut socket, SOCKS5_UNREACHABLE).await;
                    }
                }
            });
        }
    });

    Ok(TunnelSession {
        handle,
        accept_task: Some(accept_task),
        remote_bind_port: None,
        stats,
    })
}

async fn bind_local(port: u16) -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("Cannot listen on 127.0.0.1:{port}: {e}"))
}

// ---- SOCKS5 (RFC 1928), just enough of it: no auth, CONNECT only ----

const SOCKS5_OK: u8 = 0;
const SOCKS5_UNREACHABLE: u8 = 4;
const SOCKS5_CMD_UNSUPPORTED: u8 = 7;
const SOCKS5_ADDR_UNSUPPORTED: u8 = 8;

fn socks_err(msg: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, msg)
}

/// Read a client's SOCKS5 greeting and CONNECT request, returning the address
/// it wants. The caller sends the reply, because only it knows whether the SSH
/// channel to that address actually opened.
async fn socks5_target(socket: &mut TcpStream) -> std::io::Result<(String, u16)> {
    let mut greeting = [0u8; 2];
    socket.read_exact(&mut greeting).await?;
    if greeting[0] != 5 {
        return Err(socks_err("not a SOCKS5 client"));
    }
    let mut methods = vec![0u8; greeting[1] as usize];
    socket.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        // 0xff = no acceptable method. We only speak unauthenticated SOCKS;
        // the tunnel itself is already authenticated by SSH.
        socket.write_all(&[5, 0xff]).await?;
        return Err(socks_err("client insists on SOCKS5 authentication"));
    }
    socket.write_all(&[5, 0]).await?;

    let mut request = [0u8; 4];
    socket.read_exact(&mut request).await?;
    if request[1] != 1 {
        // BIND and UDP ASSOCIATE are out of scope; OpenSSH's -D omits them too.
        socks5_reply(socket, SOCKS5_CMD_UNSUPPORTED).await?;
        return Err(socks_err("only the SOCKS5 CONNECT command is supported"));
    }
    let host = match request[3] {
        1 => {
            let mut addr = [0u8; 4];
            socket.read_exact(&mut addr).await?;
            std::net::Ipv4Addr::from(addr).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            socket.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            socket.read_exact(&mut name).await?;
            // Names are resolved on the far side, which is the point of -D.
            String::from_utf8(name).map_err(|_| socks_err("hostname is not valid UTF-8"))?
        }
        4 => {
            let mut addr = [0u8; 16];
            socket.read_exact(&mut addr).await?;
            std::net::Ipv6Addr::from(addr).to_string()
        }
        _ => {
            socks5_reply(socket, SOCKS5_ADDR_UNSUPPORTED).await?;
            return Err(socks_err("unsupported SOCKS5 address type"));
        }
    };
    let mut port = [0u8; 2];
    socket.read_exact(&mut port).await?;
    Ok((host, u16::from_be_bytes(port)))
}

/// A SOCKS5 reply. The bound address is always reported as 0.0.0.0:0 — clients
/// only need a real one for BIND, which we don't offer.
async fn socks5_reply(socket: &mut TcpStream, code: u8) -> std::io::Result<()> {
    socket.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await
}

// ---- Commands ----

/// Start a forward. `kind` mirrors OpenSSH's flags — `local` = `-L`,
/// `remote` = `-R`, `dynamic` = `-D` — and defaults to `local` for tunnels
/// saved before kinds existed.
///
/// The three kinds read the arguments differently:
/// - `local`: listen on `local_port`, forward to `remote_host:remote_port`.
/// - `remote`: server listens on `remote_port`, we deliver to
///   `remote_host:local_port`.
/// - `dynamic`: listen on `local_port`; each SOCKS request names its own target.
#[tauri::command]
pub async fn tunnel_start(
    conn: Connection,
    kind: Option<String>,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let stats = Arc::new(TunnelStats::default());
    let session = match kind.as_deref().unwrap_or("local") {
        "remote" => start_remote(&conn, remote_host, local_port, remote_port, stats).await?,
        "dynamic" => start_dynamic(&conn, local_port, stats).await?,
        _ => start_local(&conn, local_port, remote_host, remote_port, stats).await?,
    };

    let id = next_id("tunnel");
    state.tunnels.lock().await.insert(id.clone(), session);
    Ok(id)
}

#[tauri::command]
pub async fn tunnel_stop(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(t) = state.tunnels.lock().await.remove(&id) {
        if let Some(task) = t.accept_task {
            task.abort();
        }
        // A remote forward's listener lives on the server, so ask it to stop
        // before hanging up — otherwise a restart hits "port already in use".
        if let Some(port) = t.remote_bind_port {
            let _ = t.handle.cancel_tcpip_forward("", port as u32).await;
        }
        // Tear down the SSH connection too so in-flight forwards drop
        // instead of lingering after the listener is gone.
        let _ = t
            .handle
            .disconnect(Disconnect::ByApplication, "tunnel stopped", "")
            .await;
    }
    Ok(())
}

/// Byte counters for the given running forwards, keyed by tunnel id. Ids that
/// are no longer running are simply absent.
#[tauri::command]
pub async fn tunnel_stats(
    ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<HashMap<String, TunnelStatsView>, String> {
    let tunnels = state.tunnels.lock().await;
    Ok(ids
        .into_iter()
        .filter_map(|id| tunnels.get(&id).map(|t| (id, t.stats.view())))
        .collect())
}
