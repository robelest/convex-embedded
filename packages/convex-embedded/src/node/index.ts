/**
 * Node entry point for `@robelest/convex-embedded/node`.
 *
 * This surface mirrors the browser embedded client while wiring in
 * Node-native sqlite storage for restart-safe local state and replay.
 *
 * @packageDocumentation
 */

import type { BaseConvexClientOptions } from "convex/browser";

import type { AuthOptions, AuthState } from "@/client/auth";
import { createEmbeddedClient } from "@/client/factory";
import type { Prefetch } from "@/client/prefetch";
import type { RemoteOptions, RemoteState } from "@/client/remote";
import type { ConvexInput } from "@/kernel/modules";
import { createNodePlatformAdapter } from "@/node/platform";
import { openNodeStorage } from "@/node/sqlite/adapter";
import type {
  ConnectivityAdapter,
  ProcessorIdentity,
} from "@/runtime/platform";

export type { AuthOptions, AuthState, RemoteOptions, RemoteState };
export type { ConvexInput } from "@/kernel/modules";
export { createNodePlatformAdapter, openNodeStorage };
export { createNodeWorkScheduler } from "@/node/work";
export type { NodePlatformOptions } from "@/node/platform";

export interface ClientOptions {
  convex: ConvexInput;
  schema?: unknown;
  clientOptions?: Omit<
    Partial<BaseConvexClientOptions>,
    "webSocketConstructor"
  >;
  name?: string;
  remote?: RemoteOptions;
  auth?: AuthOptions;
  prefetch?: Prefetch;
  databasePath?: string;
  connectivity?: ConnectivityAdapter;
  processorIdentity?: ProcessorIdentity;
}

export function createConvexClient(options: ClientOptions) {
  const platform = createNodePlatformAdapter({
    databasePath: options.databasePath,
    connectivity: options.connectivity,
    processorIdentity: options.processorIdentity,
  });
  return createEmbeddedClient({ options, platform });
}
