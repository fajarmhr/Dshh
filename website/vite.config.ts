import { defineConfig } from "vite";

// Relative base so the built site works whether served from a domain root
// (Cloudflare Pages) or a sub-path.
export default defineConfig({ base: "./" });
