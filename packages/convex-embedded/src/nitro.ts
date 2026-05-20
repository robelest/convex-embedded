import { generateEmbeddedRegistry } from "@/codegen";
import type { ConvexEmbeddedPluginOptions } from "@/unplugin";

export type { ConvexEmbeddedPluginOptions };

type NitroLike = {
  options?: { rootDir?: string; workspaceDir?: string };
  hooks?: {
    hook?: (name: string, fn: () => Promise<void> | void) => void;
  };
};

function nitroRoot(nitro: NitroLike): string {
  return nitro.options?.rootDir ?? nitro.options?.workspaceDir ?? process.cwd();
}

export function convexEmbeddedNitro(options: ConvexEmbeddedPluginOptions = {}) {
  return {
    name: "convex-embedded",
    async setup(nitro: NitroLike) {
      const run = async () => {
        await generateEmbeddedRegistry({
          convexDir: options.convexDir ?? "./convex",
          outFile: options.out ?? "./convex/_generated/embedded.ts",
          cwd: nitroRoot(nitro),
        });
      };

      await run();
      nitro.hooks?.hook?.("compiled", run);
      nitro.hooks?.hook?.("dev:reload", run);
    },
  };
}

export default convexEmbeddedNitro;
