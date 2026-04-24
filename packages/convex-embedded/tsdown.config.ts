import { resolve } from "node:path";

import { defineConfig } from "vite-plus/pack";

const jsExtensions = () => ({ js: ".js", dts: ".d.ts" });
const srcAlias = { "@": resolve(import.meta.dirname, "src") };

export default defineConfig([
  // Main embedded runtime (browser)
  {
    entry: {
      index: "src/index.ts",
      auth: "src/auth/index.ts",
      // The browser sqlite client resolves ./worker.js relative to its emitted
      // chunk, so the worker entry must stay co-located with that chunk in dist/.
      worker: "src/browser/sqlite/worker.js",
      "browser/index": "src/browser/index.ts",
      "tracing/browser": "src/tracing/browser.ts",
      "tracing/node": "src/tracing/node.ts",
      react: "src/react.ts",
      "expo/index": "src/expo/index.ts",
    },
    format: "esm",
    platform: "browser",
    dts: true,
    clean: true,
    deps: {
      neverBundle: [/^convex/, "yjs", "convex-helpers"],
      alwaysBundle: ["effect", /^effect\//, /^@effect\/platform-browser/],
    },
    alias: srcAlias,
  },
  {
    entry: {
      "node/index": "src/node/index.ts",
      cli: "src/cli.ts",
    },
    format: "esm",
    outDir: "dist",
    dts: true,
    clean: false,
    platform: "node",
    deps: {
      neverBundle: [/^convex/, "yjs", "convex-helpers"],
      alwaysBundle: [
        "effect",
        /^effect\//,
        /^@effect\/platform-node/,
        /^@effect\/sql-sqlite-node/,
      ],
    },
    outExtensions: jsExtensions,
    alias: srcAlias,
  },
  // Schema-safe build — MUST produce a single file with no _deps/ chunks.
  // Convex's schema evaluator only allows convex/* imports.
  {
    entry: { "server/schema": "src/server/schema.ts" },
    format: "esm",
    outDir: "dist",
    dts: true,
    clean: false,
    platform: "node",
    deps: { neverBundle: [/^convex/] },
    outExtensions: jsExtensions,
  },
  // Resolve server (node) — runs in Convex backend
  {
    entry: {
      "server/index": "src/server/index.ts",
      "server/table": "src/server/table.ts",
      "server/fields": "src/server/fields.ts",
    },
    format: "esm",
    outDir: "dist",
    dts: true,
    clean: false,
    unbundle: true,
    platform: "node",
    deps: {
      neverBundle: [/^convex/, "yjs", "convex-helpers"],
      alwaysBundle: ["effect", /^effect\//, /^@effect\/platform-browser/],
    },
    outExtensions: jsExtensions,
    alias: srcAlias,
  },
  // CRDT field constructors + runtime read helpers
  {
    entry: { "crdt/index": "src/crdt/index.ts" },
    format: "esm",
    outDir: "dist",
    dts: true,
    clean: false,
    platform: "browser",
    deps: {
      neverBundle: [/^convex/, "yjs", "convex-helpers"],
      alwaysBundle: ["effect", /^effect\//, /^@effect\/platform-browser/],
    },
    outExtensions: jsExtensions,
    alias: srcAlias,
  },
  // Resolve client (browser) — remote engine
  {
    entry: { "client/index": "src/client/index.ts" },
    format: "esm",
    outDir: "dist",
    dts: true,
    clean: false,
    platform: "browser",
    deps: {
      neverBundle: [/^convex/, "yjs", "convex-helpers"],
      alwaysBundle: ["effect"],
    },
    outExtensions: jsExtensions,
    alias: srcAlias,
  },
  // Test helper — consumer-facing convex-test registration
  {
    entry: { test: "src/test.ts" },
    format: "esm",
    outDir: "dist",
    dts: true,
    clean: false,
    platform: "node",
    deps: {
      neverBundle: [/^convex/, "convex-test", "yjs", "convex-helpers"],
      alwaysBundle: ["effect"],
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
