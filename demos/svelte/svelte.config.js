import path from "node:path";

import adapter from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    alias: {
      "$convex/_generated/embedded": path.resolve(
        "./src/lib/generated/embedded.ts",
      ),
      $convex: path.resolve("./../../convex"),
    },
    typescript: {
      config: (config) => {
        config.include.push("../../../convex/**/*.ts");
        config.include.push("../../../convex/**/*.d.ts");
        return config;
      },
    },
  },
  vitePlugin: {
    dynamicCompileOptions: ({ filename }) =>
      filename.includes("node_modules") ? undefined : { runes: true },
  },
};

export default config;
