/**
 * @robelest/convex-embedded
 *
 * Lightweight embedded Convex runtime for local-first applications.
 * Runs entirely in-memory — no network, no backend. Presents the
 * standard ConvexClient / ConvexReactClient API so existing Convex
 * apps can point at a local runtime with zero code changes.
 *
 * @example
 * ```ts
 * import { createEmbeddedConvex } from "@robelest/convex-embedded";
 * import { ConvexReactClient } from "convex/react";
 *
 * const embedded = createEmbeddedConvex({
 *   modules: import.meta.glob("./convex/** /*.ts"),
 *   schema,
 * });
 *
 * const { url, webSocketConstructor } = embedded.createTransport();
 * const client = new ConvexReactClient(url, { webSocketConstructor });
 * ```
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export {
  EmbeddedRuntime,
  type EmbeddedRuntimeOptions,
} from "@/runtime/embedded";

export { createTransport } from "@/runtime/transport";
export type { EmbeddedTransport } from "@/runtime/transport";

export {
  LoopbackWebSocket,
  LoopbackWebSocketConstructor,
} from "@/runtime/loopback-ws";

export type {
  LoopbackEvent,
  LoopbackOpenEvent,
  LoopbackMessageEvent,
  LoopbackCloseEvent,
  LoopbackErrorEvent,
} from "@/runtime/loopback-ws";

export { WriteFanout } from "@/runtime/write-fanout";

export { AuthResolver, createTestIdentity } from "@/auth/resolver";
export type { UserIdentity } from "@/auth/resolver";

export type {
  StorageAdapter,
  CommitBatch,
  DatabaseMeta,
} from "@/storage/adapter";

export { ephemeralStorage } from "@/storage/memory";

export { SubscriptionManager } from "@/sync/subscriptions";

export { SystemPaths } from "@/kernel/system-functions";

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

import {
  EmbeddedRuntime,
  type EmbeddedRuntimeOptions,
} from "@/runtime/embedded";

/**
 * Create an embedded Convex runtime.
 *
 * This is the primary entry point. Pass the result of
 * `import.meta.glob` pointing at your Convex modules, and optionally
 * your schema definition.
 *
 * @param options.modules  Vite `import.meta.glob("./convex/** /*.ts")` record.
 * @param options.schema   Default export from your `convex/schema.ts`.
 * @returns An {@link EmbeddedRuntime} instance.
 */
export function createEmbeddedConvex(
  options: EmbeddedRuntimeOptions,
): EmbeddedRuntime {
  return new EmbeddedRuntime(options);
}
