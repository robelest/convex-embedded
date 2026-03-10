import { resolve } from "node:path";

import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/browser/index.ts",
    "src/browser/wa-sqlite-worker.ts",
  ],
  format: "esm",
  platform: "browser",
  dts: true,
  clean: true,
  deps: {
    neverBundle: ["convex", "convex/*"],
    alwaysBundle: ["@robelest/fx"],
  },
  alias: {
    "@": resolve(import.meta.dirname, "src"),
  },
});
