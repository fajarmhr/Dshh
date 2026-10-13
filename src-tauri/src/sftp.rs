use crate::fileops::{chmod_targets, join, mode_for, OpReport, Target, Tree, TreeEntry};
use crate::progress::{Progress, Reporter};
use crate::ssh::{connect_and_auth, SshHandle};
use crate::{next_id, AppState, Connection, Listing, RemoteFile};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileAttributes;
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
            mode: meta.permissions.map(|p| p & 0o7777),
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

// ---- Bulk operations (multi-select) ----

/// Walk the selection depth-first. Directory entries carry lstat attributes
/// (that is what OpenSSH's READDIR sends), so a symlinked folder shows up as
/// a link and is never descended into — deleting a selection can't wander
/// off through a link into somewhere else.
async fn walk(sftp: &SftpSession, targets: &[Target]) -> Result<Tree, String> {
    let mut tree = Tree::from_targets(targets);
    let mut stack: Vec<String> = targets
        .iter()
        .filter(|t| t.is_dir)
        .map(|t| t.path.clone())
        .collect();
    while let Some(dir) = stack.pop() {
        let Ok(entries) = sftp.read_dir(&dir).await else {
            tree.unreadable.push(dir);
            continue;
        };
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = entry.metadata();
            let path = join(&dir, &name);
            let is_dir = meta.is_dir();
            if is_dir {
                stack.push(path.clone());
            }
            tree.push(TreeEntry {
                path,
                is_dir,
                size: if is_dir { 0 } else { meta.size.unwrap_or(0) },
                link: meta.file_type().is_symlink(),
            })?;
        }
    }
    Ok(tree)
}

/// Everything under the selection — what a folder download copies and what
/// the delete warning counts.
#[tauri::command]
pub async fn sftp_tree(
    id: String,
    targets: Vec<Target>,
    state: State<'_, AppState>,
) -> Result<Tree, String> {
    let sftp = sftp_of(&state, &id).await?;
    walk(&sftp, &targets).await
}

/// Delete the selection, folders with everything inside. Carries on past
/// failures and reports them, rather than stopping half-way with no account
/// of what is already gone.
#[tauri::command]
pub async fn sftp_delete(
    id: String,
    targets: Vec<Target>,
    state: State<'_, AppState>,
) -> Result<OpReport, String> {
    let sftp = sftp_of(&state, &id).await?;
    delete_tree(&sftp, &targets).await
}

async fn delete_tree(sftp: &SftpSession, targets: &[Target]) -> Result<OpReport, String> {
    let tree = walk(sftp, targets).await?;
    let mut report = OpReport::default();
    for e in tree.delete_order() {
        let result = if e.is_dir {
            sftp.remove_dir(&e.path).await
        } else {
            sftp.remove_file(&e.path).await
        };
        match result {
            Ok(()) => report.ok(e.is_dir),
            Err(err) => report.fail(&e.path, err),
        }
    }
    Ok(report)
}

#[tauri::command]
pub async fn sftp_chmod(
    id: String,
    targets: Vec<Target>,
    mode: u32,
    recursive: bool,
    dir_exec: bool,
    state: State<'_, AppState>,
) -> Result<OpReport, String> {
    let sftp = sftp_of(&state, &id).await?;
    chmod_tree(&sftp, &targets, mode, recursive, dir_exec).await
}

async fn chmod_tree(
    sftp: &SftpSession,
    targets: &[Target],
    mode: u32,
    recursive: bool,
    dir_exec: bool,
) -> Result<OpReport, String> {
    let tree = if recursive {
        walk(sftp, targets).await?
    } else {
        Tree::from_targets(targets)
    };
    let mut report = OpReport::default();
    for e in chmod_targets(&tree, recursive, targets.len()) {
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(mode_for(mode & 0o7777, e.is_dir, dir_exec));
        match sftp.set_metadata(&e.path, attrs).await {
            Ok(()) => report.ok(e.is_dir),
            Err(err) => report.fail(&e.path, err),
        }
    }
    Ok(report)
}

/// A user or group given by name or number, resolved against the server's
/// own `/etc/passwd` / `/etc/group` — SFTP v3 only carries numeric ids.
fn resolve_id(given: &str, known: &HashMap<u32, String>, what: &str) -> Result<u32, String> {
    let given = given.trim();
    if let Ok(id) = given.parse::<u32>() {
        return Ok(id);
    }
    known
        .iter()
        .find(|(_, name)| name.as_str() == given)
        .map(|(id, _)| *id)
        .ok_or_else(|| format!("The server has no {what} named {given:?} — use its numeric id"))
}

#[tauri::command]
pub async fn sftp_chown(
    id: String,
    targets: Vec<Target>,
    owner: Option<String>,
    group: Option<String>,
    recursive: bool,
    state: State<'_, AppState>,
) -> Result<OpReport, String> {
    let (sftp, names_cell) = conn_of(&state, &id).await?;
    let names = names_of(&sftp, &names_cell).await;
    let given = |s: Option<String>| s.filter(|v| !v.trim().is_empty());
    let uid = given(owner)
        .map(|o| resolve_id(&o, &names.users, "user"))
        .transpose()?;
    let gid = given(group)
        .map(|g| resolve_id(&g, &names.groups, "group"))
        .transpose()?;
    if uid.is_none() && gid.is_none() {
        return Err("Give an owner, a group, or both".into());
    }
    chown_tree(&sftp, &targets, uid, gid, recursive).await
}

async fn chown_tree(
    sftp: &SftpSession,
    targets: &[Target],
    uid: Option<u32>,
    gid: Option<u32>,
    recursive: bool,
) -> Result<OpReport, String> {
    let tree = if recursive {
        walk(sftp, targets).await?
    } else {
        Tree::from_targets(targets)
    };
    let mut report = OpReport::default();
    for e in chmod_targets(&tree, recursive, targets.len()) {
        // SFTP sets uid and gid as a pair, so changing only one means reading
        // the other first — sending it blank would reset it to 0 (root).
        let pair = match (uid, gid) {
            (Some(u), Some(g)) => Ok((u, g)),
            _ => match sftp.metadata(&e.path).await {
                Ok(m) => match (uid.or(m.uid), gid.or(m.gid)) {
                    (Some(u), Some(g)) => Ok((u, g)),
                    _ => Err("the server didn't report the current owner".to_string()),
                },
                Err(err) => Err(err.to_string()),
            },
        };
        let (u, g) = match pair {
            Ok(p) => p,
            Err(err) => {
                report.fail(&e.path, err);
                continue;
            }
        };
        let mut attrs = FileAttributes::empty();
        attrs.uid = Some(u);
        attrs.gid = Some(g);
        match sftp.set_metadata(&e.path, attrs).await {
            Ok(()) => report.ok(e.is_dir),
            Err(err) => report.fail(&e.path, err),
        }
    }
    Ok(report)
}

/// User and group names known on the server, offered by the owner dialog.
#[derive(serde::Serialize)]
pub struct Principals {
    users: Vec<String>,
    groups: Vec<String>,
}

#[tauri::command]
pub async fn sftp_principals(
    id: String,
    state: State<'_, AppState>,
) -> Result<Principals, String> {
    let (sftp, names_cell) = conn_of(&state, &id).await?;
    let names = names_of(&sftp, &names_cell).await;
    let sorted = |m: &HashMap<u32, String>| {
        let mut v: Vec<String> = m.values().cloned().collect();
        v.sort();
        v.dedup();
        v
    };
    Ok(Principals {
        users: sorted(&names.users),
        groups: sorted(&names.groups),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn put(sftp: &SftpSession, path: &str, body: &[u8]) {
        let mut f = sftp.create(path).await.unwrap();
        f.write_all(body).await.unwrap();
        f.shutdown().await.unwrap();
    }

    async fn mode_of(sftp: &SftpSession, path: &str) -> u32 {
        sftp.symlink_metadata(path).await.unwrap().permissions.unwrap() & 0o7777
    }

    /// Live: needs the sshd container (127.0.0.1:2222, test/test123, with
    /// openssh-sftp-server). Builds a tree holding a symlink to a folder
    /// outside it, then walks, chmods, chowns and deletes it — the link's
    /// target must come through untouched.
    #[tokio::test]
    #[ignore]
    async fn sftp_live_bulk_operations() {
        let conn = Connection {
            id: "live".into(),
            name: "live".into(),
            protocol: "ssh".into(),
            host: Some("127.0.0.1".into()),
            port: Some(2222),
            username: Some("test".into()),
            auth_method: Some("password".into()),
            password: Some("test123".into()),
            ..Default::default()
        };
        let handle = connect_and_auth(&conn).await.expect("ssh");
        let ch = handle.channel_open_session().await.unwrap();
        ch.request_subsystem(true, "sftp").await.unwrap();
        let sftp = SftpSession::new(ch.into_stream()).await.expect("sftp");

        let pid = std::process::id();
        let base = format!("/home/test/dshh-bulk-{pid}");
        let outside = format!("/home/test/dshh-outside-{pid}");
        let link_path = format!("{base}/link");
        for dir in [&base, &format!("{base}/sub"), &outside] {
            sftp.create_dir(dir.as_str()).await.unwrap();
        }
        put(&sftp, &format!("{base}/a.txt"), b"a").await;
        put(&sftp, &format!("{base}/sub/b.txt"), b"b").await;
        put(&sftp, &format!("{outside}/keep.txt"), b"keep").await;
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(0o755);
        sftp.set_metadata(outside.as_str(), attrs).await.unwrap();
        // OpenSSH takes SYMLINK's arguments target-first (a long-standing
        // quirk), so this makes `link` point at `outside`.
        sftp.symlink(outside.as_str(), link_path.as_str()).await.unwrap();
        assert!(
            sftp.symlink_metadata(link_path.as_str()).await.unwrap().file_type().is_symlink(),
            "test setup: link was not created where expected"
        );

        let targets = vec![Target { path: base.clone(), is_dir: true, size: 0 }];
        let tree = walk(&sftp, &targets).await.unwrap();
        assert_eq!(tree.entries.len(), 5, "{:?}", tree.entries);
        let link = tree.entries.iter().find(|e| e.path == link_path).unwrap();
        assert!(link.link && !link.is_dir, "a symlinked folder must not be walked into");

        let r = chmod_tree(&sftp, &targets, 0o640, true, true).await.unwrap();
        assert_eq!(r.failed, 0, "{:?}", r.errors);
        assert_eq!(mode_of(&sftp, &base).await, 0o750);
        assert_eq!(mode_of(&sftp, &format!("{base}/sub")).await, 0o750);
        assert_eq!(mode_of(&sftp, &format!("{base}/a.txt")).await, 0o640);
        assert_eq!(mode_of(&sftp, &outside).await, 0o755, "chmod -R must skip links");

        // Owner change to ourselves: allowed without root, and exercises
        // the uid-only path that has to read the gid back first.
        let me = sftp.metadata(base.as_str()).await.unwrap();
        let r = chown_tree(&sftp, &targets, me.uid, None, true).await.unwrap();
        assert_eq!(r.failed, 0, "{:?}", r.errors);
        assert_eq!(sftp.metadata(base.as_str()).await.unwrap().gid, me.gid);

        let r = delete_tree(&sftp, &targets).await.unwrap();
        assert_eq!(r.failed, 0, "{:?}", r.errors);
        assert_eq!((r.files, r.dirs), (3, 2));
        assert!(!sftp.try_exists(base.as_str()).await.unwrap());
        assert!(sftp.try_exists(format!("{outside}/keep.txt")).await.unwrap());

        let cleanup = vec![Target { path: outside.clone(), is_dir: true, size: 0 }];
        delete_tree(&sftp, &cleanup).await.unwrap();
    }
}
