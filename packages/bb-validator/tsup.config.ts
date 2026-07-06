import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "dataset/bb2025/index": "src/dataset/bb2025/index.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: "neutral", // browser-safe: fails the build if anything drags in Node built-ins
  target: "es2022",
});
