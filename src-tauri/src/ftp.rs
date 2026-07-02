use crate::{next_id, AppState, Connection, RemoteFile};
use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use suppaftp::list::File as FtpFile;
use suppaftp::FtpStream;
use tauri::State;

pub struct FtpConn {
    pub stream: Arc<Mutex<FtpStream>>,
}

fn conn_of(state: &AppState, id: &str, map: &std::collections::HashMap<String, FtpConn>) -> Option<Arc<Mutex<FtpStream>>> {
    let _ = state;
    map.get(id).map(|c| c.stream.clone())
}

async fn get_stream(state: &AppState, id: &str) -> Result<Arc<Mutex<FtpStream>>, String> {
    let map = state.ftp.lock().await;
    conn_of(state, id, &map).ok_or_else(|| "FTP session not found".into())
}

#[tauri::command]
pub async fn ftp_connect(conn: Connection, state: State<'_, AppState>) -> Result<String, String> {
    if conn.ftp_secure.unwrap_or(false) {
        return Err("FTPS (TLS) is not wired up yet — use plain FTP for now".into());
    }
    let host = conn.host.clone().ok_or("Missing host")?;
    let port = conn.port.unwrap_or(21);
    let user = conn.username.clone().unwrap_or_else(|| "anonymous".into());
    let pass = conn.password.clone().unwrap_or_default();
    let addr = format!("{host}:{port}");

    let stream = tokio::task::spawn_blocking(move || -> Result<FtpStream, String> {
        let mut ftp = FtpStream::connect(&addr).map_err(|e| e.to_string())?;
        ftp.login(&user, &pass).map_err(|e| e.to_string())?;
        Ok(ftp)
    })
    .await
    .map_err(|e| e.to_string())??;

    let id = next_id("ftp");
    state.ftp.lock().await.insert(
        id.clone(),
        FtpConn {
            stream: Arc::new(Mutex::new(stream)),
        },
    );
    Ok(id)
}

#[tauri::command]
pub async fn ftp_list(
    id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<RemoteFile>, String> {
    let arc = get_stream(&state, &id).await?;
    let dir = if path.is_empty() { "/".to_string() } else { path };
    let dir2 = dir.clone();

    let lines = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let mut ftp = arc.lock().map_err(|e| e.to_string())?;
        ftp.list(Some(&dir2)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    let mut out = Vec::new();
    for line in lines {
        #[allow(deprecated)]
        let parsed = FtpFile::from_posix_line(&line);
        if let Ok(f) = parsed {
            let name = f.name().to_string();
            if name == "." || name == ".." {
                continue;
            }
            let full = if dir.ends_with('/') {
                format!("{dir}{name}")
            } else {
                format!("{dir}/{name}")
            };
            let modified = f
                .modified()
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|d| d.as_secs() as i64);
            out.push(RemoteFile {
                name,
                path: full,
                is_dir: f.is_directory(),
                size: f.size() as u64,
                modified,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn ftp_download(
    id: String,
    remote: String,
    local: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let arc = get_stream(&state, &id).await?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut ftp = arc.lock().map_err(|e| e.to_string())?;
        let buf = ftp.retr_as_buffer(&remote).map_err(|e| e.to_string())?;
        std::fs::write(&local, buf.into_inner()).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ftp_upload(
    id: String,
    local: String,
    remote: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let arc = get_stream(&state, &id).await?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let data = std::fs::read(&local).map_err(|e| e.to_string())?;
        let mut ftp = arc.lock().map_err(|e| e.to_string())?;
        let mut cursor = Cursor::new(data);
        ftp.put_file(&remote, &mut cursor).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ftp_disconnect(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(c) = state.ftp.lock().await.remove(&id) {
        let arc = c.stream;
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(mut ftp) = arc.lock() {
                let _ = ftp.quit();
            }
        })
        .await;
    }
    Ok(())
}
