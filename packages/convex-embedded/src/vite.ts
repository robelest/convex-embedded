import { convexEmbeddedUnplugin } from "@/unplugin";
import type { ConvexEmbeddedPluginOptions } from "@/unplugin";

export type { ConvexEmbeddedPluginOptions };

export function convexEmbedded(
  options?: ConvexEmbeddedPluginOptions,
): ReturnType<typeof convexEmbeddedUnplugin.vite> {
  return convexEmbeddedUnplugin.vite(options);
}

export default convexEmbedded;
