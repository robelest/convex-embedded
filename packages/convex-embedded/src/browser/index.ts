/**
 * Browser entry point for `@robelest/convex-embedded/browser`.
 *
 * Provides a single `createEmbeddedClient()` factory that wires up
 * the embedded runtime and returns a ready-to-use `ConvexClient`.
 *
 * @example
 * ```ts
 * import { createEmbeddedClient } from "@robelest/convex-embedded/browser";
 *
 * const client = createEmbeddedClient({
 *   modules: import.meta.glob("./convex/** /*.ts"),
 *   schema,
 * });
 * ```
 *
 * @packageDocumentation
 */

import { ConvexClient } from "convex/browser";
import type { BaseConvexClientOptions } from "convex/browser";
import { EmbeddedRuntime } from "@/runtime/embedded";
import type { EmbeddedRuntimeOptions } from "@/runtime/embedded";
import { createTransport } from "@/runtime/transport";

// ---------------------------------------------------------------------------
// Persistence adapter (interface-only for now)
// ---------------------------------------------------------------------------

/**
 * Storage backend for persisting embedded runtime state.
 *
 * Modeled after Replicate's `StorageAdapter` — a minimal key/value
 * interface over opaque byte buffers. Implementations can target
 * IndexedDB, OPFS via wa-sqlite, or any other browser storage.
 */
export interface PersistenceAdapter {
  /** Read a value by key. Returns `undefined` if not found. */
  get(key: string): Promise<Uint8Array | undefined>;
  /** Write a value by key. */
  set(key: string, value: Uint8Array): Promise<void>;
  /** Delete a value by key. */
  delete(key: string): Promise<void>;
  /** List all keys matching the given prefix. */
  keys(prefix: string): Promise<string[]>;
  /** Optional cleanup hook (e.g. close database connection). */
  close?(): void;
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

/** Options for {@link createEmbeddedClient}. */
export interface EmbeddedClientOptions {
  /** Vite `import.meta.glob` record pointing at your Convex modules. */
  modules: EmbeddedRuntimeOptions["modules"];
  /** Optional Convex schema definition (default export from `schema.ts`). */
  schema?: EmbeddedRuntimeOptions["schema"];
  /**
   * Options forwarded to the underlying `ConvexClient` constructor.
   * `webSocketConstructor` is always overridden by the embedded transport.
   */
  clientOptions?: Omit<
    Partial<BaseConvexClientOptions>,
    "webSocketConstructor"
  >;
  /**
   * Optional persistence adapter for durable storage.
   * When omitted the runtime is purely in-memory.
   */
  persistence?: PersistenceAdapter;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// Allow Convex server functions to be imported in the browser.
// The SDK guards against this to prevent accidental secret leakage,
// but the embedded runtime intentionally runs functions client-side.
(globalThis as Record<string, unknown>).__convexAllowFunctionsInBrowser =
  true;

/**
 * Create a `ConvexClient` backed by a fully in-memory embedded runtime.
 *
 * This is the primary browser entry point. It:
 * 1. Creates an {@link EmbeddedRuntime} from the provided modules/schema.
 * 2. Builds a loopback transport (no network).
 * 3. Returns a standard `ConvexClient` connected to that transport.
 *
 * @returns A `ConvexClient` that talks to the local embedded runtime.
 */
export function createEmbeddedClient(
  options: EmbeddedClientOptions,
): ConvexClient {
  const runtime = new EmbeddedRuntime({
    modules: options.modules,
    schema: options.schema,
  });

  const transport = createTransport(runtime);

  return new ConvexClient(transport.url, {
    ...options.clientOptions,
    // The loopback constructor satisfies the runtime contract but not the
    // full `typeof WebSocket` type (missing static constants). Safe to cast.
    webSocketConstructor:
      transport.webSocketConstructor as unknown as typeof WebSocket,
    unsavedChangesWarning: false,
  });
}

// ---------------------------------------------------------------------------
// Singleton helper
// ---------------------------------------------------------------------------

let _singleton: ConvexClient | null = null;

/**
 * Get (or create) a singleton `ConvexClient` backed by the embedded runtime.
 *
 * On the first call the client is created from `options` and cached.
 * Subsequent calls return the same instance (options are ignored).
 *
 * @example
 * ```ts
 * import { getEmbeddedClient } from "@robelest/convex-embedded/browser";
 *
 * const client = getEmbeddedClient({
 *   modules: import.meta.glob("./convex/*.ts"),
 * });
 * ```
 */
export function getEmbeddedClient(
  options: EmbeddedClientOptions,
): ConvexClient {
  if (!_singleton) {
    _singleton = createEmbeddedClient(options);
  }
  return _singleton;
}
