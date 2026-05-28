/**
 * @robelest/convex-embedded
 *
 * Lightweight embedded Convex runtime for local-first applications.
 * Runs locally in-memory and syncs on-demand against a remote Convex
 * deployment. The root package exposes framework-agnostic runtime and
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
  createEmbeddedRuntime,
  type EmbeddedRuntime,
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

export { createAuthResolver, getIdentityKey } from "@/auth";
export type { AuthResolver, UserIdentity } from "@/auth";

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

export type { SqliteDriver, SqliteStatement } from "@/storage/sqlite/driver";

export {
  createSubscriptionManager,
  type SubscriptionManager,
} from "@/replication/subscriptions";

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
export {
  createDefaultWorkScheduler,
  type WorkPriority,
  type WorkScheduler,
} from "@/shared/work";

export {
  convexEmbeddedCollectionOptions,
  type ConvexEmbeddedCollectionOptions,
  type ConvexEmbeddedCollectionMutationRefs,
} from "@/client/optimistic";

export { localOnly, remoteOnly, storageUploadUrl } from "@/server/markers";

export { withSpan, withSpanSync, getTracer } from "@/tracing/spans";
export { installInMemoryTracing } from "@/tracing/memory";
export type {
  BufferedSpan,
  BufferingTracingHandle,
  InMemoryTracingOptions,
} from "@/tracing/memory";
