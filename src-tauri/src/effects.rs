use tauri::window::{Color, Effect, EffectsBuilder};
use tauri::WebviewWindow;

/// The app's opaque base colour, matching `colors.bg.base` in the Tailwind
/// theme. Restored under the webview whenever effects are turned off, so the
/// window never flashes white on the way back to opaque.
const BASE: Color = Color(10, 14, 20, 255);

/// Fully transparent, so mica/acrylic behind the webview can be seen at all.
const CLEAR: Color = Color(0, 0, 0, 0);

/// Apply a Windows 11 backdrop behind the app chrome.
///
/// Two things have to happen together: the *window* is told to draw the
/// material, and the *webview* is told to stop painting its own opaque
/// background over it. Getting only the first is why a mica window can look
/// exactly like a plain one.
///
/// Returns an error the frontend can surface rather than failing silently —
/// mica and acrylic exist only on Windows 11, and the caller only dims its own
/// backgrounds once this has succeeded.
#[tauri::command]
pub fn set_window_effect(window: WebviewWindow, effect: String) -> Result<(), String> {
    let material = match effect.as_str() {
        "mica" => Some(Effect::Mica),
        "acrylic" => Some(Effect::Acrylic),
        "opaque" => None,
        other => return Err(format!("Unknown window effect: {other}")),
    };

    match material {
        None => {
            window
                .set_effects(None)
                .map_err(|e| format!("Could not clear the window effect: {e}"))?;
            window
                .set_background_color(Some(BASE))
                .map_err(|e| format!("Could not restore the window background: {e}"))?;
        }
        Some(material) => {
            window
                .set_effects(EffectsBuilder::new().effect(material).build())
                .map_err(|e| {
                    format!("{effect} is unavailable on this system ({e}) — Windows 11 only")
                })?;
            // Only clear the webview once the material is actually in place, or
            // a failure would leave the app drawing onto nothing.
            window
                .set_background_color(Some(CLEAR))
                .map_err(|e| format!("Could not make the webview translucent: {e}"))?;
        }
    }
    Ok(())
}
