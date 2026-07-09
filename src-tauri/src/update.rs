use serde::Serialize;
use std::time::Duration;

/// Self-update against GitHub Releases. `update_check` compares the running
/// version with the latest release tag; `update_apply` downloads the portable
/// exe and swaps it in place (a running exe can be renamed on Windows, so we
/// move the old one aside and drop the new one at the original path). Works
/// for the portable exe; installer builds fall back to the release page.

const REPO: &str = "fajarmhr/Dshh";
const PORTABLE_ASSET: &str = "Dshh-portable.exe";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub update_available: bool,
    pub notes: String,
    pub asset_url: Option<String>,
    pub release_url: String,
}

fn parse_ver(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split('.')
        .map(|p| {
            p.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse()
                .unwrap_or(0)
        })
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let (l, c) = (parse_ver(latest), parse_ver(current));
    for i in 0..l.len().max(c.len()) {
        let a = l.get(i).copied().unwrap_or(0);
        let b = c.get(i).copied().unwrap_or(0);
        if a != b {
            return a > b;
        }
    }
    false
}

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").into()
}

#[tauri::command]
pub async fn update_check() -> Result<UpdateInfo, String> {
    tokio::task::spawn_blocking(check_blocking)
        .await
        .map_err(|e| e.to_string())?
}

fn check_blocking() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .build()
        .get(&url)
        .set("User-Agent", "Dshh-updater")
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(15))
        .call()
        .map_err(|e| format!("Update check failed: {e}"))?;
    let json: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;

    let tag = json["tag_name"].as_str().unwrap_or("");
    if tag.is_empty() {
        return Err("Update check failed: no releases found".into());
    }
    let latest = tag.trim_start_matches(['v', 'V']).to_string();
    let notes = json["body"].as_str().unwrap_or("").to_string();
    let asset_url = json["assets"]
        .as_array()
        .and_then(|assets| {
            assets
                .iter()
                .find(|a| a["name"].as_str() == Some(PORTABLE_ASSET))
        })
        .and_then(|a| a["browser_download_url"].as_str())
        .map(str::to_string);

    Ok(UpdateInfo {
        update_available: is_newer(&latest, &current),
        release_url: format!("https://github.com/{REPO}/releases/latest"),
        current,
        latest,
        notes,
        asset_url,
    })
}

/// Download the new portable exe and swap it in. After Ok(), the file at the
/// current exe path is the new version; call `update_restart` to load it.
#[tauri::command]
pub async fn update_apply(asset_url: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || apply_blocking(&asset_url))
        .await
        .map_err(|e| e.to_string())?
}

fn apply_blocking(asset_url: &str) -> Result<(), String> {
    if !asset_url.starts_with("https://") {
        return Err("Refusing non-https update URL".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("Cannot locate app folder")?;
    let staged = dir.join("Dshh-update.tmp");

    let resp = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .build()
        .get(asset_url)
        .set("User-Agent", "Dshh-updater")
        .call()
        .map_err(|e| format!("Download failed: {e}"))?;
    let mut reader = resp.into_reader();
    let mut out = std::fs::File::create(&staged)
        .map_err(|e| format!("Cannot write next to the app (folder read-only?): {e}"))?;
    std::io::copy(&mut reader, &mut out).map_err(|e| format!("Download failed: {e}"))?;
    drop(out);

    let size = std::fs::metadata(&staged).map(|m| m.len()).unwrap_or(0);
    if size < 1_000_000 {
        let _ = std::fs::remove_file(&staged);
        return Err("Downloaded update looks corrupt (too small)".into());
    }

    let old = exe.with_extension("exe.old");
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&exe, &old)
        .map_err(|e| format!("Cannot replace the running exe (permissions?): {e}"))?;
    if let Err(e) = std::fs::rename(&staged, &exe) {
        let _ = std::fs::rename(&old, &exe); // roll back so the app stays launchable
        return Err(format!("Cannot install update: {e}"));
    }
    Ok(())
}

#[tauri::command]
pub fn update_restart(app: tauri::AppHandle) {
    app.restart();
}

/// Open an https link in the default browser (fallback when self-update
/// can't run, e.g. installer builds or read-only folders).
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only https URLs can be opened".into());
    }
    #[cfg(target_os = "windows")]
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete the leftover `.exe.old` from a previous self-update, if any.
pub fn cleanup_stale_update() {
    if let Ok(exe) = std::env::current_exe() {
        let old = exe.with_extension("exe.old");
        if old.exists() {
            let _ = std::fs::remove_file(&old);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live network test: validates parsing against the real GitHub API.
    #[test]
    #[ignore]
    fn update_check_live() {
        let info = check_blocking().expect("update check failed");
        println!("update info: {info:?}");
        assert!(!info.latest.is_empty());
        assert!(info.asset_url.is_some(), "release should carry the portable exe asset");
    }

    #[test]
    fn version_compare() {
        assert!(is_newer("0.3.0", "0.2.0"));
        assert!(is_newer("v0.2.1", "0.2.0"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(is_newer("0.2.0.1", "0.2.0"));
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(!is_newer("0.1.9", "0.2.0"));
        assert!(!is_newer("garbage", "0.2.0"));
    }
}
