use crate::RemoteFile;

/// Read-only local filesystem listing for the dual-pane drag & drop view.
/// Transfers themselves reuse the existing SFTP/FTP upload/download commands.

#[tauri::command]
pub fn local_fs_home() -> String {
    #[cfg(windows)]
    return std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
    #[cfg(not(windows))]
    return std::env::var("HOME").unwrap_or_else(|_| "/".into());
}

/// List a local directory. On Windows an empty `path` lists the drive roots
/// (`C:\`, `D:\`, …) so the pane can navigate above a drive.
#[tauri::command]
pub fn local_fs_list(path: String) -> Result<Vec<RemoteFile>, String> {
    if path.is_empty() {
        #[cfg(windows)]
        {
            let mut out = Vec::new();
            for letter in b'A'..=b'Z' {
                let root = format!("{}:\\", letter as char);
                if std::path::Path::new(&root).exists() {
                    out.push(RemoteFile {
                        name: root.clone(),
                        path: root,
                        is_dir: true,
                        size: 0,
                        modified: None,
                    });
                }
            }
            return Ok(out);
        }
        #[cfg(not(windows))]
        return local_fs_list("/".into());
    }

    let rd = std::fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))?;
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        out.push(RemoteFile {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified,
        });
    }
    Ok(out)
}
