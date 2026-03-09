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
} from "./runtime/embedded.js";

export { createTransport } from "./runtime/transport.js";
export type { EmbeddedTransport } from "./runtime/transport.js";

export {
  LoopbackWebSocket,
  LoopbackWebSocketConstructor,
} from "./runtime/loopback-ws.js";

export type {
  LoopbackEvent,
  LoopbackOpenEvent,
  LoopbackMessageEvent,
  LoopbackCloseEvent,
  LoopbackErrorEvent,
} from "./runtime/loopback-ws.js";

export { WriteFanout } from "./runtime/write-fanout.js";

export { AuthResolver, createTestIdentity } from "./auth/resolver.js";
export type { UserIdentity } from "./auth/resolver.js";

export { BlobStore } from "./storage/blob-store.js";

export { SubscriptionManager } from "./sync/subscriptions.js";

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

import {
  EmbeddedRuntime,
  type EmbeddedRuntimeOptions,
} from "./runtime/embedded.js";

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
