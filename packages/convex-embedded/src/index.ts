/**
 * @robelest/convex-embedded
 *
 * Lightweight embedded Convex runtime for local-first applications.
 * Runs locally in-memory and can be seeded from remote-backed prefetch data for
 * SSR/prefetch flows. The root package exposes framework-agnostic runtime and
 * client primitives rather than a React-specific wrapper.
 *
 * The root package also exports the platform-agnostic client factory and
 * platform adapter interfaces used by environment-specific wrappers.
 *
 * @example
 * ```ts
 * import { createEmbeddedRuntime } from "@robelest/convex-embedded";
 * import { modules } from "./convex-modules";
 *
 * const embedded = createEmbeddedRuntime({
 *   modules,
 *   schema,
 * });
 *
 * const { url, webSocketConstructor } = embedded.createTransport();
 * const client = new ConvexClient(url, { webSocketConstructor });
 * ```
 *
 * @packageDocumentation
 */

export {
  EmbeddedRuntime,
  type EmbeddedRuntimeOptions,
} from "@/runtime/embedded";

export { createTransport } from "@/runtime/transport";
export type { EmbeddedTransport } from "@/runtime/transport";

export {
  LoopbackWebSocket,
  LoopbackWebSocketConstructor,
} from "@/runtime/loopback";

export type {
  LoopbackEvent,
  LoopbackOpenEvent,
  LoopbackMessageEvent,
  LoopbackCloseEvent,
  LoopbackErrorEvent,
} from "@/runtime/loopback";

export type {
  ConvexInput,
  ConvexManifest,
  ConvexModuleRegistry,
} from "@/kernel/modules";

export { AuthResolver, getIdentityKey } from "@/auth";
export type { UserIdentity } from "@/auth";

export {
  type StorageAdapter,
  type QueryableAdapter,
  isQueryable,
  SqliteAdapter,
  type WriteBatch,
  type StorageMetadata,
  type WriteOptions,
  type WriteResult,
  type QueryArgs,
  type VectorSearchArgs,
} from "@/storage";

export type {
  SqliteDriver,
  SqliteStatement,
} from "@/storage/sqlite/driver";

export { SubscriptionManager } from "@/sync/subscriptions";

export { SystemPaths } from "@/kernel/system";

export type {
  SessionBroadcast,
  WriteBroadcast,
  ConnectivityAdapter,
  ProcessorIdentity,
  EmbeddedPlatformAdapter,
} from "@/runtime/platform";
export { createNoopWriteBroadcast } from "@/runtime/platform";
export type { EmbeddedCryptoProvider } from "@/runtime/crypto";
export { createAmbientCryptoProvider } from "@/runtime/crypto";
export {
  createEmbeddedClient,
  type EmbeddedClientOptions,
} from "@/client/factory";

export { withSpan, withSpanSync, getTracer } from "@/tracing/spans";
export { installInMemoryTracing } from "@/tracing/memory";
export type {
  BufferedSpan,
  BufferingTracingHandle,
  InMemoryTracingOptions,
} from "@/tracing/memory";

import {
  EmbeddedRuntime,
  type EmbeddedRuntimeOptions,
} from "@/runtime/embedded";

/**
 * Create an embedded Convex runtime.
 *
 * This is the primary entry point. Pass a lazy ESM registry keyed by your
 * Convex module ids, optionally your schema definition, and optionally a
 * remote-backed prefetch data for SSR/prefetch.
 *
 * @param options.modules  Lazy ESM registry keyed by canonical module id.
 * @param options.schema   Default export from your `convex/schema.ts`.
 * @param options.prefetch Optional prefetch data created by `createEmbeddedPrefetch(...)`.
 * @returns An {@link EmbeddedRuntime} instance.
 *
 * @see createEmbeddedPrefetch
 * @category Factory
 */
export function createEmbeddedRuntime(
  options: EmbeddedRuntimeOptions,
): EmbeddedRuntime {
  return new EmbeddedRuntime(options);
}
