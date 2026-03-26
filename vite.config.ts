import path from "path";

import type { Plugin } from "vite-plus";
import { defineConfig } from "vite-plus";

const embeddedSrc = path.resolve(
  import.meta.dirname,
  "packages/convex-embedded/src",
);
const convexApp = path.resolve(import.meta.dirname, "convex");

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    proseWrap: "always",
    printWidth: 80,
    sortImports: {},
    ignorePatterns: [
      "**/dist/**",
      "**/_generated/**",
      "**/node_modules/**",
      "pnpm-lock.yaml",
    ],
  },
  lint: {
    plugins: ["typescript", "jest", "import", "unicorn"],
    env: {
      browser: true,
      node: true,
    },
    ignorePatterns: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/convex/_generated/**",
      "**/*.d.ts",
    ],
    rules: {
      "typescript/no-unused-vars": [
        "warn",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
        },
      ],
      "typescript/ban-ts-comment": "error",
      "typescript/no-explicit-any": "off",
      "typescript/no-empty-object-type": "off",
      "typescript/no-require-imports": "off",
      "typescript/no-unused-expressions": "off",
      "jest/no-focused-tests": "warn",
    },
    options: {
      typeAware: true,
      typeCheck: false,
    },
  },
  run: {
    cache: {
      scripts: false,
      tasks: true,
    },
    tasks: {
      "cache:build": {
        command:
          "vp exec convex codegen --component-dir ./packages/convex-embedded/src/component && vp run --filter @robelest/convex-embedded build",
        cache: true,
        input: [
          "convex/**",
          "packages/**",
          "demos/**",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "tsconfig*.json",
          "vite.config.ts",
          "README.md",
          "!**/dist/**",
          "!**/_generated/**",
        ],
      },
      "cache:check": {
        command: "vp lint && vp fmt --check .",
        cache: true,
        input: [
          "convex/**",
          "packages/**",
          "demos/**",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "tsconfig*.json",
          "vite.config.ts",
          "README.md",
          "!**/dist/**",
          "!**/_generated/**",
        ],
      },
      "cache:test": {
        command: "vp run --filter tests test:once",
        cache: true,
        input: [
          "convex/**",
          "packages/**",
          "demos/**",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "tsconfig*.json",
          "vite.config.ts",
          "README.md",
          "!**/dist/**",
          "!**/_generated/**",
        ],
      },
    },
  },
  plugins: [
    ((): Plugin => ({
      name: "at-alias",
      async resolveId(source: string, importer: string | undefined) {
        if (!source.startsWith("@/") || !importer) return null;
        if (!importer.includes("/convex-embedded/")) return null;
        const resolved = await this.resolve(
          path.join(embeddedSrc, source.slice(2)),
          importer,
          { skipSelf: true },
        );
        return resolved ?? null;
      },
    }))(),
  ],
  resolve: {
    alias: {
      "@embedded": embeddedSrc,
      "@resolve": embeddedSrc,
      "@robelest/convex-embedded/server": path.join(
        embeddedSrc,
        "server/index.ts",
      ),
      "@robelest/convex-embedded/client": path.join(
        embeddedSrc,
        "client/index.ts",
      ),
      "@robelest/convex-embedded/convex.config": path.join(
        embeddedSrc,
        "component/convex.config.ts",
      ),
      "@robelest/convex-embedded/crdt": path.join(embeddedSrc, "crdt/index.ts"),
      "@robelest/convex-embedded/test": path.join(embeddedSrc, "test.ts"),
      "@convex": convexApp,
    },
  },
  test: {
    include: ["**/*.test.ts"],
    testTimeout: 10_000,
    coverage: {
      reporter: ["text", "html"],
      exclude: ["tests/**", "convex/_generated/**", "demos/**"],
    },
  },
});
