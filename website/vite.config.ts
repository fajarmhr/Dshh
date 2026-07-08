import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" keeps the build path-relative so the static output works from
// any host or subpath (GitHub Pages, Vercel, a plain file server).
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5199, strictPort: true },
});
