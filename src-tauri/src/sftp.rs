use crate::ssh::{connect_and_auth, SshHandle};
use crate::{next_id, AppState, Connection, RemoteFile};
use russh_sftp::client::SftpSession;
use std::sync::Arc;
use tauri::State;
use tokio::io::AsyncWriteExt;

pub struct SftpConn {
    pub sftp: Arc<SftpSession>,
    // Keep the underlying SSH connection (and any jump hop) alive for the
    // session's lifetime.
    _handle: Arc<SshHandle>,
}

async fn sftp_of(state: &AppState, id: &str) -> Result<Arc<SftpSession>, String> {
    state
        .sftp
        .lock()
        .await
        .get(id)
        .map(|c| c.sftp.clone())
        .ok_or_else(|| "SFTP session not found".into())
}

#[tauri::command]
pub async fn sftp_connect(conn: Connection, state: State<'_, AppState>) -> Result<String, String> {
    let handle = connect_and_auth(&conn).await?;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| e.to_string())?;

    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("SFTP init failed: {e}"))?;

    let id = next_id("sftp");
    state.sftp.lock().await.insert(
        id.clone(),
        SftpConn {
            sftp: Arc::new(sftp),
            _handle: Arc::new(handle),
        },
    );
    Ok(id)
}

#[tauri::command]
pub async fn sftp_list(
    id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<RemoteFile>, String> {
    let sftp = sftp_of(&state, &id).await?;
    let base = sftp
        .canonicalize(if path.is_empty() { ".".into() } else { path })
        .await
        .map_err(|e| e.to_string())?;

    let dir = sftp.read_dir(&base).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = entry.metadata();
        let full = if base.ends_with('/') {
            format!("{base}{name}")
        } else {
            format!("{base}/{name}")
        };
        out.push(RemoteFile {
            name,
            path: full,
            is_dir: meta.is_dir(),
            size: meta.size.unwrap_or(0),
            modified: meta.mtime.map(|m| m as i64),
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn sftp_download(
    id: String,
    remote: String,
    local: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sftp = sftp_of(&state, &id).await?;
    let mut rf = sftp.open(&remote).await.map_err(|e| e.to_string())?;
    let mut lf = tokio::fs::File::create(&local)
        .await
        .map_err(|e| e.to_string())?;
    tokio::io::copy(&mut rf, &mut lf)
        .await
        .map_err(|e| e.to_string())?;
    lf.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_upload(
    id: String,
    local: String,
    remote: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sftp = sftp_of(&state, &id).await?;
    let mut lf = tokio::fs::File::open(&local)
        .await
        .map_err(|e| e.to_string())?;
    let mut rf = sftp.create(&remote).await.map_err(|e| e.to_string())?;
    tokio::io::copy(&mut lf, &mut rf)
        .await
        .map_err(|e| e.to_string())?;
    rf.shutdown().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_disconnect(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.sftp.lock().await.remove(&id);
    Ok(())
}
