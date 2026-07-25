//! Portable-mode data folder.
//!
//! Dshh ships as a folder — `dshh.exe` beside a `data/` directory — so an
//! entire install can be zipped, copied to a USB stick and carried between
//! machines with its settings intact.
//!
//! Settings and saved connections live in `localStorage`, which WebView2 keeps
//! inside its *user data folder*. That folder defaults to somewhere under
//! `%LOCALAPPDATA%`, which is exactly what makes an ordinary Tauri app
//! non-portable. Pointing `WEBVIEW2_USER_DATA_FOLDER` at `data/webview`
//! **before the webview is created** is what moves it next to the exe.
//!
//! If that location can't be written — the folder was dropped in
//! `Program Files`, or launched from read-only media — the variable is left
//! alone and WebView2 falls back to its per-user default. Portability is a
//! convenience; refusing to start is not.

use std::path::{Path, PathBuf};

/// Directory holding the running executable.
fn exe_dir() -> Option<PathBuf> {
    Some(std::env::current_exe().ok()?.parent()?.to_path_buf())
}

/// Probe a directory by writing and removing a marker file. Checking
/// permissions directly is unreliable on Windows (ACLs, virtualization and
/// read-only media all fail differently), so we just try it.
fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(".dshh-write-probe");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Resolve the portable data root, creating it if needed.
///
/// Returns `None` when the app is not running portably, in which case the
/// caller should leave WebView2 on its default per-user folder.
fn resolve() -> Option<PathBuf> {
    // An explicit override wins: it lets a user opt back into the roaming
    // profile, and lets `tauri dev` share one webview profile across builds.
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_some() {
        return None;
    }
    let data = exe_dir()?.join("data");
    std::fs::create_dir_all(&data).ok()?;
    is_writable(&data).then_some(data)
}

/// Where this run keeps its data, or `None` while running non-portably.
/// Resolved once at startup so the frontend and backend can't disagree.
static DATA_DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();

/// Redirect WebView2's storage next to the executable. Must be called before
/// [`tauri::Builder::run`] creates the webview, i.e. first thing in `run()`.
pub fn init() {
    let dir = resolve();
    if let Some(dir) = &dir {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", dir.join("webview"));
        // Logs default in here, so make sure the folder a first-run user is
        // offered actually exists.
        let _ = std::fs::create_dir_all(dir.join("logs"));
    }
    let _ = DATA_DIR.set(dir);
}

/// The portable `data/` folder, or an empty string when running non-portably
/// (settings then live in the per-user WebView2 profile as before).
#[tauri::command]
pub fn portable_data_dir() -> String {
    DATA_DIR
        .get()
        .and_then(|d| d.as_deref())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}
