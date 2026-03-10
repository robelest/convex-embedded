import { defineConfig } from "tsdown";
import { resolve } from "node:path";

export default defineConfig({
  entry: ["src/index.ts", "src/browser/index.ts", "src/browser/wa-sqlite-worker.ts"],
  format: "esm",
  platform: "browser",
  dts: true,
  clean: true,
  external: ["convex", "convex/*"],
  noExternal: ["@robelest/fx"],
  alias: {
    "@": resolve(import.meta.dirname, "src"),
  },
});
