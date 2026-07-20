# Deploying Dshh

Two independent targets:

- **Website** → Cloudflare Pages (free, unlimited bandwidth, global CDN).
- **Portable `.exe`** → GitHub Releases (free binary hosting, automated by CI).

---

## 1. Website → Cloudflare Pages

The site is a static SPA that builds to `website/dist/`. Cloudflare Pages serves
that folder for free.

To rebuild after editing the source:

```powershell
cd website
npm install   # first time only
npm run build
```

### One-time setup

```powershell
npm i -g wrangler      # Cloudflare's CLI (or use `npx wrangler …`)
wrangler login         # opens the browser, authorises your Cloudflare account
```

### Deploy (direct upload — works today, no source needed)

```powershell
npx wrangler pages deploy website/dist --project-name=dshh
```

- First run creates the project and prints your URL — the live site is
  `https://dshh-1ud.pages.dev`.
- Re-run the same command to publish updates.
- **Custom domain:** Cloudflare dashboard → Workers & Pages → `dshh` → Custom domains.

### Git-connected builds (recommended once the source is restored)

In the Cloudflare dashboard → *Create → Pages → Connect to Git → this repo*:

| Setting            | Value           |
|--------------------|-----------------|
| Root directory     | `website`       |
| Build command      | `npm run build` |
| Build output dir   | `dist`          |

Every push to `main` then rebuilds and deploys automatically.

---

## 2. Portable `.exe` → GitHub Releases (automated)

[`.github/workflows/release.yml`](.github/workflows/release.yml) builds on
`windows-latest` and attaches the artifacts to a Release. **No secrets needed** —
it uses the built-in `GITHUB_TOKEN`.

### Cut a release

1. Bump the version in **all three** files (keep them identical):
   - `package.json` → `"version"`
   - `src-tauri/tauri.conf.json` → `"version"`
   - `src-tauri/Cargo.toml` → `version`
2. Commit, then tag and push:
   ```powershell
   git commit -am "Release v0.1.0"
   git tag v0.1.0
   git push origin main --tags
   ```
3. The **Release** workflow runs and publishes a release containing:
   - `Dshh-portable.zip` — the primary website download (unzip & run; avoids
     browser warnings on bare executables)
   - `Dshh-portable.exe` — same build, unzipped; kept for the in-app self-updater
   - `Dshh_<ver>_x64-setup.exe` — NSIS installer
   - `Dshh_<ver>_x64_en-US.msi` — MSI installer

You can also trigger it manually from the **Actions** tab (`workflow_dispatch`).

### Stable "latest" download link for the website

Point the site's download button here — it always resolves to the newest release:

```
https://github.com/fajarmhr/Dshh/releases/latest/download/Dshh-portable.zip
```

### Local build (no CI)

```powershell
npm run tauri:build
# Portable exe: src-tauri/target/release/dshh.exe
# Installers:   src-tauri/target/release/bundle/{nsis,msi}/
```
