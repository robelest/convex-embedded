import {
  devtools,
  type TanStackDevtoolsViteConfig,
} from "@tanstack/devtools-vite";

export type EmbeddedDevtoolsViteConfig = TanStackDevtoolsViteConfig;

export function embeddedDevtools(
  config: EmbeddedDevtoolsViteConfig = {},
): ReturnType<typeof devtools> {
  return devtools({ removeDevtoolsOnBuild: true, ...config });
}
