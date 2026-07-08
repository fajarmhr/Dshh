use crate::{AppState, Logger};
use std::fs::OpenOptions;
use std::io::Write;
use tauri::State;

/// Find the logger handle for a session id across the protocols that stream
/// terminal-style output (SSH, serial, and local shells).
async fn logger_for(state: &AppState, id: &str) -> Option<Logger> {
    if let Some(s) = state.ssh.lock().await.get(id) {
        return Some(s.logger.clone());
    }
    if let Some(s) = state.serial.lock().await.get(id) {
        return Some(s.logger.clone());
    }
    if let Some(s) = state.local.lock().await.get(id) {
        return Some(s.logger.clone());
    }
    None
}

/// Begin appending the live session output to `path`. Creates the file (and
/// appends if it already exists). Used for both manual "record" and auto-log.
#[tauri::command]
pub async fn log_start(id: String, path: String, state: State<'_, AppState>) -> Result<(), String> {
    let logger = logger_for(&state, &id)
        .await
        .ok_or("Session not found or does not support logging")?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Cannot open log file: {e}"))?;
    let _ = writeln!(file, "\n===== Dshh log started {} =====", now_stamp());
    *logger.lock().map_err(|e| e.to_string())? = Some(file);
    Ok(())
}

/// Stop logging the session (closes and flushes the file).
#[tauri::command]
pub async fn log_stop(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(logger) = logger_for(&state, &id).await {
        if let Ok(mut guard) = logger.lock() {
            if let Some(mut file) = guard.take() {
                let _ = file.flush();
            }
        }
    }
    Ok(())
}

/// Write arbitrary text to a file — used by the frontend "Save output" action
/// to dump the current terminal scrollback buffer.
#[tauri::command]
pub async fn save_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Save failed: {e}"))
}

/// Read a UTF-8 text file — used to load the optional saved-sessions file
/// (connections.json) from the folder chosen in Settings.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Read failed: {e}"))
}

fn now_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    secs.to_string()
}
