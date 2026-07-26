<#
.SYNOPSIS
  Build Dshh and package it as a portable folder inside a distributable zip.

.DESCRIPTION
  Produces  share/Dshh-<ver>-portable.zip  containing:

      Dshh/
        dshh.exe        the app
        data/           settings, saved connections, logs — created on first run
        README.txt      what the folder is and how to move it

  The app keeps everything it writes inside data/, so the whole folder can be
  copied to another machine or a USB stick without losing a single setting.
  See src-tauri/src/portable.rs for how that redirection works.

  The bare dshh.exe is ALSO emitted next to the zip as Dshh-portable.exe. Both
  belong on the GitHub Release: the zip is what humans download, while the
  in-app updater fetches the bare exe so it can hot-swap a running install
  without disturbing the data/ folder beside it.

.PARAMETER SkipBuild
  Package whatever is already in src-tauri/target/release (fast re-runs).

.EXAMPLE
  # from a Developer PowerShell for VS, so the MSVC linker is on PATH
  ./scripts/package-portable.ps1
#>
[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "Packaging Dshh v$version" -ForegroundColor Cyan

if (-not $SkipBuild) {
    Push-Location $root
    try {
        npm run tauri:build
        if ($LASTEXITCODE -ne 0) { throw "tauri:build failed with exit code $LASTEXITCODE" }
    } finally { Pop-Location }
}

# Tauri names the raw binary after the Cargo package, but a productName rename
# has bitten us before — accept either casing.
$releaseDir = Join-Path $root 'src-tauri/target/release'
$exe = Get-ChildItem -Path $releaseDir -Filter '*.exe' |
       Where-Object { $_.Name -in @('dshh.exe', 'Dshh.exe') } |
       Select-Object -First 1
if (-not $exe) { throw "No dshh.exe found in $releaseDir — did the build succeed?" }

$stage = Join-Path $root "share/Dshh-$version-portable"
$appDir = Join-Path $stage 'Dshh'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $appDir 'data') -Force | Out-Null

Copy-Item $exe.FullName (Join-Path $appDir 'dshh.exe')

$readme = @"
Dshh v$version — portable build
================================

Run dshh.exe. That's it: no installer, no admin rights, no services.

Everything the app writes stays in this folder:

    Dshh\
      dshh.exe
      data\             empty until first run — see below
        webview\        settings and saved connections
        logs\           session logs, when logging is enabled

data\ ships empty on purpose. It is not part of the program — dshh.exe is
complete on its own — it is where the app puts what *you* create, from the
first time you run it. Nothing is missing if it looks bare.

To move Dshh to another machine, copy the whole Dshh folder. Your connections,
groups, colours, themes and preferences travel with it. Copying dshh.exe alone
leaves your data behind, and the copy starts empty.

Upgrading from a non-portable Dshh? The first portable run copies your existing
settings and saved connections across from your Windows user profile. The
originals are left untouched.

To uninstall, delete the folder. Nothing is left behind in the registry or in
your user profile.

A note on where settings live: if you place this folder somewhere unwritable —
Program Files, or a read-only drive — Dshh keeps working but falls back to
storing settings in your Windows user profile instead. Settings > Interface
shows which mode is active.

Windows SmartScreen may warn on first run; the executable is unsigned for now.
"@
Set-Content -Path (Join-Path $appDir 'README.txt') -Value $readme -Encoding utf8

$zip = Join-Path $root "share/Dshh-$version-portable.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $appDir -DestinationPath $zip -CompressionLevel Optimal

# Bare exe for the in-app updater (see update.rs PORTABLE_ASSET).
Copy-Item $exe.FullName (Join-Path $root "share/Dshh-portable.exe") -Force

Remove-Item $stage -Recurse -Force

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "`nReady to publish:" -ForegroundColor Green
Write-Host "  $zip  ($mb MB)"
Write-Host "  $(Join-Path $root 'share/Dshh-portable.exe')  (updater asset)"
