import { defineConfig } from "tsdown";
import { resolve } from "node:path";

export default defineConfig({
  entry: ["src/index.ts", "src/browser/index.ts"],
  format: "esm",
  platform: "browser",
  dts: true,
  clean: true,
  external: ["convex", "convex/*"],
  alias: {
    "@": resolve(import.meta.dirname, "src"),
  },
});
