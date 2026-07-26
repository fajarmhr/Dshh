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

/// WebView2 always nests its profile in an `EBWebView` subfolder of whatever
/// `WEBVIEW2_USER_DATA_FOLDER` points at, so paths below go one level deeper
/// than the redirect target.
const PROFILE: &str = "EBWebView";

/// Settings, connections, macros and quick commands are all `localStorage`,
/// which lives entirely under this one subtree. Copying the rest of a WebView2
/// profile would drag along hundreds of megabytes of caches for no gain.
const STORAGE: &str = "Default/Local Storage";

/// Where a non-portable build kept its profile: `%LOCALAPPDATA%\<identifier>`,
/// with the identifier from `tauri.conf.json`.
fn legacy_profile() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local).join("com.dshh.app").join(PROFILE))
}

/// Copy a directory tree. Individual failures are skipped rather than
/// propagated: a half-copied profile still beats refusing to start.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            let _ = copy_tree(&entry.path(), &target);
        } else {
            let _ = std::fs::copy(entry.path(), &target);
        }
    }
    Ok(())
}

/// Hand a previous per-user install's saved connections and settings over to
/// this portable folder, once.
///
/// Without this, switching to the portable build looks like the app forgot
/// everything: the redirect gives WebView2 a brand-new profile, and the old
/// one sits untouched under `%LOCALAPPDATA%`. Only runs when the portable
/// profile has no storage of its own, so it can never overwrite live data —
/// and the source is left in place, so the old build still works.
fn adopt_legacy_storage(webview: &Path) {
    let target = webview.join(PROFILE).join(STORAGE);
    if target.exists() {
        return;
    }
    let Some(source) = legacy_profile().map(|p| p.join(STORAGE)) else {
        return;
    };
    if !source.is_dir() {
        return;
    }
    let _ = copy_tree(&source, &target);
}

/// Where this run keeps its data, or `None` while running non-portably.
/// Resolved once at startup so the frontend and backend can't disagree.
static DATA_DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();

/// Redirect WebView2's storage next to the executable. Must be called before
/// [`tauri::Builder::run`] creates the webview, i.e. first thing in `run()`.
pub fn init() {
    let dir = resolve();
    if let Some(dir) = &dir {
        let webview = dir.join("webview");
        // Before the webview opens the profile, not after — WebView2 holds a
        // lock on it for the rest of the process.
        adopt_legacy_storage(&webview);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview);
        // Logs default in here, so make sure the folder a first-run user is
        // offered actually exists.
        let _ = std::fs::create_dir_all(dir.join("logs"));
    }
    let _ = DATA_DIR.set(dir);
}

/// Folder new session logs go to when the user hasn't picked one: `logs`
/// inside the portable data folder, or empty when running non-portably (the
/// app then asks where to save each log).
#[tauri::command]
pub fn default_log_dir() -> String {
    DATA_DIR
        .get()
        .and_then(|d| d.as_deref())
        .map(|p| p.join("logs").to_string_lossy().into_owned())
        .unwrap_or_default()
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
