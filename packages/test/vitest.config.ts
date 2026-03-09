import { defineConfig } from "vitest/config";
import path from "path";

const embeddedSrc = path.resolve(__dirname, "../convex-embedded/src");
const resolveSrc = path.resolve(__dirname, "../convex-resolve/src");

export default defineConfig({
  resolve: {
    alias: {
      "#embedded": embeddedSrc,
      "#resolve": resolveSrc,
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
