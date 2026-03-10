import { defineConfig } from "tsdown";
import { resolve } from "node:path";

const jsExtensions = () => ({ js: '.js', dts: '.d.ts' });
const srcAlias = { "@": resolve(import.meta.dirname, "src") };

export default defineConfig([
  {
    entry: { "server/index": "src/server/index.ts" },
    format: "esm",
    outDir: "dist",
    dts: true,
    clean: true,
    platform: "node",
    external: [/^convex/, "yjs", "convex-helpers"],
    noExternal: ["@robelest/fx"],
    outExtensions: jsExtensions,
    alias: srcAlias,
  },
  {
    entry: { "client/index": "src/client/index.ts" },
    format: "esm",
    outDir: "dist",
    dts: true,
    clean: false,
    platform: "browser",
    external: [/^convex/, "yjs", "convex-helpers"],
    noExternal: ["@robelest/fx"],
    outExtensions: jsExtensions,
    alias: srcAlias,
  },
  {
    entry: ["src/component/**/*.ts"],
    format: "esm",
    outDir: "dist/component",
    dts: true,
    clean: false,
    unbundle: true,
    platform: "node",
    external: [/^convex/, "yjs", "convex-helpers"],
    outExtensions: jsExtensions,
  },
]);
