import path from "path";

import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

const embeddedRoot = path.resolve(
  import.meta.dirname,
  "../../packages/convex-embedded",
);
const embeddedSrc = path.resolve(
  import.meta.dirname,
  "../../packages/convex-embedded/src",
);

export default defineConfig(({ command }) => ({
  plugins: [tailwindcss(), sveltekit()],
  envDir: "../..",
  envPrefix: ["VITE_", "CONVEX_"],
  build: {
    target: "esnext",
  },
  worker: {
    format: "es",
  },
  resolve: {
    alias: [
      ...(command === "build"
        ? []
        : [
            { find: /^@\//, replacement: embeddedSrc + "/" },
            {
              find: "@robelest/convex-embedded/browser",
              replacement: embeddedSrc + "/browser/index.ts",
            },
            {
              find: "@robelest/convex-embedded/worker",
              replacement: embeddedSrc + "/browser/sqlite/worker.ts",
            },
            {
              find: "@robelest/convex-embedded/server/table",
              replacement: embeddedSrc + "/server/table.ts",
            },
            {
              find: "@robelest/convex-embedded/server/fields",
              replacement: embeddedSrc + "/server/fields.ts",
            },
            {
              find: "@robelest/convex-embedded/server",
              replacement: embeddedSrc + "/server/index.ts",
            },
            {
              find: "@robelest/convex-embedded/crdt",
              replacement: embeddedSrc + "/crdt/index.ts",
            },
            {
              find: "@robelest/convex-embedded/client",
              replacement: embeddedSrc + "/client/index.ts",
            },
            {
              find: "@robelest/convex-embedded/convex.config",
              replacement: embeddedSrc + "/component/convex.config.ts",
            },
            {
              find: "@robelest/convex-embedded/test",
              replacement: embeddedSrc + "/test.ts",
            },
            {
              find: "@robelest/convex-embedded",
              replacement: embeddedSrc + "/index.ts",
            },
          ]),
      {
        find: "$convex",
        replacement: path.resolve(import.meta.dirname, "../../convex"),
      },
    ],
  },
  server: {
    port: 3000,
    fs: {
      allow: ["../../..", embeddedRoot],
    },
  },
}));
