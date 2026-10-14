use crate::fileops::{
    chmod_targets, join, mode_for, parse_perm_string, OpReport, Target, Tree, TreeEntry,
};
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

    let files = parse_listing(&dir, &lines).into_iter().map(|(f, _)| f).collect();
    Ok(Listing { path: dir, files })
}

/// Parse `LIST` output for `dir`. Each entry comes with whether it is a
/// symlink, which walks need and the listing itself doesn't show.
fn parse_listing(dir: &str, lines: &[String]) -> Vec<(RemoteFile, bool)> {
    let mut out = Vec::new();
    for line in lines {
        #[allow(deprecated)]
        let parsed = FtpFile::from_posix_line(line);
        if let Ok(f) = parsed {
            let name = f.name().to_string();
            if name == "." || name == ".." {
                continue;
            }
            let modified = f
                .modified()
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|d| d.as_secs() as i64);
            let (owner, group) = posix_owner(line);
            let perms = line.split_whitespace().next().unwrap_or("");
            out.push((
                RemoteFile {
                    path: join(dir, &name),
                    name,
                    is_dir: f.is_directory(),
                    size: f.size() as u64,
                    modified,
                    owner,
                    group,
                    mode: parse_perm_string(perms),
                },
                perms.starts_with('l'),
            ));
        }
    }
    out
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

// ---- Bulk operations (multi-select) ----

/// Walk the selection over one control connection. Symlinks (an `l` in the
/// listing) are recorded but never descended into.
pub(crate) fn walk(ftp: &mut FtpStream, targets: &[Target]) -> Result<Tree, String> {
    let mut tree = Tree::from_targets(targets);
    let mut stack: Vec<String> = targets
        .iter()
        .filter(|t| t.is_dir)
        .map(|t| t.path.clone())
        .collect();
    while let Some(dir) = stack.pop() {
        let Ok(lines) = ftp.list(Some(&dir)) else {
            tree.unreadable.push(dir);
            continue;
        };
        for (f, link) in parse_listing(&dir, &lines) {
            let is_dir = f.is_dir && !link;
            if is_dir {
                stack.push(f.path.clone());
            }
            tree.push(TreeEntry {
                path: f.path,
                is_dir,
                size: if is_dir { 0 } else { f.size },
                link,
            })?;
        }
    }
    Ok(tree)
}

/// Run `op` against the session's control connection on a blocking thread.
pub(crate) async fn with_ftp<T: Send + 'static>(
    state: &AppState,
    id: &str,
    op: impl FnOnce(&mut FtpStream) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let arc = get_stream(state, id).await?;
    tokio::task::spawn_blocking(move || {
        let mut ftp = arc.lock().map_err(|e| e.to_string())?;
        op(&mut ftp)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ftp_tree(
    id: String,
    targets: Vec<Target>,
    state: State<'_, AppState>,
) -> Result<Tree, String> {
    with_ftp(&state, &id, move |ftp| walk(ftp, &targets)).await
}

/// Delete the selection, folders with everything inside (FTP's RMD only
/// removes empty ones, so the contents go first). Failures are reported, not
/// fatal.
#[tauri::command]
pub async fn ftp_delete(
    id: String,
    targets: Vec<Target>,
    state: State<'_, AppState>,
) -> Result<OpReport, String> {
    with_ftp(&state, &id, move |ftp| delete_tree(ftp, &targets)).await
}

fn delete_tree(ftp: &mut FtpStream, targets: &[Target]) -> Result<OpReport, String> {
    let tree = walk(ftp, targets)?;
    let mut report = OpReport::default();
    for e in tree.delete_order() {
        let result = if e.is_dir { ftp.rmdir(&e.path) } else { ftp.rm(&e.path) };
        match result {
            Ok(()) => report.ok(e.is_dir),
            Err(err) => report.fail(&e.path, err),
        }
    }
    Ok(report)
}

/// Permissions over FTP go through `SITE CHMOD`, which Unix servers (vsftpd,
/// ProFTPD, Pure-FTPd) support. FTP has no way to change ownership.
#[tauri::command]
pub async fn ftp_chmod(
    id: String,
    targets: Vec<Target>,
    mode: u32,
    recursive: bool,
    dir_exec: bool,
    state: State<'_, AppState>,
) -> Result<OpReport, String> {
    with_ftp(&state, &id, move |ftp| chmod_tree(ftp, &targets, mode, recursive, dir_exec)).await
}

fn chmod_tree(
    ftp: &mut FtpStream,
    targets: &[Target],
    mode: u32,
    recursive: bool,
    dir_exec: bool,
) -> Result<OpReport, String> {
    let tree = if recursive { walk(ftp, targets)? } else { Tree::from_targets(targets) };
    let mut report = OpReport::default();
    for e in chmod_targets(&tree, recursive, targets.len()) {
        let m = mode_for(mode & 0o7777, e.is_dir, dir_exec);
        match ftp.site(format!("CHMOD {m:o} {}", e.path)) {
            Ok(_) => report.ok(e.is_dir),
            Err(err) => report.fail(&e.path, err),
        }
    }
    Ok(report)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn modes(ftp: &mut FtpStream, dir: &str) -> Vec<(String, Option<u32>)> {
        let lines = ftp.list(Some(dir)).unwrap();
        parse_listing(dir, &lines).into_iter().map(|(f, _)| (f.name, f.mode)).collect()
    }

    /// Live: needs a writable FTP server on 127.0.0.1:2121 (pyftpdlib,
    /// test/test123). Walks, chmods via SITE CHMOD, and deletes a tree.
    #[test]
    #[ignore]
    fn ftp_live_bulk_operations() {
        let mut ftp = FtpStream::connect("127.0.0.1:2121").expect("connect");
        ftp.login("test", "test123").expect("login");
        let base = format!("/dshh-bulk-{}", std::process::id());
        ftp.mkdir(&base).unwrap();
        ftp.mkdir(format!("{base}/sub")).unwrap();
        ftp.put_file(format!("{base}/a.txt"), &mut std::io::Cursor::new(b"a")).unwrap();
        ftp.put_file(format!("{base}/sub/b.txt"), &mut std::io::Cursor::new(b"b")).unwrap();

        let targets = vec![Target { path: base.clone(), is_dir: true, size: 0 }];
        let tree = walk(&mut ftp, &targets).unwrap();
        assert_eq!(tree.entries.len(), 4, "{:?}", tree.entries);

        let r = chmod_tree(&mut ftp, &targets, 0o640, true, true).unwrap();
        assert_eq!(r.failed, 0, "{:?}", r.errors);
        let inside = modes(&mut ftp, &base);
        assert!(inside.contains(&("a.txt".into(), Some(0o640))), "{inside:?}");
        assert!(inside.contains(&("sub".into(), Some(0o750))), "{inside:?}");

        let r = delete_tree(&mut ftp, &targets).unwrap();
        assert_eq!(r.failed, 0, "{:?}", r.errors);
        assert_eq!((r.files, r.dirs), (2, 2));
        let root = ftp.list(Some("/")).unwrap().join("\n");
        assert!(!root.contains(base.trim_start_matches('/')), "{root}");
    }
}
