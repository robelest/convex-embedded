import path from "node:path";

import { createUnplugin, type UnpluginInstance } from "unplugin";

import {
  generateEmbeddedRegistry,
  type GenerateEmbeddedRegistryInput,
} from "@/codegen";
import { watchCodegen, type WatchCodegenHandle } from "@/codegen/watch";

export interface ConvexEmbeddedPluginOptions {
  /** Path to the Convex source directory. Defaults to `./convex`. */
  convexDir?: string;
  /** Path to the generated registry file. Defaults to `./convex/_generated/embedded.ts`. */
  out?: string;
  /** Module ID(s) to resolve to the generated registry file. */
  importId?: string | string[];
  /** Disable file watching in dev/server mode. */
  watch?: boolean;
}

export type ConvexEmbeddedUnplugin = Pick<
  UnpluginInstance<ConvexEmbeddedPluginOptions | undefined>,
  "vite" | "webpack" | "rspack" | "esbuild" | "rollup" | "rolldown"
>;

const DEFAULT_CONVEX_DIR = "./convex";
const DEFAULT_OUT_FILE = "./convex/_generated/embedded.ts";
const DEFAULT_IMPORT_ID = "$convex/_generated/embedded";

function codegenInput(
  options: ConvexEmbeddedPluginOptions,
  cwd: string,
): GenerateEmbeddedRegistryInput {
  return {
    convexDir: options.convexDir ?? DEFAULT_CONVEX_DIR,
    outFile: options.out ?? DEFAULT_OUT_FILE,
    cwd,
  };
}

function normalizeId(id: string): string {
  return id.split(path.sep).join("/");
}

const unplugin = createUnplugin((options: ConvexEmbeddedPluginOptions = {}) => {
  let root = process.cwd();
  let watcher: WatchCodegenHandle | null = null;
  const importIds = new Set(
    Array.isArray(options.importId)
      ? options.importId
      : [options.importId ?? DEFAULT_IMPORT_ID],
  );

  const run = () => generateEmbeddedRegistry(codegenInput(options, root));
  const outFile = () => path.resolve(root, options.out ?? DEFAULT_OUT_FILE);
  const resolvesGeneratedRegistry = (id: string) => {
    if (importIds.has(id)) return true;
    const normalized = normalizeId(id);
    return normalized.endsWith("/_generated/embedded");
  };

  return {
    name: "convex-embedded:codegen",
    enforce: "pre" as const,

    resolveId: async (id) => {
      if (!resolvesGeneratedRegistry(id)) return null;
      await run();
      return outFile();
    },

    buildStart: async () => {
      await run();
    },

    vite: {
      async configResolved(config) {
        root = config.root;
        await run();
      },
      async configureServer() {
        if (options.watch === false) {
          return;
        }
        watcher = await watchCodegen({
          ...codegenInput(options, root),
          onError: (error) => {
            console.error("[convex-embedded] codegen watch failed:", error);
          },
        });
      },
    },

    webpack(compiler) {
      root = compiler.context || root;
      compiler.hooks.beforeCompile.tapPromise(
        "convex-embedded:codegen",
        async () => {
          await run();
        },
      );
      compiler.hooks.watchRun.tapPromise(
        "convex-embedded:codegen",
        async () => {
          await run();
        },
      );
    },

    rspack(compiler) {
      root = compiler.context || root;
      compiler.hooks.beforeCompile.tapPromise(
        "convex-embedded:codegen",
        async () => {
          await run();
        },
      );
      compiler.hooks.watchRun.tapPromise(
        "convex-embedded:codegen",
        async () => {
          await run();
        },
      );
    },

    closeBundle() {
      watcher?.close();
      watcher = null;
    },
  };
});

export const convexEmbeddedUnplugin = unplugin as ConvexEmbeddedUnplugin;
export const convexEmbedded = convexEmbeddedUnplugin;
export default convexEmbeddedUnplugin;
