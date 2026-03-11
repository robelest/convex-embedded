/**
 * Browser entry point for `@robelest/convex-embedded/browser`.
 *
 * Provides a single {@link createConvexClient} factory that sets up an
 * embedded Convex runtime and returns a standard `ConvexClient`. The
 * returned client is indistinguishable from a normal Convex client —
 * it works with `useQuery`, `ConvexProvider`, `convex-svelte`, and any
 * other Convex framework integration out of the box.
 *
 * ## Architecture
 *
 * - **EmbeddedRuntime** runs on the **main thread** via a loopback
 *   WebSocket transport. This is required because Convex function
 *   modules (from `import.meta.glob`) contain non-cloneable `Function`
 *   and `Proxy` objects that cannot cross a `postMessage` boundary.
 *
 * - **wa-sqlite** runs in a **Dedicated Worker** for persistence.
 *   Only plain JSON data (documents, metadata) and `ArrayBuffer`s
 *   (blobs) cross the worker boundary.
 *
 * - **Cross-tab sync** uses `WriteFanout` (`BroadcastChannel`) plus
 *   a shared IndexedDB database name.
 *
 * - **Remote sync** (optional) uses `@robelest/convex-resolve` — a
 *   Yjs CRDT-based resolve engine that reconciles offline changes
 *   on reconnect, plus reactive query subscriptions for live updates.
 *
 * ## Public API
 *
 * | Symbol | Kind | Description |
 * |--------|------|-------------|
 * | {@link createConvexClient} | Factory | Create an embedded `ConvexClient` |
 * | {@link getResolveState} | Accessor | Read current sync state |
 * | {@link subscribeResolveState} | Subscription | Observe sync state changes |
 * | {@link ClientOptions} | Interface | Options for the factory |
 * | {@link ResolveOptions} | Interface | Sync-specific options |
 * | {@link ResolveState} | Type | Sync state discriminated union |
 *
 * @example
 * ```ts
 * import { createConvexClient } from "@robelest/convex-embedded/browser";
 *
 * const client = createConvexClient({
 *   modules: import.meta.glob("./convex/*.ts"),
 *   sync: { url: "https://happy-otter-123.convex.cloud" },
 * });
 * ```
 *
 * @packageDocumentation
 */

import { Fx } from "@robelest/fx";
import { ConvexClient } from "convex/browser";
import type { BaseConvexClientOptions } from "convex/browser";

import { compileWasmModule } from "@/browser/preload";
import { openWaSqliteStorage } from "@/browser/wa-sqlite";
import type { ConvexModule } from "@/kernel/module-loader";
import { EmbeddedRuntime } from "@/runtime/embedded";
import type { EmbeddedRuntimeOptions } from "@/runtime/embedded";

// Re-export preloading utilities (public).
export {
  CDN_BASE,
  WASM_URL,
  preloadLinks,
  injectPreloadLinks,
  compileWasmModule,
} from "@/browser/preload";

// ---------------------------------------------------------------------------
// Public interfaces & types
// ---------------------------------------------------------------------------

/**
 * Configuration for remote sync (resolve).
 *
 * When provided as the `sync` option to {@link createConvexClient}, the
 * client automatically syncs with the remote Convex deployment — mutations
 * are local-first with durable queue and remote replay, and reactive
 * subscriptions keep the local database up-to-date with changes from
 * other clients.
 *
 * @remarks
 * **Naming**: "Resolve" refers to the CRDT-based reconciliation that
 * happens when a client reconnects after being offline. While online,
 * data flows through standard reactive query subscriptions — resolve is
 * only invoked for offline catch-up. The name aligns with the
 * `@robelest/convex-resolve` package.
 *
 * **Retry behaviour**: Both `maxRetries` and `retryDelayMs` control
 * the retry policy for the Yjs CRDT resolve pass on reconnect (not for
 * normal reactive subscription delivery, which the Convex SDK handles
 * automatically).
 *
 * @example
 * ```ts
 * // Minimal — just a deployment URL
 * const client = createConvexClient({
 *   modules,
 *   sync: { url: "https://happy-otter-123.convex.cloud" },
 * });
 * ```
 *
 * @example
 * ```ts
 * // Custom retry policy for unreliable networks
 * const client = createConvexClient({
 *   modules,
 *   sync: {
 *     url: import.meta.env.CONVEX_URL,
 *     maxRetries: 5,
 *     retryDelayMs: 2000,
 *   },
 * });
 * ```
 *
 * @see {@link createConvexClient} — The factory that consumes this config.
 * @see {@link ResolveState} — Observable state of the sync engine.
 *
 * @category Configuration
 */
export interface ResolveOptions {
  /**
   * URL of the remote Convex deployment.
   *
   * This is the same URL used by `ConvexClient` in a standard (non-embedded)
   * Convex app — typically from your Convex dashboard or `.env` file.
   */
  url: string;

  /**
   * Maximum retries for the CRDT resolve pass on reconnect.
   *
   * @default 3
   */
  maxRetries?: number;

  /**
   * Base delay between retries in milliseconds. Actual delays use
   * exponential back-off with jitter starting from this value.
   *
   * @default 1000
   */
  retryDelayMs?: number;
}

/**
 * Options for {@link createConvexClient}.
 *
 * @remarks
 * The only required option is `modules` — everything else has sensible
 * defaults. Add `sync` to enable local-first mode with a remote Convex
 * deployment; omit it for a purely local embedded database.
 *
 * **Module discovery**: The `modules` map must come from Vite's
 * `import.meta.glob` (lazy variant, not `{ eager: true }`). The
 * embedded runtime inspects each module's exports to find Convex
 * function definitions and — when sync is enabled — `__syncMeta`
 * constants exported by `register()`.
 *
 * **Persistence**: By default, documents are persisted to IndexedDB
 * via a wa-sqlite worker. Tabs sharing the same `name` share the same
 * data and receive cross-tab updates via `BroadcastChannel`.
 *
 * @example
 * ```ts
 * // Minimal — local-only, no sync
 * const client = createConvexClient({
 *   modules: import.meta.glob("./convex/*.ts"),
 * });
 * ```
 *
 * @example
 * ```ts
 * // Local-first with remote sync
 * const client = createConvexClient({
 *   modules: import.meta.glob("./convex/*.ts"),
 *   sync: { url: import.meta.env.CONVEX_URL },
 * });
 * ```
 *
 * @see {@link createConvexClient} — The factory that consumes these options.
 * @see {@link ResolveOptions} — Sync-specific configuration.
 *
 * @category Configuration
 */
export interface ClientOptions {
  /**
   * Lazy module map pointing at your Convex functions.
   *
   * Must be the return value of `import.meta.glob` **without**
   * `{ eager: true }` — each entry is a lazy `() => Promise<Module>`
   * loader. The runtime loads modules on demand during function
   * execution and scans for `__syncMeta` exports during sync setup.
   *
   * @example
   * ```ts
   * import.meta.glob("./convex/*.ts")
   * ```
   */
  modules: Record<string, () => Promise<unknown>>;

  /**
   * Optional Convex schema definition (the default export from your
   * `convex/schema.ts`). When provided, the runtime validates documents
   * against the schema at write time.
   */
  schema?: unknown;

  /**
   * Options forwarded to the underlying `ConvexClient` constructor.
   *
   * @remarks
   * `webSocketConstructor` is always overridden by the embedded
   * loopback transport — any value you provide here is ignored.
   */
  clientOptions?: Omit<
    Partial<BaseConvexClientOptions>,
    "webSocketConstructor"
  >;

  /**
   * URL of the wa-sqlite worker script.
   *
   * @remarks
   * In most setups this resolves automatically. Override only when
   * using a custom build pipeline that moves worker scripts.
   *
   * @internal
   */
  workerUrl?: URL | string;

  /**
   * IndexedDB database name. Tabs sharing the same name share the
   * same persisted data and receive cross-tab updates via
   * `BroadcastChannel`.
   *
   * @default "convex-embedded"
   */
  name?: string;

  /**
   * Enable remote sync with a Convex deployment.
   *
   * @remarks
   * When provided, the client becomes **local-first**: mutations write
   * to the local embedded database instantly, then replay to the remote
   * deployment via a durable queue. Reactive subscriptions on the remote
   * keep local state fresh with changes from other clients. On reconnect
   * after offline, a CRDT resolve pass merges any state that diverged.
   *
   * Requires `@robelest/convex-resolve` as a peer/optional dependency.
   * If the package is not installed, a helpful error is logged and
   * sync is silently disabled.
   *
   * @see {@link ResolveOptions}
   */
  sync?: ResolveOptions;
}

/**
 * Describes the current resolve state of a client created with
 * {@link createConvexClient}.
 *
 * The state machine transitions are:
 *
 * ```
 *  idle → connecting → syncing → synced
 *                        ↑         ↓
 *                     offline ←────┘
 *                        ↓
 *                      error (after max retries)
 * ```
 *
 * @remarks
 * **`idle`** — Sync was not configured (no `sync` option), or the engine
 * has not started yet (module discovery still in progress).
 *
 * **`connecting`** — The remote `ConvexClient` is establishing its
 * WebSocket connection to the Convex deployment.
 *
 * **`syncing`** — The CRDT resolve pass is in progress. When available,
 * `progress` reports how many tables have been resolved so far.
 *
 * **`synced`** — All tables are resolved and reactive subscriptions are
 * active. This is the normal steady-state while online.
 *
 * **`offline`** — Network is unavailable. Mutations continue to work
 * (written locally, queued for replay). The engine will re-resolve
 * automatically when connectivity returns.
 *
 * **`error`** — The resolve pass failed after exhausting retries.
 * The `error` property contains the underlying `Error`. The engine
 * will attempt recovery on the next connectivity change.
 *
 * @example
 * ```ts
 * const unsub = subscribeResolveState(client, (state) => {
 *   switch (state.status) {
 *     case "synced":  badge.textContent = "Online"; break;
 *     case "offline": badge.textContent = "Offline"; break;
 *     case "syncing": badge.textContent = `Syncing ${state.progress?.completed ?? 0}/${state.progress?.total ?? "?"}...`; break;
 *     case "error":   badge.textContent = `Error: ${state.error?.message}`; break;
 *   }
 * });
 * ```
 *
 * @see {@link getResolveState} — Read the current state once.
 * @see {@link subscribeResolveState} — Subscribe to state transitions.
 *
 * @category Type
 */
export type ResolveState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "syncing"; progress?: { completed: number; total: number } }
  | { status: "synced" }
  | { status: "offline" }
  | { status: "error"; error?: Error };

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
 * Create a `ConvexClient` backed by the local embedded Convex runtime.
 *
 * Returns a standard {@link https://docs.convex.dev/api/classes/browser.ConvexClient | ConvexClient}
 * that works with `ConvexProvider`, `convex-svelte`, or any Convex
 * framework integration — no wrapper objects, no special mutation calls.
 *
 * @remarks
 * **How it works**: The factory creates an {@link EmbeddedRuntime} on the
 * main thread, connects it to a `ConvexClient` via a loopback WebSocket
 * transport, and initialises wa-sqlite persistence in a Dedicated Worker.
 * From the outside, the returned client behaves identically to a normal
 * `ConvexClient` connected to a remote deployment.
 *
 * **Without `sync`**: Purely local. Queries and mutations run against
 * an in-browser database persisted to IndexedDB via wa-sqlite. No
 * network traffic.
 *
 * **With `sync`**: Local-first with transparent remote sync:
 * - Queries read from the local embedded database (instant, offline-capable).
 * - `client.mutation(...)` writes locally first (instant), then replays
 *   to the remote deployment via a durable queue.
 * - Reactive subscriptions on the remote keep local state fresh with
 *   changes from other clients in real time.
 * - On reconnect, a Yjs CRDT resolve pass merges any state that diverged
 *   while offline.
 *
 * **Module auto-discovery**: Sync metadata is discovered automatically
 * from your Convex modules — any module that exports `__syncMeta` (from
 * `register()`) is enrolled for sync. No manual table configuration.
 *
 * **Lifecycle**: Call `client.close()` to tear down the runtime, worker,
 * resolve engine, and all subscriptions. In SvelteKit, do this in
 * `onDestroy` and `import.meta.hot?.dispose`.
 *
 * @example
 * ```ts
 * // SvelteKit layout — create client and provide to component tree
 * import { createConvexClient } from "@robelest/convex-embedded/browser";
 * import { setConvexClientContext } from "convex-svelte";
 * import { onDestroy } from "svelte";
 *
 * const client = createConvexClient({
 *   modules: import.meta.glob("./convex/*.ts"),
 *   sync: { url: import.meta.env.CONVEX_URL },
 * });
 *
 * setConvexClientContext(client);
 * onDestroy(() => client.close());
 * ```
 *
 * @example
 * ```ts
 * // React — create client and provide via ConvexProvider
 * import { createConvexClient } from "@robelest/convex-embedded/browser";
 * import { ConvexProvider } from "convex/react";
 *
 * const client = createConvexClient({
 *   modules: import.meta.glob("./convex/*.ts"),
 *   sync: { url: import.meta.env.CONVEX_URL },
 * });
 *
 * function App() {
 *   return (
 *     <ConvexProvider client={client}>
 *       <MyApp />
 *     </ConvexProvider>
 *   );
 * }
 * ```
 *
 * @example
 * ```ts
 * // Local-only (no sync) — useful for prototyping or offline-only apps
 * const client = createConvexClient({
 *   modules: import.meta.glob("./convex/*.ts"),
 * });
 * ```
 *
 * @param options - Client configuration. See {@link ClientOptions}.
 * @returns A standard `ConvexClient` instance. When `sync` is configured,
 *          `client.mutation()` is patched for local-first writes and
 *          `client.close()` tears down the resolve engine.
 *
 * @see {@link ClientOptions} — All available options.
 * @see {@link ResolveOptions} — Sync-specific configuration.
 * @see {@link getResolveState} — Read the sync state.
 * @see {@link subscribeResolveState} — Observe sync state changes.
 *
 * @category Factory
 */
export function createConvexClient(options: ClientOptions): ConvexClient {
  const dbName = options.name ?? "convex-embedded";

  const modules = options.modules as Record<
    string,
    () => Promise<ConvexModule>
  >;

  // 1. Create the runtime (in-memory, no storage yet)
  const runtime = new EmbeddedRuntime({
    modules,
    schema: options.schema as EmbeddedRuntimeOptions["schema"],
  });

  // 2. Set the hydration gate before creating transport/client
  const storageReady = openStorage(runtime, dbName, options.workerUrl);
  runtime.setHydrationGate(storageReady);

  // 3. Create transport + client synchronously
  const transport = runtime.createTransport();

  const client = new ConvexClient(transport.url, {
    ...options.clientOptions,
    webSocketConstructor:
      transport.webSocketConstructor as unknown as typeof WebSocket,
    unsavedChangesWarning: false,
  });

  // 4. If sync is configured, attach resolve engine internally
  if (options.sync) {
    _attachResolve(client, runtime, options.sync, modules);
  } else {
    // Even without sync, patch close() to tear down the runtime
    const originalClose = client.close.bind(client);
    (client as any).close = function patchedClose(): void {
      runtime.shutdown();
      void originalClose();
    };
  }

  return client;
}

// ---------------------------------------------------------------------------
// Resolve state accessors
// ---------------------------------------------------------------------------

/**
 * Get the current resolve state of a client.
 *
 * Returns `{ status: "idle" }` if the client was created without
 * `sync`, if sync has not started yet, or if the client was not
 * created by {@link createConvexClient}.
 *
 * @remarks
 * This is a point-in-time read. For reactive UI updates, use
 * {@link subscribeResolveState} instead — it fires a callback on
 * every state transition.
 *
 * The function uses a `WeakMap` lookup keyed on the client instance,
 * so it is O(1) and does not retain references to closed clients.
 *
 * @example
 * ```ts
 * import { createConvexClient, getResolveState } from "@robelest/convex-embedded/browser";
 *
 * const client = createConvexClient({ modules, sync: { url } });
 *
 * // Later, check state before performing an action
 * const state = getResolveState(client);
 * if (state.status === "synced") {
 *   console.log("All tables are up to date");
 * }
 * ```
 *
 * @example
 * ```ts
 * // Safe to call on any ConvexClient — returns idle for non-embedded clients
 * const state = getResolveState(someClient);
 * // state is { status: "idle" }
 * ```
 *
 * @param client - A `ConvexClient`, typically created by {@link createConvexClient}.
 * @returns The current {@link ResolveState}.
 *
 * @see {@link subscribeResolveState} — Reactive alternative.
 * @see {@link ResolveState} — The state union type.
 *
 * @category Resolve
 */
export function getResolveState(client: ConvexClient): ResolveState {
  return _resolveEntries.get(client)?.state ?? { status: "idle" };
}

/**
 * Subscribe to resolve state changes on a client.
 *
 * The callback fires whenever the resolve state transitions (e.g.
 * `offline → syncing → synced`). Returns an unsubscribe function.
 *
 * @remarks
 * The callback is invoked **synchronously** on each state transition.
 * If your callback performs expensive work (DOM updates, network calls),
 * consider debouncing or batching inside the callback.
 *
 * Returns a **no-op unsubscribe** if the client was created without
 * `sync` or was not created by {@link createConvexClient}. This makes
 * it safe to call unconditionally in framework lifecycle hooks.
 *
 * The subscription is automatically cleaned up when `client.close()`
 * is called — the `WeakMap` entry is deleted, and outstanding listeners
 * are dropped. You do not *need* to call the unsubscribe function on
 * close, but it is harmless to do so.
 *
 * @example
 * ```ts
 * // Svelte — reactive sync status indicator
 * import { createConvexClient, subscribeResolveState } from "@robelest/convex-embedded/browser";
 * import { onDestroy } from "svelte";
 *
 * const client = createConvexClient({ modules, sync: { url } });
 * let syncStatus = $state("idle");
 *
 * const unsub = subscribeResolveState(client, (state) => {
 *   syncStatus = state.status;
 * });
 * onDestroy(unsub);
 * ```
 *
 * @example
 * ```ts
 * // React — sync status in a custom hook
 * function useSyncStatus(client: ConvexClient) {
 *   const [status, setStatus] = useState<ResolveState["status"]>("idle");
 *   useEffect(() => {
 *     return subscribeResolveState(client, (s) => setStatus(s.status));
 *   }, [client]);
 *   return status;
 * }
 * ```
 *
 * @param client - A `ConvexClient`, typically created by {@link createConvexClient}.
 * @param callback - Called on each resolve state transition with the new
 *                   {@link ResolveState}.
 * @returns An unsubscribe function. Call it to stop receiving updates.
 *
 * @see {@link getResolveState} — One-shot read of the current state.
 * @see {@link ResolveState} — The state union type.
 *
 * @category Resolve
 */
export function subscribeResolveState(
  client: ConvexClient,
  callback: (state: ResolveState) => void,
): () => void {
  const entry = _resolveEntries.get(client);
  if (!entry) return () => {};
  entry.listeners.add(callback);
  return () => entry.listeners.delete(callback);
}

// ---------------------------------------------------------------------------
// Internal resolve wiring
// ---------------------------------------------------------------------------

/** @internal WeakMap associating clients with their resolve engine + state. */
const _resolveEntries = new WeakMap<ConvexClient, ResolveEntry>();

interface ResolveEntry {
  engine: EngineInstance | null;
  state: ResolveState;
  listeners: Set<(state: ResolveState) => void>;
}

/** @internal Duck-typed resolve engine instance (avoids hard dep on convex-resolve). */
interface EngineInstance {
  mutation(ref: any, args: any): Promise<any>;
  on(event: string, cb: (status: any) => void): void;
  start(): void;
  stop(): void;
}

/**
 * @internal
 * Dynamically import the resolve engine from `@robelest/convex-resolve`.
 * Uses a Vite-ignored dynamic import so the dependency remains optional.
 */
async function _loadEngine(): Promise<any> {
  try {
    // @robelest/convex-resolve is a peer/optional dependency
    const mod = await import(
      /* @vite-ignore */ "@robelest/convex-resolve/client"
    );
    return (mod as any).engine ?? (mod as any).syncEngine ?? (mod as any).monitor;
  } catch {
    console.error(
      "[convex-embedded] sync requires @robelest/convex-resolve. " +
        "Install it: npm install @robelest/convex-resolve",
    );
    return null;
  }
}

/**
 * @internal
 * Attach a resolve engine to a ConvexClient. Discovers sync metadata from
 * modules, creates the engine, patches client.mutation for local-first
 * writes, and starts the engine.
 */
function _attachResolve(
  client: ConvexClient,
  runtime: EmbeddedRuntime,
  resolveOpts: ResolveOptions,
  modules: Record<string, () => Promise<ConvexModule>>,
): void {
  const remoteClient = new ConvexClient(resolveOpts.url);

  // Capture the original, unpatched mutation BEFORE we patch it below.
  // The engine calls this for local writes — if it called the patched
  // version, it would recurse infinitely (patched → engine → patched → …).
  const originalMutation = client.mutation.bind(client);

  const embedded = {
    client,
    ingestDocuments: runtime.ingestDocuments.bind(runtime),
    getDocumentsForTable: runtime.getDocumentsForTable.bind(runtime),
    queryDirect: runtime.queryDirect.bind(runtime),
    // System bypass — runs _system:* mutations (IdMap, PendingQueue)
    // directly against the embedded database, completely bypassing the
    // ConvexClient session/version counter. Prevents Transition races.
    mutationDirect: runtime.mutationDirect.bind(runtime),
    // User bypass — the original, unpatched ConvexClient.mutation().
    // Still routes through the loopback WebSocket (so useQuery updates)
    // but avoids infinite recursion through patchedMutation.
    localMutation: originalMutation as (
      ref: unknown,
      args: Record<string, unknown>,
    ) => Promise<unknown>,
  };

  // Discover sync metadata will happen async after modules load.
  // For now create with empty tables — will be populated before start.
  const entry: ResolveEntry = {
    engine: null,
    state: { status: "idle" },
    listeners: new Set(),
  };

  _resolveEntries.set(client, entry);

   // Discover sync metadata from modules, then create + start engine
   _discoverAndStart(entry, embedded, remoteClient, resolveOpts, modules);

  // Patch client.mutation for local-first writes
  (client as any).mutation = async function patchedMutation(
    ...args: Parameters<typeof client.mutation>
  ): Promise<any> {
    // If engine is ready, route through it (local-first + queue)
    if (entry.engine) {
      return entry.engine.mutation(args[0], (args[1] ?? {}) as any);
    }
    // Fallback: direct local mutation (engine not ready yet)
    return originalMutation(...args);
  };

  // Patch client.close for cleanup
  const originalClose = client.close.bind(client);
  (client as any).close = async function patchedClose(): Promise<void> {
    if (entry.engine) {
      entry.engine.stop();
    }
    _resolveEntries.delete(client);
    remoteClient.close();
    runtime.shutdown();
    return originalClose();
  };
}

/**
 * @internal
 * Scan loaded modules for __syncMeta exports, build TableConfig map,
 * create the resolve engine, wire status listener, and start.
 */
async function _discoverAndStart(
  entry: ResolveEntry,
  embedded: {
    client: ConvexClient;
    ingestDocuments: (
      table: string,
      documents: Array<Record<string, unknown>>,
    ) => Promise<void>;
    getDocumentsForTable: (
      table: string,
    ) => Promise<Array<Record<string, unknown>>>;
  },
  remoteClient: ConvexClient,
  resolveOpts: ResolveOptions,
  modules: Record<string, () => Promise<ConvexModule>>,
): Promise<void> {
  // Load the resolve engine dynamically
  const engineFactory = await _loadEngine();
  if (!engineFactory) return;

  // Load all modules and scan for sync metadata (tagged via Symbol).
  // The resolve export from register() carries SyncMeta on a well-known
  // Symbol — no separate __syncMeta export needed.
  const SYNC_META = Symbol.for("convex-resolve:syncMeta");
  const tables: Record<
    string,
    { resolve: string; query: string; schema?: unknown }
  > = {};

  for (const [path, loader] of Object.entries(modules)) {
    // Skip _generated and non-function modules
    if (path.includes("_generated")) continue;

    try {
      const mod = await loader();

      // Scan all exports for any that carry the SYNC_META symbol.
      // Convex's query() builder returns a Function (via dontCallDirectly),
      // so we must check both "object" and "function" types.
      for (const exportValue of Object.values(mod as Record<string, any>)) {
        if (!exportValue || (typeof exportValue !== "object" && typeof exportValue !== "function")) continue;
        const meta = (exportValue as any)[SYNC_META];
        if (meta && meta.__brand === "convex-resolve:syncMeta") {
          // Build the function references from the module path
          // Module path looks like "./convex/tasks.ts" — extract "tasks"
          const moduleName = path
            .replace(/^.*\//, "") // strip directory
            .replace(/\.[^.]+$/, ""); // strip extension

          const resolveRef = `${moduleName}:${meta.resolveExport}`;
          const listRef = meta.listExport
            ? `${moduleName}:${meta.listExport}`
            : `${moduleName}:list`;

          tables[meta.table] = {
            resolve: resolveRef,
            query: listRef,
            schema: meta.schema,
          };
          break; // One sync table per module
        }
      }
    } catch {
      // Module failed to load — skip silently
    }
  }

  if (Object.keys(tables).length === 0) {
    console.warn(
      "[convex-embedded] sync enabled but no sync metadata found in modules. " +
        "Make sure your Convex modules export the resolve query from register().",
    );
    return;
  }

  // Create the engine
  const engine: EngineInstance = engineFactory.create({
    embedded,
    remoteClient,
    tables,
    maxRetries: resolveOpts.maxRetries,
    retryDelayMs: resolveOpts.retryDelayMs,
  });

  entry.engine = engine;

  // Wire status changes
  engine.on("change", (monitorStatus: any) => {
    const mapped = _mapStatus(monitorStatus);
    entry.state = mapped;
    for (const cb of entry.listeners) {
      try {
        cb(mapped);
      } catch {
        /* listener error */
      }
    }
  });

  engine.start();
}

/** @internal Map internal MonitorStatus to public {@link ResolveState}. */
function _mapStatus(s: any): ResolveState {
  if (!s) return { status: "idle" };
  switch (s.status) {
    case "resolving":
      return {
        status: "syncing",
        progress: s.progress
          ? { completed: s.progress.completed, total: s.progress.total }
          : undefined,
      };
    case "resolved":
      return { status: "synced" };
    case "error":
      return { status: "error", error: s.error };
    case "offline":
      return { status: "offline" };
    default:
      return { status: "idle" };
  }
}

// ---------------------------------------------------------------------------
// Storage initialisation (internal)
// ---------------------------------------------------------------------------

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
 *
 * Uses `Fx.gen` to compose the 4-step pipeline (compile WASM →
 * create wa-sqlite storage → attach to database → hydrate) with an
 * `Fx.recover` fallback to in-memory.
 */
function openStorage(
  runtime: EmbeddedRuntime,
  name: string,
  workerUrl?: URL | string,
): Promise<void> {
  const pipeline = Fx.gen(function* () {
    // Step 1: Compile the WASM module.
    const wasmModule = yield* Fx.from({
      ok: () => compileWasmModule(),
      err: (err) => err as Error,
    });

    if (!wasmModule) {
      // SSR or non-browser environment — skip persistence.
      console.debug(
        "[convex-embedded] WASM not available, skipping persistence",
      );
      return;
    }

    // Step 2: Create the wa-sqlite storage adapter (worker init).
    const storage = yield* Fx.from({
      ok: () => openWaSqliteStorage({ name, wasmModule, workerUrl }),
      err: (err) => err as Error,
    });

    // Step 3: Attach the storage adapter to the database for persistence.
    runtime.db.setStorage(storage);

    // Step 4: Hydrate — load all persisted documents, metadata, and blobs
    // from IndexedDB into the in-memory database.
    yield* Fx.from({
      ok: () => runtime.db.hydrate(),
      err: (err) => err as Error,
    });

    console.debug("[convex-embedded] wa-sqlite storage ready");
  });

  // Catch all errors — the runtime falls back to in-memory.
  const safe = pipeline.pipe(
    Fx.recover(() =>
      Fx.sync(() => {
        console.error(
          "[convex-embedded] wa-sqlite storage init failed, continuing in-memory",
        );
      }),
    ),
  );

  return Fx.run(safe);
}
