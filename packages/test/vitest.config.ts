import path from "path";

import type { Plugin } from "vite-plus";
import { defineConfig } from "vite-plus";

const embeddedSrc = path.resolve(import.meta.dirname, "../convex-embedded/src");
const fxSrc = path.resolve(import.meta.dirname, "../fx/src");
const convexApp = path.resolve(import.meta.dirname, "../../convex");

export default defineConfig({
  plugins: [
    ((): Plugin => ({
      name: "at-alias",
      async resolveId(source: string, importer: string | undefined) {
        if (!source.startsWith("@/") || !importer) return null;
        const rest = source.slice(2);
        let base: string;
        if (importer.includes("/convex-embedded/")) base = embeddedSrc;
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
      "#resolve": embeddedSrc,
      "#fx": fxSrc,
      "@robelest/fx": path.join(fxSrc, "index.ts"),
      // Integration tests: resolve workspace package exports to source
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
      "#convex": convexApp,
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
