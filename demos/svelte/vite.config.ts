import path from "path";

import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

const embeddedSrc = path.resolve(
  __dirname,
  "../../packages/convex-embedded/src",
);

export default defineConfig({
  plugins: [sveltekit()],
  build: {
    target: "esnext",
  },
  resolve: {
    alias: [
      // Resolve @/ path alias inside embedded package source.
      { find: /^@\//, replacement: embeddedSrc + "/" },
      // Resolve workspace package subpath exports to source.
      {
        find: "@robelest/convex-embedded/browser",
        replacement: embeddedSrc + "/browser/index.ts",
      },
      {
        find: "@robelest/convex-embedded/worker",
        replacement: embeddedSrc + "/browser/wa-sqlite-worker.ts",
      },
      {
        find: "@robelest/convex-embedded",
        replacement: embeddedSrc + "/index.ts",
      },
    ],
  },
  server: {
    port: 3000,
    fs: {
      allow: ["../../.."],
    },
  },
});
