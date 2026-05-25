import {
  TanStackDevtoolsCore,
  type TanStackDevtoolsConfig,
} from "@tanstack/devtools";
import type { ConvexClient } from "convex/browser";

import { createEmbeddedDevtoolsSource } from "@/devtools/core/source";
import type { EmbeddedDevtoolsSource } from "@/devtools/core/types";
import { mountDevtoolsApp } from "@/devtools/ui/app";

export interface MountEmbeddedDevtoolsOptions {
  position?: TanStackDevtoolsConfig["position"];
  defaultOpen?: boolean;
  source?: EmbeddedDevtoolsSource;
  target?: HTMLElement;
}

export interface MountedEmbeddedDevtools {
  unmount(): void;
}

export function mountEmbeddedDevtools(
  client: ConvexClient,
  options: MountEmbeddedDevtoolsOptions = {},
): MountedEmbeddedDevtools {
  const ownsSource = options.source === undefined;
  const source = options.source ?? createEmbeddedDevtoolsSource(client);
  let appCleanup: (() => void) | null = null;

  const config: Partial<TanStackDevtoolsConfig> = {};
  if (options.position !== undefined) {
    config.position = options.position;
  }
  if (options.defaultOpen !== undefined) {
    config.defaultOpen = options.defaultOpen;
  }

  const disposeApp = (): void => {
    if (appCleanup) {
      appCleanup();
      appCleanup = null;
    }
  };

  const core = new TanStackDevtoolsCore({
    config,
    plugins: [
      {
        id: "convex-embedded",
        name: "Convex Embedded",
        render: (el) => {
          disposeApp();
          appCleanup = mountDevtoolsApp(el, source);
        },
        destroy: disposeApp,
      },
    ],
  });

  const target = options.target ?? document.body;
  const host = document.createElement("div");
  target.appendChild(host);
  core.mount(host);

  return {
    unmount: () => {
      disposeApp();
      core.unmount();
      host.remove();
      if (ownsSource) {
        source.dispose();
      }
    },
  };
}
