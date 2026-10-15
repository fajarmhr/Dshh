# Dshh

A modern, in-process multi-protocol connection client for Windows — **SSH**, **SFTP**,
**SCP**, **FTP**, **Serial**, **VNC**, and a built-in **Local terminal** (cmd / PowerShell) — built
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
| VNC (RFB)      | built in: `des`, `flate2`, `tokio-native-tls` |
| Local terminal | `portable-pty` (ConPTY) |

Nothing is shelled out to an external client and nothing has to be on your `PATH`:
`dshh.exe` opens the sockets, negotiates each transport and drives the PTY itself, as a
single process. That also makes it considerably more pleasant than a bare PowerShell
prompt — tabbed sessions, saved connection profiles, a real xterm terminal, and a file
browser.

## Features

- **Multi-protocol tabs** — SSH, SFTP, FTP, Telnet, VNC and Serial from one window.
- **Full screen** — any session, or both halves of a split view, across the
  whole monitor: `Ctrl+Alt+Enter` or the button at the right end of the tab bar.
  The sidebar, tabs and bottom bar step aside; touching the top edge slides
  the tab bar back down. The shortcut never reaches the terminal or the VM.
- **Groups** — hover a saved session and click its folder button to move it
  into a group: pick one from the list (with counts), or type a name to create
  it. The connection form's Group field is the same picker.
- **Help** — Settings › Help explains every feature and how to use it, with a
  search box and the keyboard shortcuts.
- **VNC remote desktop** — the remote screen in a tab, with keyboard, mouse,
  clipboard both ways, fit-to-tab or 1:1, view-only and Ctrl+Alt+Del, or
  **full screen** across the whole monitor (Ctrl+Alt+Enter, or the bar at the
  top edge). Logs in with a VNC password, VeNCrypt (X509 TLS, username +
  password) or Apple Remote Desktop for macOS Screen Sharing. **Route
  through** a saved SSH session to tunnel the unencrypted VNC stream.
  **Paste** opens your clipboard in an editable box first — nothing reaches
  the machine until you type it (consoles with no clipboard: BIOS, KVM, login
  prompts) or send it as its clipboard; on QEMU/KVM typing sends physical
  scancodes, so the guest's own keyboard layout applies. **Copy text** reads
  text off any part of the screen with Windows' built-in OCR, for consoles
  that never share a clipboard — tables keep their rows and columns; check
  and edit it, then copy.
- **Cloud console links** — paste an OpenStack / Huawei FusionSphere
  `vnc_auto.html?token=…` link (the monitor button in the sidebar picks it up
  from the clipboard) and the VM's console opens in a tab: Dshh speaks the
  noVNC proxy's WebSocket itself, no browser involved. Save the proxy as a
  connection — its host can be picked from a saved SSH session — and only
  the short-lived token is asked for each time. An open console is kept
  busy so proxies don't drop it as idle — after a minute untouched it also
  repeats the last mouse position, for proxies that want input — and if it
  drops anyway it reconnects on its own with the same token while the proxy
  accepts it.
- **SSH jump host** — reach servers behind a bastion (`ssh -J` style, one hop);
  configure it per connection, password or key auth for the hop.
- **Multi-execution** — the Broadcast toggle mirrors typed input to every
  connected terminal at once (MobaXterm-style multi-exec).
- **Macros** — hit **Macro** on a terminal to record the commands you type, name
  the result, and replay it into any session from a chip in the bottom dock.
  Steps are paced so the shell keeps up.
- **Password retry** — when a saved session is rejected by the server, Dshh asks
  for the password (or key passphrase) again rather than leaving a dead tab, and
  keeps the one that works — along with a username the session was missing —
  once the server accepts it. Switch the write off in Settings › General.
- **Session colours** — a coloured connect banner in the terminal, a segmented
  status bar with a clock, and the connection's own accent tinting its toolbar.
  All three toggle in Settings › General.
- **Reorderable chips** — quick commands and macros both list in the order their
  chips appear. Drag a row by its grip in the manage dialog to move it, or focus
  the grip and press ↑/↓.
- **SSH agent auth** — pick **agent** as the auth method and the key never
  enters this process. Tries the Windows OpenSSH agent service first, then
  Pageant; RSA keys negotiate SHA-2 via `server-sig-algs`.
- **Local terminal** — launch **cmd**, **Windows PowerShell**, and (if installed)
  **PowerShell 7 / Git Bash / WSL** in an embedded tab. Open a one-off from the sidebar
  `▾` menu, or save a reusable **Local** profile. **Run as Administrator** elevates through
  UAC and opens in its own window (an elevated shell can't share this app's console).
- **Real terminal** — xterm.js with buffer search (`Ctrl+F`), keyword highlighting,
  session recording, and save-to-file. Right-click copies the selection, or pastes when
  nothing is selected. Pasting **two or more lines asks first** and lists them, since every
  newline is an Enter to the shell. Terminal size stays in lock-step with the remote
  PTY, so cursor editing (`←/→`, history) never smears. An optional **status bar**
  carries the target, time connected, grid size and encoding.
- **Windows 11 backdrop (optional)** — Mica or acrylic behind the app chrome,
  in Settings → Interface. The terminal stays opaque; output over a blurred
  desktop is unreadable.
- **SFTP file browser** with drag & drop upload from Explorer and remote file
  editing — double-click a file to open it in your local editor; every save
  uploads back automatically. Listings show each file's **owner** (uids resolved
  against the server's own `/etc/passwd`), and every transfer draws a **progress
  bar** with bytes moved and percentage. Plus saved-session sync.
- **Sort, group and search files** — click a column (or use the sort menu) to
  order by name, type, size or date; group the listing by type, date or size
  bands, with collapsible groups. The filter box narrows the folder as you type
  (`*` wildcards work), and **Enter searches every subfolder** on the server,
  streaming matches in with a stop button. The local pane in split view gets
  the same sort, group and filter; each pane remembers its own choice.
- **Select and act in bulk** — tick files and folders in the SFTP/FTP browser
  (checkboxes, click, Ctrl+click, Shift+click, Ctrl+A), then **download** them —
  folders recreated on your disk — **delete** them (the warning counts what the
  folders hold first; symlinks are never followed), change **permissions** (rwx
  grid or octal, optionally into folders, which keep their execute bit) or, over
  SFTP, change **owner and group** by name. FTP permissions go through
  `SITE CHMOD`. A `perms` column shows each entry's rights.
- **Ctrl+scroll zoom** — the terminal font and the file list, each
  remembered per connection; Ctrl+0 (or the zoom indicator) resets. On a VNC
  screen Ctrl+scroll goes to the machine; the Fit button switches to 1:1.
- **Port forwarding, all three directions** — local (`ssh -L`), remote
  (`ssh -R`, the server listens for you) and dynamic (`ssh -D`, a built-in
  SOCKS5 proxy). Each forward runs on its own SSH connection and shows live
  byte counters, so an idle tunnel reads differently from a busy one.
- **SCP transfer** — copy single files to/from a server over SSH (the **SCP** button on an
  SSH tab), for hosts where the SFTP subsystem is disabled but `scp` still works.
  Remote paths may be absolute, `~/`-relative, or plain relative (resolved against home).
- **Auto-update** — checks GitHub Releases at startup (and on demand in Settings);
  one click downloads the new portable exe, swaps it in place, and restarts.
- **Master password (optional)** — encrypts saved passwords/passphrases at rest
  (Argon2id + AES-256-GCM) in both app storage and the `connections.json` mirror;
  unlock once per app start. Enable it in Settings → Security.
- **Sessions folder** — Settings → Security → *Sessions folder* mirrors your
  connections to `connections.json`. Point it at a folder that already has one
  and it is loaded instead, which is also how you carry connections into a new
  install or recover them from an older one. It **replaces** the current list
  rather than merging, accepts either a bare JSON array or the
  `{ connections, master }` wrapper, and if the file came from an install with a
  different master password, Dshh adopts that key and asks for *that* password.

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
