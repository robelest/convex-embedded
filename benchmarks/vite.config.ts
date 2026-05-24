import path from "path";

import { defineConfig } from "vite-plus";

const embeddedSrc = path.resolve(
  import.meta.dirname,
  "../packages/convex-embedded/src",
);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: embeddedSrc + "/" },
      { find: "@embedded", replacement: embeddedSrc },
      { find: "@resolve", replacement: embeddedSrc },
      {
        find: "@tests/testkit",
        replacement: path.resolve(import.meta.dirname, "testkit.ts"),
      },
      {
        find: "@tests/helpers",
        replacement: path.resolve(import.meta.dirname, "../tests/helpers"),
      },
    ],
  },
  test: {
    benchmark: {
      include: ["**/*.bench.ts"],
    },
  },
});
