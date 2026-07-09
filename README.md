# Dshh

A modern, in-process multi-protocol connection client for Windows — **SSH**, **SFTP**,
**SCP**, **FTP**, **Serial**, and a built-in **Local terminal** (cmd / PowerShell) — built
with **Tauri 2 + React + Rust**.

## Why in-process?

Every protocol is implemented *inside this app's own executable* using Rust crates:

| Protocol       | Crate                   |
|----------------|-------------------------|
| SSH            | `russh`                 |
| SFTP           | `russh-sftp`            |
| SCP            | `russh` (exec channel)  |
| FTP            | `suppaftp`              |
| Serial         | `serialport`            |
| Local terminal | `portable-pty` (ConPTY) |

No child process named `ssh.exe` / `sftp.exe` / `ftp.exe` is ever spawned — the app is
a single process (`dshh.exe`). This also makes it far nicer to use than raw PowerShell:
tabbed sessions, saved connection profiles, a real xterm terminal, and a file browser.

## Features

- **Multi-protocol tabs** — SSH, SFTP, FTP, and Serial from one window.
- **Local terminal** — launch **cmd**, **Windows PowerShell**, and (if installed)
  **PowerShell 7 / Git Bash / WSL** in an embedded tab. Open a one-off from the sidebar
  `▾` menu, or save a reusable **Local** profile. **Run as Administrator** elevates through
  UAC and opens in its own window (an elevated shell can't share this app's console).
- **Real terminal** — xterm.js with buffer search (`Ctrl+F`), keyword highlighting,
  session recording, and save-to-file. Terminal size stays in lock-step with the remote
  PTY, so cursor editing (`←/→`, history) never smears.
- **SFTP file browser**, **port forwarding** (`ssh -L` tunnels), and saved-session sync.
- **SCP transfer** — copy single files to/from a server over SSH (the **SCP** button on an
  SSH tab), for hosts where the SFTP subsystem is disabled but `scp` still works.
  Remote paths may be absolute, `~/`-relative, or plain relative (resolved against home).
- **Auto-update** — checks GitHub Releases at startup (and on demand in Settings);
  one click downloads the new portable exe, swaps it in place, and restarts.

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

## Release a portable `.exe`

The build produces a self-contained `dshh.exe` — it only needs the WebView2 runtime,
which ships with Windows 10/11. Steps:

1. **Bump the version** in all three files (keep them in sync):
   `package.json`, `src-tauri/tauri.conf.json` (`version`), and `src-tauri/Cargo.toml`.
2. **Build** from a Developer PowerShell for VS:
   ```powershell
   npm run tauri:build
   ```
3. **Grab the artifacts** under `src-tauri/target/release/`:
   - `dshh.exe` — the **portable** single-file build (copy-and-run, no install).
   - `bundle/nsis/Dshh_<ver>_x64-setup.exe` — optional installer.
   - `bundle/msi/Dshh_<ver>_x64_en-US.msi` — optional MSI.
4. **Publish a GitHub Release**: tag `v<ver>`, upload `dshh.exe` (+ installer), write the
   changelog. Distributables are kept out of the repo (see `/share` in `.gitignore`) —
   host them on Releases, not in git.
   ```powershell
   gh release create v0.1.0 src-tauri/target/release/dshh.exe --title "Dshh v0.1.0" --notes "..."
   ```
5. Point the **website** download button at the new Release asset URL.

## Project layout

```
src/                 React frontend (Vite + Tailwind + xterm.js)
  components/         Sidebar, TabBar, Workspace, TerminalView, FileBrowser,
                     ConnectionModal, LocalLauncher
  lib/               types, Tauri API wrappers, utils
  store.ts           Zustand state (+ localStorage for saved connections)
src-tauri/src/       Rust backend
  ssh.rs sftp.rs ftp.rs serial.rs local.rs   one Tauri command module per protocol
  lib.rs             shared types, AppState, command registration
website/             Marketing + update/download site (Vite + React, static SPA)
```

## Deployment

See **[DEPLOY.md](DEPLOY.md)** for the full guide:

- **Website** → Cloudflare Pages (free static hosting).
- **Portable `.exe`** → GitHub Releases, built automatically by
  [`.github/workflows/release.yml`](.github/workflows/release.yml) on every `v*` tag.

## Security note

Host keys are currently accepted on first connect (TOFU). A known-hosts verification
step belongs in `ssh.rs::check_server_key` before real-world use.
