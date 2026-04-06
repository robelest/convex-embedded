/**
 * @robelest/convex-embedded
 *
 * Lightweight embedded Convex runtime for local-first applications.
 * Runs locally in-memory and can be seeded from a remote-backed replica for
 * SSR/bootstrap flows. The root package exposes framework-agnostic runtime and
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
} from "@/runtime/loopback";

export type {
  LoopbackEvent,
  LoopbackOpenEvent,
  LoopbackMessageEvent,
  LoopbackCloseEvent,
  LoopbackErrorEvent,
} from "@/runtime/loopback";

export type { ConvexModuleRegistry } from "@/kernel/modules";

export { AuthResolver, createTestIdentity } from "@/auth/resolver";
export type { UserIdentity } from "@/auth/resolver";

export type {
  StorageAdapter,
  CommitBatch,
  DatabaseMeta,
} from "@/storage/adapter";

export { ephemeralStorage } from "@/storage/memory";

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

// ---------------------------------------------------------------------------
// Runtime and client factories
// ---------------------------------------------------------------------------

import {
  EmbeddedRuntime,
  type EmbeddedRuntimeOptions,
} from "@/runtime/embedded";

/**
 * Create an embedded Convex runtime.
 *
 * This is the primary entry point. Pass a lazy ESM registry keyed by your
 * Convex module ids, optionally your schema definition, and optionally a
 * remote-backed replica for SSR/bootstrap.
 *
 * @param options.modules  Lazy ESM registry keyed by canonical module id.
 * @param options.schema   Default export from your `convex/schema.ts`.
 * @param options.replica  Optional replica created by `createReplica(...)`.
 * @returns An {@link EmbeddedRuntime} instance.
 *
 * @see createReplica
 * @category Factory
 */
export function createEmbeddedRuntime(
  options: EmbeddedRuntimeOptions,
): EmbeddedRuntime {
  return new EmbeddedRuntime(options);
}
