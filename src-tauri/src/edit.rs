use crate::ssh::connect_and_auth;
use crate::{next_id, AppState, Connection};
use russh_sftp::client::SftpSession;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::AsyncWriteExt;

/// Remote file editing: download the file to a temp folder, open it with the
/// system's default editor, then watch the local copy and re-upload it to the
/// server every time it is saved. Each edit owns its own SFTP connection so
/// it keeps working even after the file browser that spawned it is closed.

pub struct EditSession {
    pub stop: Arc<AtomicBool>,
    pub local: std::path::PathBuf,
}

fn open_in_default_app(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    std::process::Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(path)
        .spawn()
        .map_err(|e| format!("Cannot open editor: {e}"))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map_err(|e| format!("Cannot open editor: {e}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map_err(|e| format!("Cannot open editor: {e}"))?;
    Ok(())
}

fn mtime_of(path: &std::path::Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

async fn upload(sftp: &SftpSession, local: &std::path::Path, remote: &str) -> Result<(), String> {
    let mut lf = tokio::fs::File::open(local).await.map_err(|e| e.to_string())?;
    let mut rf = sftp.create(remote).await.map_err(|e| e.to_string())?;
    tokio::io::copy(&mut lf, &mut rf)
        .await
        .map_err(|e| e.to_string())?;
    rf.shutdown().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn edit_start(
    conn: Connection,
    remote: String,
    on_event: Channel<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Dedicated SFTP connection for this edit's lifetime.
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

    let id = next_id("edit");
    let name = remote.rsplit('/').next().unwrap_or("file").to_string();
    let dir = std::env::temp_dir().join("dshh-edit").join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create temp folder: {e}"))?;
    let local = dir.join(&name);

    // Initial download.
    {
        let mut rf = sftp
            .open(&remote)
            .await
            .map_err(|e| format!("Cannot open remote file: {e}"))?;
        let mut lf = tokio::fs::File::create(&local)
            .await
            .map_err(|e| e.to_string())?;
        tokio::io::copy(&mut rf, &mut lf)
            .await
            .map_err(|e| e.to_string())?;
        lf.flush().await.map_err(|e| e.to_string())?;
    }

    open_in_default_app(&local)?;

    let stop = Arc::new(AtomicBool::new(false));
    let stop_task = stop.clone();
    let local_task = local.clone();
    tokio::spawn(async move {
        let _keepalive = handle;
        let mut last = mtime_of(&local_task);
        loop {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            if stop_task.load(Ordering::Relaxed) {
                break;
            }
            let now = mtime_of(&local_task);
            if now.is_some() && now != last {
                // Give the editor a moment to finish writing.
                tokio::time::sleep(Duration::from_millis(300)).await;
                last = mtime_of(&local_task);
                match upload(&sftp, &local_task, &remote).await {
                    Ok(()) => {
                        let _ = on_event.send(format!("uploaded {name}"));
                    }
                    Err(e) => {
                        let _ = on_event.send(format!("error: upload failed: {e}"));
                    }
                }
            }
        }
    });

    state.edits.lock().await.insert(
        id.clone(),
        EditSession {
            stop,
            local,
        },
    );
    Ok(id)
}

#[tauri::command]
pub async fn edit_stop(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(e) = state.edits.lock().await.remove(&id) {
        e.stop.store(true, Ordering::Relaxed);
        // Best-effort cleanup; the editor may still hold the file open.
        let _ = std::fs::remove_file(&e.local);
        if let Some(dir) = e.local.parent() {
            let _ = std::fs::remove_dir(dir);
        }
    }
    Ok(())
}
