use crate::{next_id, AppState, Logger};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::State;

/// A live local shell running inside a pseudo-terminal (ConPTY on Windows).
/// Mirrors the shape of `SshSession`/`SerialSession` so the frontend's terminal
/// view can drive it through the same write/resize/close plumbing.
pub struct LocalSession {
    /// Master-side writer — keystrokes/paste go here.
    pub writer: Mutex<Box<dyn Write + Send>>,
    /// Master handle, kept for window-resize (SIGWINCH equivalent).
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    /// The child shell process, so closing the tab can terminate it.
    pub child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    pub logger: Logger,
}

/// A shell we know how to launch, resolved to a concrete program + args.
struct ShellSpec {
    id: &'static str,
    label: &'static str,
    program: String,
    args: Vec<String>,
}

/// The `{id, label}` pair handed to the frontend launcher.
#[derive(serde::Serialize)]
pub struct ShellInfo {
    pub id: String,
    pub label: String,
}

fn path_exists(p: &str) -> bool {
    !p.is_empty() && std::path::Path::new(p).exists()
}

/// First match for `name` on the PATH, if any.
fn which(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let full = dir.join(name);
        if full.is_file() {
            return Some(full.to_string_lossy().into_owned());
        }
    }
    None
}

/// Enumerate the shells present on this machine. Only shells whose executable
/// actually exists are returned, so the launcher never offers a dead option.
#[cfg(windows)]
fn available_shells() -> Vec<ShellSpec> {
    let mut v = Vec::new();
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());

    let cmd = std::env::var("ComSpec").unwrap_or_else(|_| format!("{sysroot}\\System32\\cmd.exe"));
    if path_exists(&cmd) {
        v.push(ShellSpec { id: "cmd", label: "Command Prompt", program: cmd, args: vec![] });
    }

    let ps = format!("{sysroot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    if path_exists(&ps) {
        v.push(ShellSpec {
            id: "powershell",
            label: "Windows PowerShell",
            program: ps,
            args: vec!["-NoLogo".into()],
        });
    }

    if let Some(p) = which("pwsh.exe") {
        v.push(ShellSpec {
            id: "pwsh",
            label: "PowerShell 7",
            program: p,
            args: vec!["-NoLogo".into()],
        });
    }

    for cand in [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ] {
        if path_exists(cand) {
            v.push(ShellSpec {
                id: "gitbash",
                label: "Git Bash",
                program: cand.into(),
                args: vec!["--login".into(), "-i".into()],
            });
            break;
        }
    }

    let wsl = format!("{sysroot}\\System32\\wsl.exe");
    if path_exists(&wsl) {
        v.push(ShellSpec { id: "wsl", label: "WSL", program: wsl, args: vec![] });
    }

    v
}

#[cfg(not(windows))]
fn available_shells() -> Vec<ShellSpec> {
    let mut v = Vec::new();
    if let Ok(shell) = std::env::var("SHELL") {
        if path_exists(&shell) {
            v.push(ShellSpec { id: "default", label: "Shell", program: shell, args: vec![] });
        }
    }
    for (id, label, p) in [
        ("bash", "Bash", "/bin/bash"),
        ("zsh", "Zsh", "/bin/zsh"),
        ("sh", "sh", "/bin/sh"),
    ] {
        if path_exists(p) && !v.iter().any(|s| s.program == p) {
            v.push(ShellSpec { id, label, program: p.into(), args: vec![] });
        }
    }
    v
}

/// Home directory to fall back to when the caller doesn't pin a working dir,
/// so shells don't open in System32.
fn default_cwd() -> Option<String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|d| !d.is_empty())
}

/// List local shells available to launch (id + human label).
#[tauri::command]
pub fn local_list_shells() -> Vec<ShellInfo> {
    available_shells()
        .into_iter()
        .map(|s| ShellInfo { id: s.id.into(), label: s.label.into() })
        .collect()
}

/// Spawn a shell in a PTY and stream its output. `shell` is one of the ids from
/// `local_list_shells`; `cols`/`rows` seed the PTY at the terminal's real size
/// so line-editing wraps correctly from the first keystroke.
#[tauri::command]
pub async fn local_open(
    shell: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<Vec<u8>>,
    on_closed: Channel<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let spec = available_shells()
        .into_iter()
        .find(|s| s.id == shell)
        .ok_or_else(|| format!("Unknown or unavailable shell: {shell}"))?;

    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };

    // All the non-Send PTY plumbing lives in this block so nothing crosses the
    // later `.await` (Tauri command futures must be Send).
    let (mut reader, writer, master, child) = {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

        let mut builder = CommandBuilder::new(&spec.program);
        for a in &spec.args {
            builder.arg(a);
        }
        let dir = cwd.filter(|d| !d.is_empty()).or_else(default_cwd);
        if let Some(dir) = dir {
            builder.cwd(dir);
        }
        builder.env("TERM", "xterm-256color");

        let child = pair.slave.spawn_command(builder).map_err(|e| e.to_string())?;
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        drop(pair.slave); // let the child own the tty; we only need the master
        (reader, writer, pair.master, child)
    };

    let logger: Logger = crate::new_logger();
    let logger_reader = logger.clone();

    // Blocking read pump: forward bytes to the frontend (and the log) until the
    // shell exits or the pipe closes, then report the session as closed.
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    crate::logs::log_bytes(&logger_reader, &buf[..n]);
                    if on_data.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = on_closed.send("closed".into());
    });

    let id = next_id("local");
    state.local.lock().await.insert(
        id.clone(),
        LocalSession {
            writer: Mutex::new(writer),
            master: Mutex::new(master),
            child: Mutex::new(child),
            logger,
        },
    );
    Ok(id)
}

#[tauri::command]
pub async fn local_write(id: String, data: String, state: State<'_, AppState>) -> Result<(), String> {
    let map = state.local.lock().await;
    if let Some(s) = map.get(&id) {
        let mut w = s.writer.lock().map_err(|e| e.to_string())?;
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        let _ = w.flush();
    }
    Ok(())
}

#[tauri::command]
pub async fn local_resize(
    id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let map = state.local.lock().await;
    if let Some(s) = map.get(&id) {
        let master = s.master.lock().map_err(|e| e.to_string())?;
        master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn local_close(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(s) = state.local.lock().await.remove(&id) {
        if let Ok(mut child) = s.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}

/// Launch an elevated shell in its own window via UAC. An elevated process
/// can't share this app's medium-integrity console, so admin terminals open
/// standalone (Start-Process -Verb RunAs triggers the consent prompt).
#[tauri::command]
pub async fn local_open_admin(shell: String, cwd: Option<String>) -> Result<(), String> {
    let spec = available_shells()
        .into_iter()
        .find(|s| s.id == shell)
        .ok_or_else(|| format!("Unknown or unavailable shell: {shell}"))?;

    #[cfg(windows)]
    {
        let esc = |s: &str| s.replace('\'', "''"); // PowerShell single-quote escape
        let mut ps = format!("Start-Process -FilePath '{}' -Verb RunAs", esc(&spec.program));
        if !spec.args.is_empty() {
            let list = spec
                .args
                .iter()
                .map(|a| format!("'{}'", esc(a)))
                .collect::<Vec<_>>()
                .join(",");
            ps.push_str(&format!(" -ArgumentList {list}"));
        }
        if let Some(dir) = cwd.filter(|d| !d.is_empty()).or_else(default_cwd) {
            ps.push_str(&format!(" -WorkingDirectory '{}'", esc(&dir)));
        }
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps])
            .spawn()
            .map_err(|e| format!("Failed to request elevation: {e}"))?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = spec;
        let _ = cwd;
        Err("Administrator elevation is only supported on Windows".into())
    }
}
