import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

// League & Tournament Manager SPA: apps/config-web/spa -> apps/config-web/public/app (served by config-web at /app/,
// history fallback to /app/index.html). The build output is NOT committed (gitignored); run
// `pnpm --filter config-web build:spa` on the host.
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  base: "/app/",
  publicDir: false,
  logLevel: "warn",
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL("../public/app", import.meta.url)),
    emptyOutDir: true,
    target: "es2020",
  },
});
