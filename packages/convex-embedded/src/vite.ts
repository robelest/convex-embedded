import { runCodegen, type RunCodegenInput } from "@/cli/codegen";
import { watchCodegen, type WatchCodegenHandle } from "@/cli/watch";

export interface ConvexEmbeddedVitePluginOptions {
  /** Path to the Convex source directory. Defaults to `./convex`. */
  convexDir?: string;
  /**
   * Path to the generated registry file. Defaults to
   * `./convex/_generated/embedded.ts`.
   */
  out?: string;
}

interface VitePluginShape {
  name: string;
  configResolved?: (config: { root: string }) => Promise<void> | void;
  buildStart?: () => Promise<void> | void;
  closeBundle?: () => Promise<void> | void;
  configureServer?: (server: { httpServer?: unknown }) => Promise<void> | void;
}

/**
 * Vite plugin that auto-runs `convex-embedded codegen` on dev start
 * and re-runs it on file events from the dev server's watcher.
 *
 * Usage:
 *
 * ```ts
 * // vite.config.ts
 * import { convexEmbedded } from "@robelest/convex-embedded/vite";
 *
 * export default defineConfig({
 *   plugins: [convexEmbedded()],
 * });
 * ```
 */
export function convexEmbedded(
  options: ConvexEmbeddedVitePluginOptions = {},
): VitePluginShape {
  const convexDir = options.convexDir ?? "./convex";
  const out = options.out ?? "./convex/_generated/embedded.ts";

  let projectRoot = process.cwd();
  let watchHandle: WatchCodegenHandle | null = null;
  let isDev = false;

  return {
    name: "convex-embedded:codegen",

    configResolved(config) {
      projectRoot = config.root;
    },

    async buildStart() {
      const input: RunCodegenInput = {
        convexDir,
        outFile: out,
        cwd: projectRoot,
      };
      await runCodegen(input);
    },

    async configureServer() {
      isDev = true;
      const input: RunCodegenInput = {
        convexDir,
        outFile: out,
        cwd: projectRoot,
      };
      // Initial run handled by buildStart; here we hook the watcher.
      try {
        watchHandle = await watchCodegen({
          ...input,
          onError: (err) => {
            // eslint-disable-next-line no-console
            console.error(
              "[convex-embedded] codegen watch failed:",
              err,
            );
          },
        });
      } catch (err) {
        // Watch not supported on this platform; fall back to initial-run-only
        // eslint-disable-next-line no-console
        console.warn(
          "[convex-embedded] file watching unavailable; codegen will not auto-update during dev:",
          err,
        );
      }
    },

    async closeBundle() {
      if (isDev && watchHandle) {
        watchHandle.close();
        watchHandle = null;
      }
    },
  };
}

// Conventional default export for `import x from "@robelest/convex-embedded/vite"`
export default convexEmbedded;
