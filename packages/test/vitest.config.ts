import path from "path";

import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const embeddedSrc = path.resolve(__dirname, "../convex-embedded/src");
const resolveSrc = path.resolve(__dirname, "../convex-resolve/src");
const fxSrc = path.resolve(__dirname, "../fx/src");

export default defineConfig({
  plugins: [
    ((): Plugin => ({
      name: "at-alias",
      async resolveId(source, importer) {
        if (!source.startsWith("@/") || !importer) return null;
        const rest = source.slice(2);
        let base: string;
        if (importer.includes("/convex-embedded/")) base = embeddedSrc;
        else if (importer.includes("/convex-resolve/")) base = resolveSrc;
        else return null;
        const resolved = await this.resolve(path.join(base, rest), importer, {
          skipSelf: true,
        });
        return resolved ?? null;
      },
    }))(),
  ],
  resolve: {
    alias: {
      "#embedded": embeddedSrc,
      "#resolve": resolveSrc,
      "#fx": fxSrc,
      "@robelest/fx": path.join(fxSrc, "index.ts"),
      // Integration tests: resolve workspace package exports to source
      "@robelest/convex-resolve/server": path.join(
        resolveSrc,
        "server/index.ts",
      ),
      "@robelest/convex-resolve/client": path.join(
        resolveSrc,
        "client/index.ts",
      ),
      "@robelest/convex-resolve/convex.config": path.join(
        resolveSrc,
        "component/convex.config.ts",
      ),
      "@robelest/convex-resolve/test": path.join(resolveSrc, "test.ts"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "fx",
          include: ["fx/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "embedded",
          include: ["embedded/**/*.test.ts"],
          testTimeout: 10_000,
        },
      },
      {
        extends: true,
        test: {
          name: "resolve",
          include: ["resolve/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["integration/**/*.test.ts"],
          environment: "edge-runtime",
        },
      },
    ],
  },
});
