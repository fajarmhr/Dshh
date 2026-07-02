# Dshh

A modern, in-process multi-protocol connection client for Windows — **SSH**, **SFTP**,
**FTP**, and **Serial** — built with **Tauri 2 + React + Rust**.

## Why in-process?

Every protocol is implemented *inside this app's own executable* using Rust crates:

| Protocol | Crate        |
|----------|--------------|
| SSH      | `russh`      |
| SFTP     | `russh-sftp` |
| FTP      | `suppaftp`   |
| Serial   | `serialport` |

No child process named `ssh.exe` / `sftp.exe` / `ftp.exe` is ever spawned — the app is
a single process (`dshh.exe`). This also makes it far nicer to use than raw PowerShell:
tabbed sessions, saved connection profiles, a real xterm terminal, and a file browser.

## Prerequisites

- **Node.js** (installed)
- **Rust** MSVC toolchain (installed)
- **Windows SDK** — REQUIRED for linking. Install via the Visual Studio Installer:
  *Modify → Desktop development with C++* (or Individual Components → *Windows 11 SDK*).
  Without it you get `LINK : fatal error LNK1181: cannot open input file 'kernel32.lib'`.

## Run (development)

Use a **Developer PowerShell for VS** (so the MSVC linker + SDK are on PATH), then:

```powershell
npm install
npm run tauri:dev
```

> Do NOT run the Rust build from Git Bash — its GNU coreutils `link` shadows MSVC's
> `link.exe`. Use PowerShell / Developer PowerShell.

## Build (release)

```powershell
npm run tauri:build
```

## Project layout

```
src/                 React frontend (Vite + Tailwind + xterm.js)
  components/         Sidebar, TabBar, Workspace, TerminalView, FileBrowser, ConnectionModal
  lib/               types, Tauri API wrappers, utils
  store.ts           Zustand state (+ localStorage for saved connections)
src-tauri/src/       Rust backend
  ssh.rs sftp.rs ftp.rs serial.rs   one Tauri command module per protocol
  lib.rs             shared types, AppState, command registration
```

## Security note

Host keys are currently accepted on first connect (TOFU). A known-hosts verification
step belongs in `ssh.rs::check_server_key` before real-world use.
