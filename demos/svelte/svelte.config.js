import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: "index.html",
    }),
    alias: {
      "@/*": "../../packages/convex-embedded/src/*",
      "@": "../../packages/convex-embedded/src",
      "$convex/*": "../../convex/*",
      "@robelest/convex-embedded/browser":
        "../../packages/convex-embedded/src/browser/index.ts",
      "@robelest/convex-embedded/worker":
        "../../packages/convex-embedded/src/browser/wa-sqlite-worker.ts",
      "@robelest/convex-embedded/server":
        "../../packages/convex-embedded/src/server/index.ts",
      "@robelest/convex-embedded/crdt":
        "../../packages/convex-embedded/src/crdt/index.ts",
      "@robelest/convex-embedded/client":
        "../../packages/convex-embedded/src/client/index.ts",
      "@robelest/convex-embedded/convex.config":
        "../../packages/convex-embedded/src/component/convex.config.ts",
      "@robelest/convex-embedded/test":
        "../../packages/convex-embedded/src/test.ts",
      "@robelest/convex-embedded":
        "../../packages/convex-embedded/src/index.ts",
    },
    typescript: {
      config: (config) => {
        config.include.push("../../../convex/**/*.ts");
        config.include.push("../../../convex/**/*.d.ts");
        return config;
      },
    },
  },
};

export default config;
