import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "server/index": "src/server/index.ts",
    "client/index": "src/client/index.ts",
    "component/convex.config": "src/component/convex.config.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["convex", "convex-helpers", "convex/server", "convex/values"],
  // Disable content hashing for deterministic filenames
  outputOptions: {
    entryFileNames: "[name].js",
    chunkFileNames: "[name].js",
  },
});
