import { resolve } from "node:path";
import { defineConfig } from "vite";

// Relative base so the built site works whether served from a domain root
// (Cloudflare Pages) or a sub-path. Two pages: the home page and the full
// changelog it links to.
export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        changelog: resolve(__dirname, "changelog.html"),
      },
    },
  },
});
