import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against sources so build order never blocks the suite.
      "@bb/validator/dataset": fileURLToPath(
        new URL("./packages/bb-validator/src/dataset/bb2025/index.ts", import.meta.url),
      ),
      "@bb/validator": fileURLToPath(new URL("./packages/bb-validator/src/index.ts", import.meta.url)),
      "@bb/ingest": fileURLToPath(new URL("./packages/bb-ingest/src/index.ts", import.meta.url)),
      "@bb/fork-jnlp": fileURLToPath(new URL("./packages/bb-fork-jnlp/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
    testTimeout: 20000,
  },
});
