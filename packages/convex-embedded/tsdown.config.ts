import { resolve } from "node:path";

import { defineConfig } from "tsdown";

const jsExtensions = () => ({ js: ".js", dts: ".d.ts" });
const srcAlias = { "@": resolve(import.meta.dirname, "src") };

export default defineConfig([
  // Main embedded runtime (browser)
  {
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
      neverBundle: [/^convex/, "yjs", "convex-helpers"],
      alwaysBundle: ["@robelest/fx"],
    },
    alias: srcAlias,
  },
  // Resolve server (node) — runs in Convex backend
  {
    entry: { "server/index": "src/server/index.ts" },
    format: "esm",
    outDir: "dist",
    dts: true,
    clean: false,
    platform: "node",
    deps: {
      neverBundle: [/^convex/, "yjs", "convex-helpers"],
      alwaysBundle: ["@robelest/fx"],
    },
    outExtensions: jsExtensions,
    alias: srcAlias,
  },
  // Resolve client (browser) — sync engine
  {
    entry: { "client/index": "src/client/index.ts" },
    format: "esm",
    outDir: "dist",
    dts: true,
    clean: false,
    platform: "browser",
    deps: {
      neverBundle: [/^convex/, "yjs", "convex-helpers"],
      alwaysBundle: ["@robelest/fx"],
    },
    outExtensions: jsExtensions,
    alias: srcAlias,
  },
  // Convex component (node, unbundled)
  {
    entry: ["src/component/**/*.ts"],
    format: "esm",
    outDir: "dist/component",
    dts: true,
    clean: false,
    unbundle: true,
    platform: "node",
    deps: {
      neverBundle: [/^convex/, "yjs", "convex-helpers"],
    },
    outExtensions: jsExtensions,
  },
]);
