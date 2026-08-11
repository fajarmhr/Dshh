use crate::progress::{Progress, Reporter};
use crate::{next_id, AppState, Connection, Listing, RemoteFile};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use suppaftp::list::File as FtpFile;
use suppaftp::FtpStream;
use tauri::ipc::Channel;
use tauri::State;

/// Bytes moved per read/write while streaming a transfer, so progress ticks
/// arrive at a sane rate on both fast and slow links.
const CHUNK: usize = 32 * 1024;

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

/// Owner and group out of a POSIX `LIST` line — the two fields between the link
/// count and the size. suppaftp's parser drops them unless they are numeric,
/// but `root`/`www-data` is exactly what's worth showing, so read them off the
/// raw line instead. DOS and MLSD listings carry no owner: those give `None`.
fn posix_owner(line: &str) -> (Option<String>, Option<String>) {
    let fields: Vec<&str> = line.split_whitespace().collect();
    // perms, links, owner, group, size, month, day, time, name
    if fields.len() < 8 {
        return (None, None);
    }
    let perms = fields[0].as_bytes();
    if perms.len() < 10 || !matches!(perms[0], b'-' | b'd' | b'l') {
        return (None, None);
    }
    let numeric = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if numeric(fields[4]) {
        (Some(fields[2].into()), Some(fields[3].into()))
    } else if numeric(fields[3]) {
        // Servers that print an owner but no group (some embedded daemons).
        (Some(fields[2].into()), None)
    } else {
        (None, None)
    }
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
) -> Result<Listing, String> {
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
            let (owner, group) = posix_owner(&line);
            out.push(RemoteFile {
                name,
                path: full,
                is_dir: f.is_directory(),
                size: f.size() as u64,
                modified,
                owner,
                group,
            });
        }
    }
    Ok(Listing {
        path: dir,
        files: out,
    })
}

#[tauri::command]
pub async fn ftp_download(
    id: String,
    remote: String,
    local: String,
    on_progress: Channel<Progress>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let arc = get_stream(&state, &id).await?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut ftp = arc.lock().map_err(|e| e.to_string())?;
        // SIZE is optional and some servers refuse it outside binary mode; the
        // transfer still runs, the bar just can't show a percentage.
        let total = ftp.size(&remote).map(|s| s as u64).unwrap_or(0);
        let mut out = std::fs::File::create(&local).map_err(|e| e.to_string())?;
        let mut stream = ftp.retr_as_stream(&remote).map_err(|e| e.to_string())?;
        let mut reporter = Reporter::new(on_progress, total);
        let mut buf = vec![0u8; CHUNK];
        loop {
            let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            reporter.add(n as u64);
        }
        // Closes the data connection and reads the server's 226; skipping it
        // leaves the control channel out of step for the next command.
        ftp.finalize_retr_stream(stream).map_err(|e| e.to_string())?;
        reporter.finish();
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
    on_progress: Channel<Progress>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let arc = get_stream(&state, &id).await?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut src = std::fs::File::open(&local).map_err(|e| e.to_string())?;
        let total = src.metadata().map(|m| m.len()).unwrap_or(0);
        let mut ftp = arc.lock().map_err(|e| e.to_string())?;
        let mut stream = ftp.put_with_stream(&remote).map_err(|e| e.to_string())?;
        let mut reporter = Reporter::new(on_progress, total);
        let mut buf = vec![0u8; CHUNK];
        loop {
            let n = src.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            stream.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            reporter.add(n as u64);
        }
        ftp.finalize_put_stream(stream).map_err(|e| e.to_string())?;
        reporter.finish();
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
