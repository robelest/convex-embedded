import { convexEmbeddedUnplugin } from "@/unplugin";
import type { ConvexEmbeddedPluginOptions } from "@/unplugin";

export type { ConvexEmbeddedPluginOptions };

type NextConfig = Record<string, unknown> & {
  webpack?: (config: { plugins?: unknown[] }, context: unknown) => unknown;
};

export function withConvexEmbedded<TConfig extends NextConfig>(
  config: TConfig = {} as TConfig,
  options: ConvexEmbeddedPluginOptions = {},
): TConfig {
  const previousWebpack = config.webpack;

  return {
    ...config,
    webpack(nextWebpackConfig: { plugins?: unknown[] }, context: unknown) {
      const resolved =
        previousWebpack?.(nextWebpackConfig, context) ?? nextWebpackConfig;
      const mutable = resolved as { plugins?: unknown[] };
      mutable.plugins = [
        ...(mutable.plugins ?? []),
        convexEmbeddedUnplugin.webpack(options),
      ];
      return mutable;
    },
  };
}

export default withConvexEmbedded;
