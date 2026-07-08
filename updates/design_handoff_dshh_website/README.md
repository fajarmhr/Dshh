# Handoff: Dshh Marketing / Download Website

## Overview
A single-page marketing + download + changelog + docs website for **Dshh**, a Tauri 2 (React + Rust) in-process multi-protocol connection client for Windows (SSH, SFTP, FTP, Serial). The site's jobs, in priority order:

1. Let users download the latest release (hosted on **GitHub Releases**).
2. Show the changelog / release history.
3. Explain the update mechanism (the desktop app checks GitHub Releases on launch and shows an in-app notification; the website always shows the newest release from the same feed).
4. Market the app's core differentiator: every protocol implemented **in-process** in Rust inside one portable exe — no `ssh.exe`, no child processes, no installer.

## About the Design Files
The files in this bundle are **design references created in HTML** — interactive prototypes showing intended look and behavior, **not production code to copy directly**. The task is to **recreate these designs in your target environment** using its established patterns and libraries. There is no existing website codebase, so choose an appropriate stack — a static-friendly React framework (Astro, Next.js static export, or plain Vite + React) is recommended since the site is fully static except for one client-side fetch to the GitHub Releases API.

Open `Dshh Site.dc.html` in a browser to see the working reference (desktop and mobile — it responds to viewport width at a 768px breakpoint). `explorations/Dshh Website.dc.html` contains the earlier design explorations (options 1a/1b/1c and side-by-side desktop/mobile artboards 2a/2b) for context only. The `support.js` files are the prototype runtime — ignore them; they are not part of the design.

## Fidelity
**High-fidelity (hifi).** Colors, typography, spacing, copy, and interactions are final design intent. Recreate the UI pixel-perfectly. All measurements below are CSS px at 1440px desktop / 390px mobile.

## Tech & Data Requirements
- **Release data**: fetch `https://api.github.com/repos/<user>/<repo>/releases/latest` client-side on page load.
  - `tag_name` → version badge + "latest on github" line
  - `published_at` (first 10 chars) → release date
  - `assets[]` → find first asset matching `/\.zip$/i`; its `browser_download_url` is the Download button target. Fallback: the release `html_url`.
  - Handle: no repo configured (show setup hint), HTTP error (show `github: HTTP <status>`), loading (`checking github releases…`).
- **Download buttons** open the zip asset URL (or `github.com/<repo>/releases/latest` before the fetch resolves). "All releases ↗" → `github.com/<repo>/releases`.
- The in-app update notification UI (toast) shown in the Updates card is a **spec for the desktop app team** as well as a website demo. Update flow: on launch → GET releases/latest → semver-compare tag vs running build → if newer, show toast. No background service, no silent download/install.

## Global Design Tokens

### Colors
| Token | Hex | Use |
|---|---|---|
| bg | `#0a0e14` | Page + app-mockup background |
| panel | `#0d121a` | Cards, sidebar, titlebar, inactive tabs |
| panel-deep | `#070a0f` | Terminal/compose input, code blocks |
| elevated | `#131a24` | Chips, kbd keys, count badges, progress track |
| border | `#1c2531` | All card/section hairlines |
| border-strong | `#2a3646` | Secondary-button borders, kbd borders |
| border-hover | `#38465a` | Secondary-button hover border |
| text | `#e3eaf3` | Headings, primary text |
| muted | `#93a1b3` | Body copy, nav links |
| dim | `#5a6878` | Microcopy, eyebrows, meta lines |
| faint | `#38465a` | Feed-status line, kbd hint in compose |
| accent | `#5b8cff` | Primary buttons, links, SSH color, active indicators |
| accent-hover | `#7ca4ff` | Button hover, link text |
| green | `#3ecf8e` | SFTP, success, "latest" badge, connected dots |
| amber | `#e8a54c` | FTP, update-available "!" |
| purple | `#b78af7` | Serial |
| red | `#f26d78` | Errors, strikethrough decoration |
| accent tints | `rgba(91,140,255,0.1)` bg / `rgba(91,140,255,0.3)` border | Logo chip, icon chips, toast icon |
| nav glass | `rgba(10,14,20,0.88)` + `backdrop-filter: blur(12px)` | Sticky nav |
| selection | `rgba(91,140,255,0.35)` | `::selection` |

Protocol tints follow the same pattern: `rgba(62,207,142,0.1)` (SFTP), `rgba(232,165,76,0.1)` (FTP), `rgba(183,138,247,0.1)` (Serial).

### Typography
Families (both on Google Fonts, weights 400/500/600/700):
- **Geist** — all UI/marketing text. Fallback: `system-ui, sans-serif`.
- **JetBrains Mono** — brand wordmark, eyebrows, nav links, terminal content, versions, chips, kbd, all microcopy.

Scale (desktop → mobile where different):
| Role | Font | Size / line-height | Weight | Tracking | Color |
|---|---|---|---|---|---|
| Hero H1 | Geist | 72px / 1.02 → 42px / 1.06 | 700 | -0.03em → -0.028em | text |
| Section H2 | Geist | 36px | 600 | -0.022em | text |
| Card title | Geist | 21px / 16–16.5px | 600 | -0.01em / 0 | text |
| Hero body | Geist | 17px / 1.7 → 15px / 1.65 | 400 | 0 | muted |
| Card body | Geist | 13.5–14px / 1.65 | 400 | 0 | muted |
| Eyebrow | JB Mono | 11px (10px mobile) | 500 | 0.18em, uppercase | dim |
| Nav links | JB Mono | 11px | 500 | 0.15em, uppercase | muted, hover text |
| Terminal | JB Mono | 11.5px / 1.65 | 400 | 0 | per-role colors |
| Microcopy/meta | JB Mono | 10–11px | 400 | 0.03em | dim |
| Buttons | Geist | 13–14.5px | 500 | 0 | — |
| `body` | — | — | — | — | `-webkit-font-smoothing: antialiased` |

### Spacing & Shape
- Content column: `max-width: 1200px`, horizontal padding `24px`.
- Section vertical padding: `84px`; hero top `96px` (desktop) / `56px` (mobile).
- Section separators: `border-top: 1px solid #131a24`.
- Radii: 12px (cards, app window), 14px (download/docs cards), 8px (buttons, icon chips), 6px (small chips, tab rows), 5px (kbd), 99px (dots/pills).
- Grid gaps: 16px (protocol cards), 20px (download/docs cards), 48px (why-in-process 2-col).
- Buttons: primary `13px 24px` padding, accent bg, white text, hover accent-hover, shadow `0 8px 24px -8px rgba(91,140,255,0.5)` (hero only); secondary transparent, `1px solid #2a3646`, muted text, hover text+border-hover.
- Hero glow: radial gradient `560px×300px` ellipse, `rgba(91,140,255,0.13)` → transparent, centered above hero.
- App-window shadow: `0 -20px 80px -30px rgba(91,140,255,0.25)`; toast shadow: `0 24px 64px -16px rgba(4,10,20,0.8)`.

### Responsive
Single breakpoint: **768px**. Desktop ≥768: full nav, 72px H1, app mockup with sidebar, multi-column grids. Mobile <768: hamburger menu (slide-down panel), 42px H1, stacked full-width buttons, app mockup **without sidebar**, all grids collapse to one column (they use `auto-fit, minmax(230–320px, 1fr)` so this is automatic).

## Screens / Views

### 1. Sticky Nav (64px)
- Glass bar (nav glass token), hairline bottom border, content in 1200px column.
- Left: logo chip 26×26 (accent tint bg + border, `>_` in mono 11/600 accent) + wordmark `dshh` (JB Mono 14/600, tracking 0.08em).
- Center (desktop): links `features · download · changelog · docs` — scroll-spy shows a 5px accent dot before the active section's link.
- Right (desktop): `GitHub ↗` secondary button (13px), `↓ Download` primary button (13px).
- Mobile: 38×38 bordered `≡` button → slide-down panel (`#0d121a`, links as 12px mono uppercase rows with hairline dividers, then full-width primary Download button).
- Nav links smooth-scroll to sections with a 72px offset (do **not** use `scrollIntoView`; compute `getBoundingClientRect().top + scrollY - 72`).

### 2. Hero
- Eyebrow `ssh · sftp · ftp · serial — one exe`, H1 "Every protocol. / One process." (2 lines), body paragraph (max-width 620px), button row (`↓ Download for Windows` primary, `View changelog` secondary), meta line `v0.1.0 · portable zip · win64 · no installer · no admin rights` (JB Mono 11 dim).
- Below (margin-top 56px): **interactive app mockup**, a faithful recreation of the actual Dshh app, top corners rounded 12px, bottom edge bleeding into the next section:
  - Titlebar 34px (`#0d121a`): app icon 15px (`assets/dshh-icon.png`), "Dshh" 12px muted, Windows min/max/close glyphs 40px wide each, dim.
  - Body 500px tall: **Sidebar 248px** (desktop only): brand row + `+`; group headers (`▾ production · 3`, `▾ lab · 2` — JB Mono 10/500 uppercase 0.14em dim, count badge on elevated bg); connection rows (28px icon chip in protocol tint + name 13px text + address JB Mono 10.5 dim). Rows: prod-web-01 / prod-web-02 (SSH `>_` accent), assets-bucket (SFTP `~/` green), legacy-nas (FTP `⇅` amber), bench-rig (Serial `⌁` purple, `COM4 · 115200 baud`). Active row bg `#1a2330`; hover same. Footer: `in-process · no ssh.exe` + ⚙.
  - **Tab bar 36px** (`#0d121a`): three tabs — SSH/prod-web-01, SFTP/assets-bucket, SERIAL/bench-rig. Each: 6px status dot (green/green/amber), protocol tag (JB Mono 9/600 tracking 0.1em in protocol color), name 12.5px. Active tab: bg `#0a0e14`, text `#e3eaf3`, 2px accent top bar. Inactive: bg `#0d121a`, text muted. Clicking tabs or sidebar rows switches the pane.
  - **Panes** (fill remaining height):
    - SSH: terminal transcript (JB Mono 11.5/1.65) — prompt `admin@prod-web-01` green `:` dim `~` accent `$ cmd` muted; output muted; column headers dim; blinking 7×13px accent cursor (1.1s step-end).
    - SFTP: path bar (`~/` green + `/var/www/assets` + `↑ upload` and `⟳` chips), column header row (name/size/modified, JB Mono 9.5 uppercase dim), 6 file rows (dirs in accent, files in text; sizes right-aligned muted; dates dim; hover bg `#0d121a`), status bar `6 items · sftp · connected as deploy`.
    - Serial: `· opened COM4 @ 115200 8N1` then timestamped log lines (`[ 0.412]` purple + message muted), purple blinking cursor.
  - **Bottom dock** (`#0d121a`, top hairline): quick-command chips (`df -h`, `docker ps`, `tail -f syslog` — elevated bg, 1px border, JB Mono 10.5, hover brightens) + `+ manage`; compose row: input-look div (`#070a0f`, `$` prefix, `run a command…` placeholder, `ctrl+k` hint right-aligned) + `broadcast off` chip.

### 3. Protocols (`#dsh-features`)
- Eyebrow `protocols`, H2 "Four protocols. Zero child processes."
- 4 cards (auto-fit minmax 230px): 36px icon chip (protocol tint, mono glyph `>_ ~/ ⇅ ⌁`), name 16/600 + engine crate name (JB Mono 11 dim: russh / russh-sftp / suppaftp / serialport), 13.5px description. Card hover: border tints to the protocol color at 40% alpha.
- Below (84px gap): **Why in-process** 2-col grid — left: eyebrow `why in-process`, H2 "One exe. The whole client.", 4 checklist rows (green mono `✓` + 14.5px text, bold lead-in in text color). Right: "task manager — before / after" card (`#070a0f`): mono 12.5/2 — `# the usual stack` then 6 exes struck through with red line-through, then `# dshh` and `dshh.exe ← ssh · sftp · ftp · serial` in green.

### 4. Download + Updates (`#dsh-download`)
- Eyebrow `download`, H2 "Get Dshh for Windows". Two cards (auto-fit minmax 320px, gap 20):
- **Latest release card** (panel bg): badge row (`v0.1.0` accent chip, `latest` green chip, date dim) — populate from the GitHub API; title "Dshh 0.1.0 — portable" 21/600; filename row (deep bg, accent filename `↓ Dshh-0.1.0-portable-win64.zip`, `win64` tag) — clickable; install microcopy (JB Mono 11/1.9 dim): `unzip → run dshh.exe · no installer, no admin / uninstall = delete the folder`; buttons `↓ Download zip` (primary) / `All releases ↗` (secondary) / `copy link` (mono secondary; on click → `✓ copied` for 1.6s); status line (JB Mono 10.5 faint) showing feed state.
- **Updates card** (transparent, border only): eyebrow `updates`, title "You'll know when there's a new build", numbered steps (JB Mono 11.5/2.1, accent `01 02 03`): check GitHub Releases on launch → compare tag vs build → quiet in-app notification.
  - **Interactive toast demo** (panel bg card, max-width 360, min-height 86): five states —
    1. `idle`: green ✓ chip, "You're up to date", `dshh 0.1.0 · checked on launch`
    2. `checking`: spinning 12px ring (0.8s linear), "Checking for updates…", `GET api.github.com/…/releases/latest`
    3. `available`: accent ↓ chip, "Update available" + dismiss ✕ (→ idle), `dshh 0.2.0 · released today`, buttons **Download** (primary, → downloading) / **Changelog** (ghost, scrolls to changelog)
    4. `downloading`: 4px progress bar (track elevated, fill accent, animates ~0–100 in ~3s), filename + live `%` (JB Mono 10.5 dim)
    5. `done`: green ✓, "Ready — dshh 0.2.0 downloaded", `saved next to dshh.exe · restart to apply`
  - Control below: `▶ simulate update check` (mono secondary, visible in idle) / `↺ replay demo` (visible in done).
  - Footnote 12.5px dim: "No background service, nothing silent. This page reads the same feed — it always shows the newest release."

### 5. Changelog (`#dsh-changelog`)
- Eyebrow `changelog`, H2 "Release history". Entries as flex-wrap rows (version column 160px fixed + content min 320px flex), separated by `#1c2531` top borders:
  - **v0.1.0** (accent, JB Mono 13/600) + `latest` green chip + `jul 2026` dim; right: "Initial release" 16.5/600 + 6 bullet features (14px/1.65 muted).
  - **unreleased** (dim): `known-hosts verification (host keys are currently trust-on-first-use) · in-app update download`.
- Future releases repeat the first row's pattern, newest on top.

### 6. Docs (`#dsh-docs`)
- Eyebrow `docs`, H2 "Up and running in 30 seconds". Two cards (same grid as Download):
- **Quickstart**: title 16/600; 3 numbered mono steps (accent `01–03`, 12px): download zip → extract anywhere ("a USB stick works") → run dshh.exe, add first host with a `+` kbd chip. Divider, then note about SmartScreen/unsigned exe (12.5px dim).
- **Keyboard & commands**: rows with hairline dividers — kbd chip (92px fixed, elevated bg, 1px `#2a3646` border, radius 5, JB Mono 10.5 centered) + 13.5px description: `Ctrl + K` focus compose bar · `Ctrl + F` search terminal buffer · `Enter` run composed command · `broadcast` send to every connected host.

### 7. Footer
- Hairline top border; 1200px row (flex-wrap): small logo chip 22px + "dshh — in-process multi-protocol client" (13px muted); right: `win64 · tauri 2 + react + rust · no ssh.exe` (JB Mono 10.5 dim).

## Interactions & Behavior
- **Scroll-spy**: on scroll, the last section whose top ≤ 130px from viewport top is active; accent dot appears next to its nav link.
- **Smooth scroll**: nav/menu/changelog links scroll with 72px offset; mobile menu closes on navigate.
- **Hero mockup tabs**: clicking a tab or its sidebar row activates that pane (state: `activeTab: 'ssh' | 'sftp' | 'serial'`). Active tab gets bg/text/indicator changes listed above; matching sidebar row gets `#1a2330` bg.
- **Update demo state machine**: `idle → (simulate) → checking → (1.1s timeout) → available → (Download) → downloading → (progress interval ~55ms, +1.5–5/tick) → done → (replay) → idle`. Dismiss ✕ in `available` returns to idle. Clear timers on unmount.
- **Copy link**: writes zip URL via `navigator.clipboard`; label swaps to `✓ copied` for 1.6s.
- **Live release fetch**: see Tech & Data Requirements; all version strings/dates/URLs on the page should come from the feed once wired (the prototype shows v0.1.0 as static fallback).
- **Hovers**: all buttons/links/chips/cards as specified (color, border-color, or bg shifts; no transforms). Cursor blink 1.1s step-end; spinner 0.8s linear.
- **Mobile menu**: `≡` toggles slide-down panel; only rendered <768px.

## State Management
- `vw` (viewport width; resize listener) → `isMobile = vw < 768`
- `menuOpen` (mobile nav)
- `activeTab` ('ssh' | 'sftp' | 'serial')
- `demo` ('idle' | 'checking' | 'available' | 'downloading' | 'done') + `progress` (0–100)
- `copied` (copy-button feedback)
- `live` ({tag, date, zipUrl} | null) + `liveErr` (GitHub fetch)
- `activeSection` (scroll-spy)

## Assets
- `assets/dshh-icon.png` — the app icon, copied from the app repo (`src-tauri/icons/128x128@2x.png`). Used in the mockup titlebar (15px). Reuse the repo's icon set for favicons.
- Fonts: Geist + JetBrains Mono via Google Fonts (or self-host; the app itself uses `@fontsource-variable` versions).
- No other imagery — all "screenshots" are DOM recreations of the app UI.

## Files
- `Dshh Site.dc.html` — **the deliverable**: full interactive site (desktop + mobile), open in a browser.
- `assets/dshh-icon.png` — app icon.
- `explorations/Dshh Website.dc.html` — design exploration canvas (options 1a/1b/1c, final artboards 2a/2b). Context only.
- `support.js` (both folders) — prototype runtime, not part of the design.
