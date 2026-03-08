import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "convex-resolve/server": path.resolve(
        __dirname,
        "../../packages/convex-resolve/src/server/index.ts",
      ),
      "convex-resolve/client": path.resolve(
        __dirname,
        "../../packages/convex-resolve/src/client/index.ts",
      ),
      "convex-resolve/convex.config": path.resolve(
        __dirname,
        "../../packages/convex-resolve/src/component/convex.config.ts",
      ),
      "convex-resolve/test": path.resolve(
        __dirname,
        "../../packages/convex-resolve/src/test.ts",
      ),
    },
  },
});
