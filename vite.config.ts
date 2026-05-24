import path from "path";

import { config as loadDotenv } from "dotenv";
import type { Plugin } from "vite-plus";
import { defineConfig } from "vite-plus";

loadDotenv({ path: path.resolve(import.meta.dirname, ".env.local") });

const embeddedSrc = path.resolve(
  import.meta.dirname,
  "packages/convex-embedded/src",
);
const testsRoot = path.resolve(import.meta.dirname, "tests");
const convexApp = path.resolve(import.meta.dirname, "convex");
const convexPackage = path.resolve(import.meta.dirname, "node_modules/convex");

// Public surface: validated against the built package or documented entry
// points. The same globs are excluded from `core` so every test runs in exactly
// one project (no test dropped, none run twice).
const packageInclude = [
  "package/**/*.test.ts",
  "**/*.types.test.ts",
  "docs/**/*.test.ts",
];

// Live suite: runs against a real Convex preview, gated by RUN_CONVEX_LIVE.
const liveInclude = ["live/**/*.test.ts"];

const sharedTestOptions = {
  globals: true,
  clearMocks: true,
  mockReset: true,
  restoreMocks: true,
  unstubGlobals: true,
  unstubEnvs: true,
  setupFiles: [path.resolve(testsRoot, "setup.ts")],
  testTimeout: 15_000,
};

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
      "**/_generated/**",
      "packages/convex-embedded/consumer-types/**",
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
      "typescript/no-explicit-any": "warn",
      "typescript/no-empty-object-type": "off",
      "typescript/no-require-imports": "off",
      "typescript/no-unused-expressions": "off",
      "jest/no-focused-tests": "warn",
    },
    overrides: [
      {
        files: ["packages/convex-embedded/src/**/*.ts"],
        rules: {
          "typescript/no-explicit-any": "error",
          "typescript/no-empty-object-type": "error",
          "typescript/no-unused-expressions": "error",
          "no-console": "error",
        },
      },
      {
        files: [
          "packages/convex-embedded/src/shared/logger.ts",
          "packages/convex-embedded/src/unplugin.ts",
          "packages/convex-embedded/src/vite.ts",
          "packages/convex-embedded/src/next.ts",
          "packages/convex-embedded/src/nitro.ts",
          "packages/convex-embedded/src/codegen/**/*.ts",
        ],
        rules: {
          "no-console": "off",
        },
      },
      {
        files: ["tests/**/*.ts"],
        rules: {
          "typescript/no-explicit-any": "error",
          "no-empty-pattern": "off",
        },
      },
      {
        files: ["benchmarks/**/*.ts"],
        rules: {
          "typescript/no-explicit-any": "error",
        },
      },
    ],
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
          "convex/embedded.modules.ts",
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
          "convex/embedded.modules.ts",
        ],
      },
      "cache:typecheck": {
        command:
          "vp run --filter @robelest/convex-embedded build && vp run --filter @robelest/convex-embedded typecheck && vp exec tsgo --noEmit -p convex/tsconfig.json && vp exec tsgo --noEmit -p tests/tsconfig.json && vp exec tsgo --noEmit -p benchmarks/tsconfig.json",
        cache: true,
        input: [
          "convex/**",
          "packages/**",
          "tests/**",
          "benchmarks/**",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "tsconfig*.json",
          "vite.config.ts",
          "!**/dist/**",
          "!**/node_modules/**",
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
          "convex/embedded.modules.ts",
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
      "@tests": testsRoot,
      "@resolve": embeddedSrc,
      "@robelest/convex-embedded/server/schema": path.join(
        embeddedSrc,
        "server/schema.ts",
      ),
      "@robelest/convex-embedded/server/table": path.join(
        embeddedSrc,
        "server/table.ts",
      ),
      "@robelest/convex-embedded/server/fields": path.join(
        embeddedSrc,
        "server/fields.ts",
      ),
      "@robelest/convex-embedded/server": path.join(
        embeddedSrc,
        "server/index.ts",
      ),
      "@robelest/convex-embedded/client": path.join(
        embeddedSrc,
        "client/index.ts",
      ),
      "@robelest/convex-embedded/react": path.join(embeddedSrc, "react.ts"),
      "@robelest/convex-embedded/convex.config": path.join(
        embeddedSrc,
        "component/convex.config.ts",
      ),
      "@robelest/convex-embedded/crdt": path.join(embeddedSrc, "crdt/index.ts"),
      "@robelest/convex-embedded/test": path.join(embeddedSrc, "test.ts"),
      "@convex": convexApp,
      convex: convexPackage,
    },
  },
  test: {
    coverage: {
      reporter: ["text", "html"],
      exclude: [
        "tests/**",
        "benchmarks/**",
        "convex/_generated/**",
        "demos/**",
      ],
    },
    projects: [
      {
        extends: true,
        test: {
          ...sharedTestOptions,
          name: "core",
          root: testsRoot,
          environment: "node",
          include: ["**/*.test.ts"],
          exclude: [
            ...packageInclude,
            ...liveInclude,
            "**/node_modules/**",
            "**/dist/**",
          ],
        },
      },
      {
        extends: true,
        test: {
          ...sharedTestOptions,
          name: "package",
          root: testsRoot,
          environment: "node",
          include: packageInclude,
        },
      },
      {
        extends: true,
        test: {
          ...sharedTestOptions,
          name: "live",
          root: testsRoot,
          environment: "node",
          include: liveInclude,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
