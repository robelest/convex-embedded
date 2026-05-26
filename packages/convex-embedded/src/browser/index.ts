/**
 * Browser entry point for `@robelest/convex-embedded/browser`.
 *
 * Provides a browser-specific wrapper around the core embedded client
 * factory. It wires the browser platform adapter into the core runtime and
 * returns a standard `ConvexClient`. The returned client is framework agnostic:
 * use it directly or through framework adapters such as `convex-svelte`.
 *
 * ## Architecture
 *
 * - **EmbeddedRuntime** runs on the **main thread** via a loopback
 *   WebSocket transport. This is required because Convex function
 *   modules (from the lazy ESM registry) contain non-cloneable `Function`
 *   and `Proxy` objects that cannot cross a `postMessage` boundary.
 *
 * - **SQLite via OPFS** runs in a **Dedicated Worker** for durable storage.
 *   Only plain JSON data (documents, metadata) and `ArrayBuffer`s
 *   (blobs) cross the worker boundary.
 *
 * - **Cross-context propagation** uses the browser platform broadcast layer
 *   (`BroadcastChannel` / `storage` events) plus a shared persistent database name.
 *
 * - **Remote connection** (optional) uses the built-in Yjs CRDT-based resolve
 *   engine that reconciles offline changes on reconnect, plus reactive
 *   query subscriptions for live updates.
 *
 * ## Public API
 *
 * | Symbol | Kind | Description |
 * |--------|------|-------------|
 * | {@link createConvexClient} | Factory | Create a browser-backed embedded `ConvexClient` |
 * | {@link createBrowserPlatformAdapter} | Factory | Create the browser platform adapter |
 * | {@link getAuthState} | Accessor | Read current embedded auth state |
 * | {@link subscribeAuthState} | Subscription | Observe embedded auth state changes |
 * | {@link getRemoteState} | Accessor | Read current remote state |
 * | {@link subscribeRemoteState} | Subscription | Observe remote state changes |
 * | {@link AuthOptions} | Interface | Embedded auth configuration |
 * | {@link AuthState} | Type | Auth state discriminated union |
 * | {@link ClientOptions} | Interface | Options for the factory |
 * | {@link RemoteOptions} | Interface | Sync-specific options |
 * | {@link RemoteState} | Type | Sync state discriminated union |
 *
 * @example
 * ```ts
 * import { createConvexClient } from "@robelest/convex-embedded/browser";
 * import { convex } from "./convex";
 *
 * const client = createConvexClient({
 *   convex,
 *   remote: { url: "https://happy-otter-123.convex.cloud" },
 * });
 * ```
 *
 * @packageDocumentation
 */

import { ConvexClient } from "convex/browser";
import type { BaseConvexClientOptions } from "convex/browser";

import {
  registerBrowserDebugClient,
  unregisterBrowserDebugClient,
} from "@/browser/debug";
import {
  clearBrowserLocalData,
  createBrowserPlatformAdapter,
} from "@/browser/platform";
import { type AuthOptions, type AuthState } from "@/client/auth";
import { createEmbeddedClient } from "@/client/factory";
import { type RemoteOptions, type RemoteState } from "@/client/remote";
import { type ConvexInput } from "@/kernel/modules";

export type { ConvexInput } from "@/kernel/modules";

/**
 * Auth and remote sync types re-exported for convenience from the browser
 * entrypoint.
 *
 * Use `RemoteOptions` as the `remote` field inside {@link ClientOptions}, and
 * use `RemoteState` / `AuthState` with the corresponding browser subscription
 * helpers.
 */
export type { AuthOptions, AuthState, RemoteOptions, RemoteState };

/**
 * Options for {@link createConvexClient}.
 *
 * @remarks
 * The only required option is `convex` — everything else has sensible
 * defaults. Add `remote` to enable local-first mode with a remote Convex
 * deployment; omit it for a purely local embedded database.
 *
 * **Module discovery**: The `convex.modules` map must be an enumerable lazy ESM
 * registry keyed by canonical Convex module ids such as `tasks` or
 * `lib/utils`. The embedded runtime inspects each module's exports to find Convex
 * function definitions and — when remote is enabled — `remote metadata`
 * constants exported by `register()`.
 *
 * **Storage**: By default, documents are persisted to OPFS
 * via a dedicated sqlite worker. Tabs sharing the same `name` share the same
 * data and receive cross-tab updates via `BroadcastChannel`.
 *
 * @example
 * ```ts
 * // Minimal — local-only, no remote
 * const client = createConvexClient({
 *   convex,
 * });
 * ```
 *
 * @example
 * ```ts
 * // Local-first with remote
 * const client = createConvexClient({
 *   convex,
 *   remote: { url: import.meta.env.CONVEX_URL },
 * });
 * ```
 *
 * @see {@link createConvexClient} — The factory that consumes these options.
 * @see {@link RemoteOptions} — Remote connection configuration.
 *
 * @category Configuration
 */
export interface ClientOptions {
  /**
   * Lazy ESM registry pointing at your Convex functions.
   *
   * Each key must be the canonical Convex module id (for example `tasks`
   * or `lib/utils`) and each value must be a lazy `() => Promise<Module>`
   * loader. The runtime loads modules on demand during function
   * execution and scans for `remote metadata` exports during remote setup.
   *
   * @example
   * ```ts
   * import { convex } from "./convex";
   * ```
   */
  convex: ConvexInput;

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
   * Persistent browser database name. Tabs sharing the same name share the
   * same persisted data and receive cross-tab updates via
   * `BroadcastChannel`.
   *
   * @default "convex-embedded"
   */
  name?: string;

  /**
   * Enable the remote Convex connection.
   *
   * @remarks
   * When provided, the client becomes **local-first**: mutations write
   * to the local embedded database instantly, then replay to the remote
   * deployment via a durable queue. Reactive subscriptions on the remote
   * keep local state fresh with changes from other clients. On reconnect
   * after offline, a CRDT resolve pass merges any state that diverged.
   *
   * Remote connectivity is built into `@robelest/convex-embedded` — no separate
   * dependency is required.
   *
   * @see {@link RemoteOptions}
   */
  remote?: RemoteOptions;

  /**
   * Optional auth configuration for the embedded client.
   *
   * This is the preferred way to keep local embedded auth in remote with the
   * remote Convex client's `setAuth(...)` flow.
   */
  auth?: AuthOptions;
}

/**
 * Describes the current remote state of a client created with
 * {@link createConvexClient}.
 *
 * The remote state machine transitions are:
 *
 * ```
 *  idle -> connecting -> resolving -> ready
 *                        ↑         ↓
 *                     offline ←────┘
 *                        ↓
 *                      error (after max retries)
 * ```
 *
 * @remarks
 * **`idle`** — Remote connectivity was not configured (no `remote` option), or the engine
 * has not started yet (module discovery still in progress).
 *
 * **`connecting`** — The remote `ConvexClient` is establishing its
 * WebSocket connection to the Convex deployment.
 *
 * **`resolving`** — The CRDT resolve pass is in progress. When available,
 * `progress` reports how many tables have been resolved so far.
 *
 * **`resolved`** — All tables are resolved and reactive subscriptions are
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
 * const unsub = subscribeRemoteState(client, (state) => {
 *   switch (state.status) {
 *     case "resolved": badge.textContent = "Online"; break;
 *     case "offline": badge.textContent = "Offline"; break;
 *     case "resolving": badge.textContent = `Resolving ${state.progress?.completed ?? 0}/${state.progress?.total ?? "?"}...`; break;
 *     case "error":   badge.textContent = `Error: ${state.error?.message}`; break;
 *   }
 * });
 * ```
 *
 * @see {@link getRemoteState} — Read the current remote state once.
 * @see {@link subscribeRemoteState} — Subscribe to state transitions.
 *
 * @category Type
 */
/**
 * Create a `ConvexClient` backed by the local embedded Convex runtime.
 *
 * Returns a standard {@link https://docs.convex.dev/api/classes/browser.ConvexClient | ConvexClient}
 * for framework-agnostic browser usage. The browser entry does not add a
 * React-specific client wrapper.
 *
 * @remarks
 * **How it works**: The factory creates an embedded runtime on the
 * main thread, connects it to a `ConvexClient` via a loopback WebSocket
 * transport, and initialises browser sqlite storage in a Dedicated Worker.
 * From the outside, the returned client behaves identically to a normal
 * `ConvexClient` connected to a remote deployment.
 *
 * **Without `remote`**: Purely local. Queries and mutations run against
 * an in-browser database persisted via OPFS-backed sqlite. No
 * network traffic.
 *
 * **With `remote`**: Local-first with a remote Convex deployment:
 * - Queries read from the local embedded database (instant, offline-capable).
 * - `client.mutation(...)` writes locally first (instant), then replays
 *   to the remote deployment via a durable queue.
 * - Reactive subscriptions on the remote keep local state fresh with
 *   changes from other clients in real time.
 * - On reconnect, a Yjs CRDT resolve pass merges any state that diverged
 *   while offline.
 *
 * **Module auto-discovery**: Sync metadata is discovered automatically
 * from your Convex modules — any module that exports remote metadata (from
 * `register()`) is enrolled for remote. No manual table configuration.
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
 *   convex,
 *   remote: { url: import.meta.env.CONVEX_URL },
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
 *   convex,
 *   remote: { url: import.meta.env.CONVEX_URL },
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
 * // Local-only (no remote) — useful for prototyping or offline-only apps
 * const client = createConvexClient({
 *   convex,
 * });
 * ```
 *
 * @param options - Client configuration. See {@link ClientOptions}.
 * @returns A standard `ConvexClient` instance. When `remote` is configured,
 *          `client.mutation()` is patched for local-first writes and
 *          `client.close()` tears down the resolve engine.
 *
 * @see {@link ClientOptions} — All available options.
 * @see {@link RemoteOptions} — Remote connection configuration.
 * @see {@link getRemoteState} — Read the remote state.
 * @see {@link subscribeRemoteState} — Observe remote state changes.
 *
 * @category Factory
 */
export function createConvexClient(options: ClientOptions): ConvexClient {
  ensureConvexAllowFunctionsInBrowser();
  const platform = createBrowserPlatformAdapter();
  const client = createEmbeddedClient({ options, platform }) as ConvexClient & {
    close(): Promise<void>;
  };
  const name = options.name ?? "convex-embedded";

  registerBrowserDebugClient({
    name,
    clear: async () => {
      try {
        await client.close();
      } catch {}
      await clearBrowserLocalData(name);
    },
  });

  const originalClose = client.close.bind(client);
  client.close = async () => {
    unregisterBrowserDebugClient(name);
    await originalClose();
  };

  return client;
}

/**
 * Create the browser platform adapter used by embedded browser clients.
 *
 * @see createConvexClient
 */
export { createBrowserPlatformAdapter } from "@/browser/platform";
export { createBrowserWorkScheduler } from "@/browser/work";

/**
 * Embedded auth helpers for browser clients.
 */
export {
  getAuthState,
  subscribeAuthState,
  reauthenticate,
  getAuthIdentity,
  setAuthIdentity,
  logout,
  switchIdentity,
} from "@/client/auth";

/**
 * Remote sync state helpers for browser clients.
 */
export { getRemoteState, subscribeRemoteState } from "@/client/remote";

/**
 * Preload (SSR) handoff helper: resolves once a `preloadQuery` value can defer to
 * the live local query (scope resolved, offline, or no engine) — no stale flash.
 */
export { whenPreloaded } from "@/client/remote";

function ensureConvexAllowFunctionsInBrowser(): void {
  try {
    const target = globalThis as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(
      target,
      "__convexAllowFunctionsInBrowser",
    );

    if (descriptor?.writable === false && descriptor.set === undefined) {
      return;
    }

    Object.defineProperty(target, "__convexAllowFunctionsInBrowser", {
      value: true,
      writable: true,
      configurable: true,
    });
  } catch {}
}
