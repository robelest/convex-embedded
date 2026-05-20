import { convexEmbeddedUnplugin } from "@/unplugin";
import type { ConvexEmbeddedPluginOptions } from "@/unplugin";

export type { ConvexEmbeddedPluginOptions };

export function convexEmbedded(options?: ConvexEmbeddedPluginOptions): any {
  return convexEmbeddedUnplugin.vite(options);
}

export default convexEmbedded;
