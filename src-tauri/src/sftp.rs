use crate::progress::{Progress, Reporter};
use crate::ssh::{connect_and_auth, SshHandle};
use crate::{next_id, AppState, Connection, Listing, RemoteFile};
use russh_sftp::client::SftpSession;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

/// Read/written per round trip. SFTP is request/response, so a bigger buffer
/// means fewer round trips; 32 KiB is what OpenSSH's own client settles on.
const CHUNK: usize = 32 * 1024;

pub struct SftpConn {
    pub sftp: Arc<SftpSession>,
    /// uid/gid → name, read from the server once and reused for every listing.
    names: Arc<Mutex<Option<Arc<Names>>>>,
    // Keep the underlying SSH connection (and any jump hop) alive for the
    // session's lifetime.
    _handle: Arc<SshHandle>,
}

/// Owner names for the numeric ids SFTP puts on the wire. SFTP v3 — what
/// virtually every server speaks — carries uid/gid only, so `root` and `www-data`
/// have to be looked up on the host itself.
#[derive(Default)]
struct Names {
    users: HashMap<u32, String>,
    groups: HashMap<u32, String>,
}

impl Names {
    fn user(&self, uid: u32) -> String {
        self.users
            .get(&uid)
            .cloned()
            .unwrap_or_else(|| uid.to_string())
    }

    fn group(&self, gid: u32) -> String {
        self.groups
            .get(&gid)
            .cloned()
            .unwrap_or_else(|| gid.to_string())
    }
}

/// Parse `name:x:id:…` lines. `/etc/passwd` and `/etc/group` both put the id in
/// the third colon-separated field, so one parser covers both. An unreadable
/// file — a Windows SFTP server, a hardened host, a chrooted account — yields an
/// empty map, and the listing falls back to raw numbers.
async fn read_id_map(sftp: &SftpSession, path: &str) -> HashMap<u32, String> {
    let mut out = HashMap::new();
    let Ok(bytes) = sftp.read(path).await else {
        return out;
    };
    for line in String::from_utf8_lossy(&bytes).lines() {
        let mut fields = line.split(':');
        let (Some(name), Some(_), Some(id)) = (fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        if let Ok(id) = id.parse::<u32>() {
            // Aliased ids exist (root/toor); the first name wins, as `ls` does.
            out.entry(id).or_insert_with(|| name.to_string());
        }
    }
    out
}

async fn names_of(sftp: &SftpSession, cell: &Mutex<Option<Arc<Names>>>) -> Arc<Names> {
    let mut cached = cell.lock().await;
    if let Some(names) = cached.as_ref() {
        return names.clone();
    }
    let names = Arc::new(Names {
        users: read_id_map(sftp, "/etc/passwd").await,
        groups: read_id_map(sftp, "/etc/group").await,
    });
    *cached = Some(names.clone());
    names
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

/// The session plus its name cache, for the listing path.
async fn conn_of(
    state: &AppState,
    id: &str,
) -> Result<(Arc<SftpSession>, Arc<Mutex<Option<Arc<Names>>>>), String> {
    state
        .sftp
        .lock()
        .await
        .get(id)
        .map(|c| (c.sftp.clone(), c.names.clone()))
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
            names: Arc::new(Mutex::new(None)),
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
) -> Result<Listing, String> {
    let (sftp, names_cell) = conn_of(&state, &id).await?;
    // Resolve "." (and any relative path) to an absolute one; the frontend
    // shows this in the address bar rather than what it asked for.
    let base = sftp
        .canonicalize(if path.is_empty() { ".".into() } else { path })
        .await
        .map_err(|e| e.to_string())?;

    let dir = sftp.read_dir(&base).await.map_err(|e| e.to_string())?;
    let names = names_of(&sftp, &names_cell).await;
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
            // Servers speaking SFTP v4+ send names outright; older ones only
            // send ids, which the /etc/passwd map turns back into names.
            owner: meta.user.clone().or_else(|| meta.uid.map(|u| names.user(u))),
            group: meta.group.clone().or_else(|| meta.gid.map(|g| names.group(g))),
        });
    }
    Ok(Listing {
        path: base,
        files: out,
    })
}

#[tauri::command]
pub async fn sftp_download(
    id: String,
    remote: String,
    local: String,
    on_progress: Channel<Progress>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sftp = sftp_of(&state, &id).await?;
    // Best effort: a server that won't stat the file still transfers it, the
    // bar just runs indeterminate.
    let total = sftp
        .metadata(&remote)
        .await
        .ok()
        .and_then(|m| m.size)
        .unwrap_or(0);
    let mut rf = sftp.open(&remote).await.map_err(|e| e.to_string())?;
    let mut lf = tokio::fs::File::create(&local)
        .await
        .map_err(|e| e.to_string())?;
    let mut reporter = Reporter::new(on_progress, total);
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = rf.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        lf.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        reporter.add(n as u64);
    }
    lf.flush().await.map_err(|e| e.to_string())?;
    reporter.finish();
    Ok(())
}

#[tauri::command]
pub async fn sftp_upload(
    id: String,
    local: String,
    remote: String,
    on_progress: Channel<Progress>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sftp = sftp_of(&state, &id).await?;
    let total = tokio::fs::metadata(&local).await.map(|m| m.len()).unwrap_or(0);
    let mut lf = tokio::fs::File::open(&local)
        .await
        .map_err(|e| e.to_string())?;
    let mut rf = sftp.create(&remote).await.map_err(|e| e.to_string())?;
    let mut reporter = Reporter::new(on_progress, total);
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = lf.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        rf.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        reporter.add(n as u64);
    }
    rf.shutdown().await.map_err(|e| e.to_string())?;
    reporter.finish();
    Ok(())
}

#[tauri::command]
pub async fn sftp_disconnect(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.sftp.lock().await.remove(&id);
    Ok(())
}
