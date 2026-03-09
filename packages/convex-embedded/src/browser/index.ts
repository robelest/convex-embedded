/**
 * Browser entry point for `@robelest/convex-embedded/browser`.
 *
 * Provides a single {@link createClient} factory that sets up the
 * embedded Convex runtime and returns a standard `ConvexClient`.
 *
 * Architecture:
 * - **EmbeddedRuntime** runs on the **main thread** via a loopback
 *   WebSocket transport. This is required because Convex function
 *   modules (from `import.meta.glob`) contain non-cloneable Function
 *   and Proxy objects that cannot cross a `postMessage` boundary.
 *
 * - **wa-sqlite** runs in a **Dedicated Worker** for persistence.
 *   Only plain JSON data (documents, metadata) and `ArrayBuffer`s
 *   (blobs) cross the worker boundary.
 *
 * - **Cross-tab sync** uses `WriteFanout` (`BroadcastChannel`) plus
 *   a shared IndexedDB database name.
 *
 * @example
 * ```ts
 * import { createClient } from "@robelest/convex-embedded/browser";
 *
 * const client = createClient({
 *   modules: import.meta.glob("./convex/*.ts"),
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
import type { ConvexModule } from "@/kernel/module-loader";
import { createWaSqliteStorage } from "@/browser/wa-sqlite";
import { compileWasmModule } from "@/browser/preload";

// Re-export storage types so consumers can implement custom adapters.
export type {
  StorageAdapter,
  CommitBatch,
  DatabaseMeta,
} from "@/storage/adapter";

export { memoryStorage } from "@/storage/memory";

// Re-export preloading utilities.
export {
  CDN_BASE,
  WASM_URL,
  preloadLinks,
  injectPreloadLinks,
  compileWasmModule,
} from "@/browser/preload";

// Re-export wa-sqlite storage factory (for advanced use).
export { createWaSqliteStorage } from "@/browser/wa-sqlite";
export type { WaSqliteStorageOptions } from "@/browser/wa-sqlite";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for {@link createClient}. */
export interface ClientOptions {
  /**
   * Lazy module map pointing at your Convex functions.
   *
   * Use `import.meta.glob` (without `{ eager: true }`) so each module
   * is a lazy `() => Promise<...>` loader:
   *
   * @example
   * ```ts
   * import.meta.glob("./convex/*.ts")
   * ```
   */
  modules: Record<string, () => Promise<unknown>>;

  /** Optional Convex schema definition (default export from `schema.ts`). */
  schema?: unknown;

  /**
   * Options forwarded to the underlying `ConvexClient` constructor.
   * `webSocketConstructor` is always overridden by the embedded transport.
   */
  clientOptions?: Omit<
    Partial<BaseConvexClientOptions>,
    "webSocketConstructor"
  >;

  /**
   * URL of the wa-sqlite worker script.
   *
   * In development (Vite), resolve via:
   * ```ts
   * new URL("@robelest/convex-embedded/worker", import.meta.url)
   * ```
   *
   * In production the default (`./wa-sqlite-worker.js` relative to this
   * module) resolves correctly from the built package.
   */
  workerUrl?: URL | string;

  /**
   * IndexedDB database name. Tabs sharing the same name share the
   * same persisted data (cross-tab sync via `BroadcastChannel`).
   *
   * @default "convex-embedded"
   */
  name?: string;
}

// ---------------------------------------------------------------------------
// Allow Convex server functions to be imported in the browser.
// The SDK guards against this to prevent accidental secret leakage,
// but the embedded runtime intentionally runs functions client-side.
// This must be set before any Convex modules are imported.
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).__convexAllowFunctionsInBrowser = true;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `ConvexClient` backed by the embedded Convex runtime.
 *
 * The runtime runs on the **main thread** (required because Convex
 * function modules contain non-cloneable Function/Proxy objects).
 * wa-sqlite persistence runs in a Dedicated Worker.
 *
 * This function is **synchronous** — the wa-sqlite worker and module
 * loading happen in the background. The `ConvexClient` connects as
 * soon as the runtime is ready, exactly like connecting to a remote
 * Convex deployment.
 *
 * @returns A standard `ConvexClient` — use it with `convex-svelte`,
 *   `convex/react`, or any other Convex integration unchanged.
 */
export function createClient(options: ClientOptions): ConvexClient {
  const dbName = options.name ?? "convex-embedded";

  // Cast the lazy module map to the shape EmbeddedRuntime expects.
  const modules = options.modules as Record<
    string,
    () => Promise<ConvexModule>
  >;

  // 1. Create the runtime immediately (in-memory, no storage yet) ----------
  const runtime = new EmbeddedRuntime({
    modules,
    schema: options.schema as EmbeddedRuntimeOptions["schema"],
  });

  // 2. Set the hydration gate BEFORE creating the transport/client ---------
  //    This ensures handleMessage() waits for wa-sqlite to initialise and
  //    hydrate before processing any ConvexClient messages. Without this,
  //    queries would run against an empty in-memory database and return
  //    empty results before persisted data is loaded.
  const storageReady = initStorage(runtime, dbName, options.workerUrl);
  runtime.setHydrationGate(storageReady);

  // 3. Create transport + client synchronously ----------------------------
  //    The ConvexClient immediately sends Connect + ModifyQuerySet, but
  //    handleMessage() awaits the hydration gate, so those messages are
  //    queued until wa-sqlite is ready and data is loaded from IndexedDB.
  const transport = runtime.createTransport();

  const client = new ConvexClient(transport.url, {
    ...options.clientOptions,
    webSocketConstructor:
      transport.webSocketConstructor as unknown as typeof WebSocket,
    unsavedChangesWarning: false,
  });

  return client;
}

/**
 * Initialise wa-sqlite storage and hydrate the database.
 *
 * This promise is used as the hydration gate — `handleMessage()` in the
 * runtime awaits it before processing any ConvexClient messages. This
 * ensures queries run against data loaded from IndexedDB, not an empty
 * in-memory database.
 *
 * If WASM compilation or worker init fails, the promise still resolves
 * (the runtime continues as in-memory-only, no persistence).
 */
async function initStorage(
  runtime: EmbeddedRuntime,
  name: string,
  workerUrl?: URL | string,
): Promise<void> {
  try {
    const wasmModule = await compileWasmModule();
    if (!wasmModule) {
      // SSR or non-browser environment — skip persistence.
      console.debug("[convex-embedded] WASM not available, skipping persistence");
      return;
    }

    const storage = await createWaSqliteStorage({
      name,
      wasmModule,
      workerUrl,
    });

    // Attach the storage adapter to the database for persistence.
    runtime.db.setStorage(storage);

    // Hydrate: load all persisted documents, metadata, and blobs from
    // IndexedDB into the in-memory database.
    await runtime.db.hydrate();

    console.debug("[convex-embedded] wa-sqlite storage ready");
  } catch (err) {
    // Resolve (don't reject) — the runtime falls back to in-memory.
    console.error(
      "[convex-embedded] wa-sqlite storage init failed, continuing in-memory:",
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _client: ConvexClient | null = null;

/**
 * Get (or create) a singleton `ConvexClient` backed by the embedded runtime.
 *
 * On the first call the client is created from `options` and cached.
 * Subsequent calls return the same instance (options are ignored).
 *
 * This is the recommended entry point for frameworks like SvelteKit
 * where the client must be created synchronously during component
 * initialisation:
 *
 * @example
 * ```ts
 * // +layout.svelte
 * import { getClient } from "@robelest/convex-embedded/browser";
 * import { setConvexClientContext } from "convex-svelte";
 *
 * setConvexClientContext(
 *   getClient({
 *     modules: import.meta.glob("./convex/*.ts"),
 *     schema,
 *   }),
 * );
 * ```
 */
export function getClient(options: ClientOptions): ConvexClient {
  if (!_client) {
    _client = createClient(options);
  }
  return _client;
}
