# Dshh Website

Marketing / download / changelog site for Dshh, built from the design handoff
(`updates/design_handoff_dshh_website`). Vite + React + TypeScript, plain CSS
with design tokens, fonts self-hosted via `@fontsource-variable`. Fully static
except one client-side fetch to the GitHub Releases API.

## Commands

```sh
npm install
npm run dev       # dev server on http://localhost:5199
npm run build     # type-check + static build into dist/
npm run preview   # serve the production build locally
```

## Release feed

`src/config.ts` → `GITHUB_REPO` (currently `fajarmhr/Dshh`). The page reads
`https://api.github.com/repos/<repo>/releases/latest` on load: the version
badge, dates, zip filename and every download link come from the feed (first
`.zip` asset wins; falls back to the release page, and to the static v0.1.0
copy while loading or on error).

## Deploy

`npm run build` and host `dist/` on any static host (GitHub Pages, Vercel,
Netlify…). The build uses a relative base (`./`), so it works from a subpath
like `https://<user>.github.io/Dshh/` without changes.
