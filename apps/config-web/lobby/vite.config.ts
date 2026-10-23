import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Start Game / Lobby page: apps/config-web/lobby -> apps/config-web/public/lobby (served by config-web at /lobby/).
// The build output is NOT committed (gitignored); run `pnpm --filter config-web build:lobby` on the host.
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  base: "/lobby/",
  publicDir: false,
  logLevel: "warn",
  build: {
    outDir: fileURLToPath(new URL("../public/lobby", import.meta.url)),
    emptyOutDir: true,
    target: "es2020",
  },
});
