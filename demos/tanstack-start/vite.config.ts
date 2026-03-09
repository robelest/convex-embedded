import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Load .env.local from the monorepo root
  envDir: "../..",
  // Expose CONVEX_* env vars to client code (Vite defaults to VITE_* only)
  envPrefix: ["VITE_", "CONVEX_"],
  // Target modern browsers that support top-level await
  build: {
    target: "esnext",
  },
  server: {
    port: 3000,
  },
  plugins: [
    tsConfigPaths(),
    tailwindcss(),
    tanstackStart({
      spa: { enabled: true },
    }),
    // React's Vite plugin must come after Start's Vite plugin
    viteReact(),
  ],
});
