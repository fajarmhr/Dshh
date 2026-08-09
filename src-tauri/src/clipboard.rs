//! System clipboard access for the terminal's right-click copy/paste.
//!
//! The webview's own `navigator.clipboard` can't be relied on here: reading
//! needs a permission grant WebView2 never gives a Tauri app, so the read half
//! would fail exactly where it matters. Going through the OS clipboard from
//! Rust keeps both halves working the same way on every platform.

use arboard::Clipboard;
use std::sync::{Mutex, OnceLock};

/// Run `f` against a process-wide clipboard handle, creating it on first use.
///
/// The handle is kept alive rather than opened per call because X11 ties
/// clipboard ownership to a live connection — dropping the handle after a copy
/// would drop the copied text with it. Windows doesn't care either way.
fn with_clipboard<T>(
    f: impl FnOnce(&mut Clipboard) -> Result<T, arboard::Error>,
) -> Result<T, String> {
    static CLIPBOARD: OnceLock<Mutex<Option<Clipboard>>> = OnceLock::new();
    // A poisoned lock just means an earlier clipboard call panicked. There is
    // no invariant to protect here, so reuse the handle instead of failing.
    let mut slot = CLIPBOARD
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if slot.is_none() {
        *slot = Some(Clipboard::new().map_err(|e| e.to_string())?);
    }
    f(slot.as_mut().expect("clipboard handle just set")).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clipboard_write(text: String) -> Result<(), String> {
    with_clipboard(|c| c.set_text(text))
}

#[tauri::command]
pub fn clipboard_read() -> Result<String, String> {
    with_clipboard(|c| match c.get_text() {
        // Empty clipboard, or one holding something that isn't text (an image,
        // a file list). There is simply nothing to paste — not a failure.
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        other => other,
    })
}
