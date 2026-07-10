use crate::ssh::connect_and_auth;
use crate::{next_id, AppState, Connection};
use russh::Disconnect;
use std::sync::Arc;
use tauri::State;
use tokio::net::TcpListener;

/// A running local port forward (`ssh -L`): a TCP listener on 127.0.0.1
/// whose accepted connections are piped through direct-tcpip channels on a
/// dedicated SSH connection.
pub struct TunnelSession {
    handle: Arc<crate::ssh::SshHandle>,
    accept_task: tokio::task::JoinHandle<()>,
}

#[tauri::command]
pub async fn tunnel_start(
    conn: Connection,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|e| format!("Cannot listen on 127.0.0.1:{local_port}: {e}"))?;

    let handle = Arc::new(connect_and_auth(&conn).await?);
    let ssh = handle.clone();

    let accept_task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, peer)) = listener.accept().await else {
                break;
            };
            let ssh = ssh.clone();
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
                    Ok(channel) => {
                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                    }
                    Err(_) => drop(socket),
                }
            });
        }
    });

    let id = next_id("tunnel");
    state.tunnels.lock().await.insert(
        id.clone(),
        TunnelSession {
            handle,
            accept_task,
        },
    );
    Ok(id)
}

#[tauri::command]
pub async fn tunnel_stop(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(t) = state.tunnels.lock().await.remove(&id) {
        t.accept_task.abort();
        // Tear down the SSH connection too so in-flight forwards drop
        // instead of lingering after the listener is gone.
        let _ = t
            .handle
            .disconnect(Disconnect::ByApplication, "tunnel stopped", "")
            .await;
    }
    Ok(())
}
