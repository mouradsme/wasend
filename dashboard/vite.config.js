import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// The built dashboard lands in ../public, which the Worker serves as static assets.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [svelte()],
  build: { outDir: "../public", emptyOutDir: true },
  // `npm run dev:dashboard` serves the UI with hot reload and forwards API calls to `wrangler dev`.
  server: { port: 5173, proxy: { "/v1": "http://localhost:8787" } },
});
