import { ConvexClient } from "convex/browser";

import { patchRoutedConvexClient } from "@/client/adapter";
import {
  restoreAuthenticatedIfNeeded,
  setOfflineStaleIfNeeded,
  type AuthEntry,
} from "@/client/auth";
import type { EmbeddedQueryCache } from "@/client/cache";
import {
  discoverRemoteMetadata,
  type DiscoveredRemoteMetadata,
  type ModuleLoadFailure,
  warnModuleLoadFailures,
} from "@/client/discovery";
import type { IdMap } from "@/client/ids";
import {
  planMutationExecution,
  planReadExecution,
} from "@/client/routing/plan";
import {
  asError,
  getFunctionRefName,
  getFunctionRefPath,
  matchTag,
} from "@/client/routing/refs";
import type { ResolveInput } from "@/client/services/resolve";
import type { ConvexInput } from "@/kernel/modules";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import type { ConnectivityAdapter } from "@/runtime/platform";
import type { QueryCacheStorage } from "@/runtime/sqlite/cache";
import { createLogger } from "@/shared/logger";
import type { RouteMode } from "@/shared/route";
import type { EngineStatus } from "@/shared/types";
import { PubSub } from "@/utils/pubsub";
import { DisposableScope } from "@/utils/scope";

const log = createLogger("remote");

/**
 * Configuration for the embedded remote sync engine.
 *
 * @remarks
 * Pass this object as the `remote` option to `createConvexClient(...)` or the
 * Expo client factory to enable local-first sync against a hosted Convex
 * deployment.
 *
 * @example
 * ```ts
 * const client = createConvexClient({
 *   convex,
 *   remote: {
 *     url: import.meta.env.CONVEX_URL,
 *     maxRetries: 5,
 *     retryDelayMs: 1000,
 *   },
 * });
 * ```
 */
export interface RemoteOptions {
  /** Remote Convex deployment URL. */
  url: string;
  /** Maximum number of resolve retries before surfacing an error state. */
  maxRetries?: number;
  /** Delay between resolve retries in milliseconds. */
  retryDelayMs?: number;
  /** Optional upload URL function reference used by local-first file uploads. */
  uploadUrlRef?: unknown;
}

/**
 * Snapshot of the embedded remote-sync state machine.
 *
 * @remarks
 * `resolved` is the normal online steady-state. `resolving` appears during the
 * CRDT catch-up pass after reconnect. `offline` means local writes continue but
 * remote replay is paused until connectivity returns.
 */
export type RemoteState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "resolving"; progress?: { completed: number; total: number } }
  | { status: "resolved" }
  | { status: "offline" }
  | { status: "error"; error?: Error };

type BrowserResolvePhase =
  | { _tag: "Idle" }
  | { _tag: "Syncing"; progress?: { completed: number; total: number } }
  | { _tag: "Ready" }
  | { _tag: "Offline" }
  | { _tag: "Error"; error: unknown };

/**
 * Implementation contract for the lazily loaded resolve engine.
 * @internal
 */
export interface EngineInstance {
  mutation(
    ref: unknown,
    args: Record<string, unknown>,
    options?: { enqueueForReplay?: boolean },
  ): Promise<unknown>;
  on(event: "change", cb: (status: EngineStatus) => void): void;
  resolveNow?(): Promise<void>;
  ensureTableReady?(tableName: string): Promise<void>;
  ensureScopeReady?(
    tableName: string,
    scopeArgs?: Record<string, unknown>,
  ): Promise<void>;
  reloadIdentity?(): Promise<void>;
  start(): void;
  stop(): void;
  pendingCount?(): number;
  readonly idMap?: IdMap;
}

/**
 * Internal control hooks returned when remote sync is attached to a client.
 * @internal
 */
export interface ResolveAttachment {
  /** Forward `setAuth(...)` calls to the hidden remote Convex client. */
  forwardSetAuth: (...args: Parameters<ConvexClient["setAuth"]>) => void;
  /** Forward `clearAuth()` calls to the hidden remote Convex client. */
  forwardClearAuth: () => void;
  /** Forward admin-auth calls when available. */
  forwardSetAdminAuth: (...args: unknown[]) => void;
  /** Read the number of queued mutations waiting for replay. */
  getPendingCount: () => number;
  /** Ensure a lazy table is hydrated/resolved before first use. */
  ensureTableReady: (tableName: string) => Promise<void>;
  /** Force a remote identity reload / resolve refresh. */
  refresh: () => Promise<void>;
  /** Tear down the remote engine and release all resources. */
  close: () => Promise<void>;
}

interface RemoteAuthClient {
  clearAuth(): void;
  setAdminAuth?(...args: unknown[]): void;
}

/**
 * Internal remote-sync entry stored per browser client.
 * @internal
 */
export interface ResolveEntry {
  engine: EngineInstance | null;
  state: RemoteState;
  stateHub: PubSub<RemoteState>;
  routeModes: Map<string, RouteMode>;
  discovery: Promise<void> | null;
  discoveryReady: boolean;
  closed: boolean;
  scope: DisposableScope;
}

type DiscoveryResult =
  | { _tag: "Closed" }
  | {
      _tag: "Empty";
      routeModes: Map<string, RouteMode>;
      moduleLoadFailures: ModuleLoadFailure[];
      uploadUrl?: string;
    }
  | {
      _tag: "Ready";
      routeModes: Map<string, RouteMode>;
      moduleLoadFailures: ModuleLoadFailure[];
      uploadUrl?: string;
      tables: Record<string, { resolve: string; schema?: unknown }>;
    };

const RESOLVE_ENTRIES = Symbol.for(
  "convex-embedded:client/remote:resolveEntries",
);

type RemoteGlobal = typeof globalThis & {
  [RESOLVE_ENTRIES]?: WeakMap<ConvexClient, ResolveEntry>;
};

async function closeRemoteClientSafely(
  remoteClient: ConvexClient,
): Promise<void> {
  await Promise.race([
    Promise.resolve(remoteClient.close()),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 1_000);
    }),
  ]);
}

function getResolveEntriesStore() {
  const globalState = globalThis as RemoteGlobal;
  globalState[RESOLVE_ENTRIES] ??= new WeakMap<ConvexClient, ResolveEntry>();
  return globalState[RESOLVE_ENTRIES];
}

/**
 * Read the current remote sync state for a browser client.
 *
 * @param client - Browser `ConvexClient` instance.
 * @returns The current remote sync state snapshot.
 */
export function getRemoteState(client: ConvexClient): RemoteState {
  return getResolveEntriesStore().get(client)?.state ?? { status: "idle" };
}

/**
 * Subscribe to remote sync state transitions for a browser client.
 *
 * @param client - Browser `ConvexClient` instance.
 * @param callback - Listener invoked whenever the remote sync state changes.
 * @returns An unsubscribe function.
 */
export function subscribeRemoteState(
  client: ConvexClient,
  callback: (state: RemoteState) => void,
): () => void {
  const entry = getResolveEntriesStore().get(client);
  if (!entry) return () => {};

  return entry.stateHub.subscribe((state) => {
    try {
      callback(state);
    } catch {
      /* listener error */
    }
  });
}

/**
 * Remove the remote sync entry associated with a browser client.
 *
 * @param client - Browser `ConvexClient` instance.
 * @internal
 */
export function deleteResolveEntry(client: ConvexClient): void {
  getResolveEntriesStore().delete(client);
}

async function loadEngine(): Promise<{
  create(config: unknown): EngineInstance;
}> {
  const mod = await import("@/client/engine");
  return mod.engine as unknown as {
    create(config: unknown): EngineInstance;
  };
}

function resolveMutationRoute(entry: ResolveEntry, ref: unknown) {
  const refName = getFunctionRefName(ref);
  const refPath = getFunctionRefPath(ref);
  const routeMode =
    refName.length > 0 ? (entry.routeModes.get(refName) ?? null) : null;
  return planMutationExecution({ refName, refPath, routeMode });
}

function resolveReadRoute(entry: ResolveEntry, ref: unknown) {
  const refName = getFunctionRefName(ref);
  const refPath = getFunctionRefPath(ref);
  const routeMode =
    refName.length > 0 ? (entry.routeModes.get(refName) ?? null) : null;
  return planReadExecution({ refName, refPath, routeMode });
}

async function executeLocalMutation(
  entry: ResolveEntry,
  runtime: EmbeddedRuntime,
  ref: unknown,
  args: Record<string, unknown>,
  enqueueForReplay: boolean,
): Promise<unknown> {
  if (entry.engine) {
    return entry.engine.mutation(ref, args, { enqueueForReplay });
  }

  return runtime.executeLocal({
    kind: "mutation",
    path: getFunctionRefName(ref),
    args,
    applyLocalEffects: true,
  });
}

async function deferUntilDiscovery<T>(
  entry: ResolveEntry,
  run: () => Promise<T>,
): Promise<T> {
  if (entry.discovery) {
    await entry.discovery;
  }
  if (entry.state.status === "error" && entry.state.error) {
    throw entry.state.error;
  }
  return run();
}

function toDiscoveryResult(
  entry: ResolveEntry,
  accumulator: DiscoveredRemoteMetadata,
): DiscoveryResult {
  if (entry.closed) {
    return { _tag: "Closed" };
  }

  return Object.keys(accumulator.tables).length === 0
    ? {
        _tag: "Empty",
        routeModes: accumulator.routeModes,
        moduleLoadFailures: accumulator.moduleLoadFailures,
        uploadUrl: accumulator.uploadUrl,
      }
    : {
        _tag: "Ready",
        routeModes: accumulator.routeModes,
        moduleLoadFailures: accumulator.moduleLoadFailures,
        uploadUrl: accumulator.uploadUrl,
        tables: accumulator.tables,
      };
}

function notifyResolveListeners(entry: ResolveEntry, state: RemoteState): void {
  entry.state = state;
  entry.stateHub.publish(state);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error == null) return "unknown error";
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

function toResolvePhase(
  status: EngineStatus | null | undefined,
): BrowserResolvePhase {
  if (!status) return { _tag: "Idle" };

  return matchTag(status, "status", {
    resolving: (current): BrowserResolvePhase => ({
      _tag: "Syncing",
      progress: current.progress
        ? {
            completed: current.progress.completed,
            total: current.progress.total,
          }
        : undefined,
    }),
    resolved: (): BrowserResolvePhase => ({ _tag: "Ready" }),
    error: (current): BrowserResolvePhase => ({
      _tag: "Error",
      error: current.error,
    }),
    offline: (): BrowserResolvePhase => ({ _tag: "Offline" }),
    idle: (): BrowserResolvePhase => ({ _tag: "Idle" }),
  });
}

function mapStatus(s: EngineStatus): RemoteState {
  const phase = toResolvePhase(s);
  return matchTag(phase, "_tag", {
    Idle: (): RemoteState => ({ status: "idle" }),
    Syncing: (current): RemoteState => ({
      status: "resolving",
      progress: current.progress,
    }),
    Ready: (): RemoteState => ({ status: "resolved" }),
    Offline: (): RemoteState => ({ status: "offline" }),
    Error: (current): RemoteState => ({
      status: "error",
      error: asError(current.error),
    }),
  });
}

async function discoverAndStart(input: ResolveInput): Promise<void> {
  const {
    entry,
    authEntry,
    embedded,
    remoteClient,
    resolveOpts,
    convex,
    getIdentityKeyForSync,
    getReplayPayloadVersion,
    uploadFetch,
    connectivity,
    processorId,
  } = input;

  try {
    const engineFactory = await loadEngine();
    if (!engineFactory || entry.closed) return;

    const accumulator = await discoverRemoteMetadata({
      convex,
      shouldStop: () => entry.closed,
    });

    const discovered =
      accumulator === null
        ? ({ _tag: "Closed" } satisfies DiscoveryResult)
        : toDiscoveryResult(entry, accumulator);

    matchTag(discovered, "_tag", {
      Closed: () => undefined,
      Empty: (current) => {
        entry.routeModes = current.routeModes;
        warnModuleLoadFailures(current.moduleLoadFailures);
        if (entry.routeModes.size === 0) {
          log.warn(
            "remote enabled but no remote metadata found in modules. Make sure your Convex modules export `tasks.resolve` (for example `export const resolve = tasks.resolve`).",
          );
        }
      },
      Ready: (current) => {
        entry.routeModes = current.routeModes;
        warnModuleLoadFailures(current.moduleLoadFailures);
        const engine: EngineInstance = engineFactory.create({
          embedded,
          remoteClient,
          tables: current.tables,
          uploadUrlRef: resolveOpts.uploadUrlRef ?? current.uploadUrl,
          maxRetries: resolveOpts.maxRetries,
          retryDelayMs: resolveOpts.retryDelayMs,
          getIdentityKey: getIdentityKeyForSync,
          getReplayPayloadVersion,
          uploadFetch,
          connectivity,
          processorId,
        });

        if (entry.closed) {
          engine.stop();
          return;
        }

        entry.engine = engine;
        entry.scope.addFinalizer(() => {
          engine.stop();
        });
        engine.on("change", (monitorStatus) => {
          if (entry.closed) return;
          notifyResolveListeners(entry, mapStatus(monitorStatus));

          if (monitorStatus?.status === "offline") {
            setOfflineStaleIfNeeded(authEntry);
            return;
          }

          if (
            monitorStatus?.status === "resolving" ||
            monitorStatus?.status === "resolved"
          ) {
            restoreAuthenticatedIfNeeded(authEntry);
          }
        });
        engine.start();
      },
    });
  } catch (err) {
    if (entry.closed) return;
    const error = err instanceof Error ? err : new Error(toErrorMessage(err));
    log.error("resolve setup failed", error);
    notifyResolveListeners(entry, { status: "error", error });
  }
}

/**
 * Attach the embedded remote sync engine to a browser `ConvexClient`.
 *
 * @param input - Runtime, auth, and remote connection wiring for the client.
 * @returns Control hooks for auth forwarding, refresh, and shutdown.
 * @internal
 */
export function attachResolve(input: {
  client: ConvexClient;
  runtime: EmbeddedRuntime;
  authEntry: AuthEntry;
  resolveOpts: RemoteOptions;
  convex: ConvexInput;
  getIdentityKeyForSync: () => string | null;
  getReplayPayloadVersion?: (refName: string) => number;
  uploadFetch?: typeof globalThis.fetch;
  connectivity?: ConnectivityAdapter;
  processorId?: string;
  cache?: EmbeddedQueryCache;
  getCacheStorage?: () => QueryCacheStorage | null;
  knownTables?: ReadonlySet<string>;
  leaderLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}): ResolveAttachment {
  const {
    client,
    runtime,
    authEntry,
    resolveOpts,
    convex,
    getIdentityKeyForSync,
    getReplayPayloadVersion,
  } = input;
  const remoteClient = new ConvexClient(resolveOpts.url);

  const embedded = {
    client,
    ingestDocuments: runtime.ingestDocuments.bind(runtime),
    canonicalizeMappedCreate: runtime.canonicalizeMappedCreate.bind(runtime),
    getDocumentsForTable: runtime.getDocumentsForTable.bind(runtime),
    hasLocalDocumentId: runtime.hasLocalDocumentId.bind(runtime),
    executeLocal: runtime.executeLocal.bind(runtime),
    getStorageBlob: runtime.getStorageBlob.bind(runtime),
    getStorageMetadata: runtime.getStorageMetadata.bind(runtime),
    registerUploadUrlSource: runtime.registerUploadUrlSource.bind(runtime),
  };

  const entry: ResolveEntry = {
    engine: null,
    state: { status: "idle" },
    stateHub: new PubSub<RemoteState>(),
    routeModes: new Map(),
    discovery: null,
    discoveryReady: false,
    closed: false,
    scope: new DisposableScope(),
  };

  entry.scope.addFinalizer(async () => {
    try {
      await closeRemoteClientSafely(remoteClient);
    } catch (err) {
      log.warn("error during remote client teardown", err);
    }
  });
  entry.scope.addFinalizer(() => {
    entry.stateHub.shutdown();
  });

  // Sync engine is attaching — start enqueuing every storage.store(blob) so
  // the engine can replay the upload to remote on reconnect.
  runtime.setUploadQueueEnabled(true);
  entry.scope.addFinalizer(() => {
    runtime.setUploadQueueEnabled(false);
  });

  const patchHandle = patchRoutedConvexClient({
    client,
    runtime,
    remoteClient,
    getRefName: getFunctionRefName,
    asError,
    resolveMutationPlan: (ref) => resolveMutationRoute(entry, ref),
    resolveReadPlan: (ref) => resolveReadRoute(entry, ref),
    resolveReadPlanByName: (refName) =>
      planReadExecution({
        refName,
        refPath: getFunctionRefPath(refName),
        routeMode: entry.routeModes.get(refName) ?? null,
      }),
    ensureReadReady: async (refName, readArgs) => {
      const tableName = refName.split(":")[0] ?? "";
      if (!tableName) return;
      const filtered = readArgs
        ? Object.fromEntries(
            Object.entries(readArgs).filter(
              ([key]) => key !== "paginationOpts",
            ),
          )
        : undefined;
      const scopeArgs =
        filtered && Object.keys(filtered).length > 0
          ? (entry.engine?.idMap?.translateLocalIdsToRemote(filtered) ??
            filtered)
          : undefined;
      await entry.engine?.ensureScopeReady?.(tableName, scopeArgs);
    },
    executeLocalMutation: (ref, args, enqueueForReplay) =>
      executeLocalMutation(entry, runtime, ref, args, enqueueForReplay),
    translateLocalArgsToRuntime: (args: Record<string, unknown>) =>
      entry.engine?.idMap?.translateClientIdsToRuntime(args) ?? args,
    translateClientArgsToRemote: (args: Record<string, unknown>) =>
      entry.engine?.idMap?.translateLocalIdsToRemote(args) ?? args,
    translateLocalResultToClient: <T>(value: T): T =>
      (entry.engine?.idMap?.translateResult(value) ?? value) as T,
    waitUntilReady: (run) => deferUntilDiscovery(entry, run),
    isReady: () => entry.discoveryReady,
    connectivity: input.connectivity,
    cache: input.cache,
    getCacheStorage: input.getCacheStorage,
    knownTables: input.knownTables,
  });
  entry.scope.addFinalizer(() => patchHandle.dispose());

  getResolveEntriesStore().set(client, entry);

  const discoverInput = {
    entry,
    authEntry,
    embedded,
    remoteClient,
    resolveOpts,
    convex,
    getIdentityKeyForSync,
    getReplayPayloadVersion,
    uploadFetch: input.uploadFetch,
    connectivity: input.connectivity,
    processorId: input.processorId,
  };

  const leaderLock = input.leaderLock;
  const entryClosedPromise = new Promise<void>((resolve) => {
    entry.scope.addFinalizer(() => resolve());
  });

  if (leaderLock) {
    entry.discovery = Promise.resolve();
    void leaderLock(async () => {
      if (entry.closed) return;
      await discoverAndStart(discoverInput);
      entry.discoveryReady = true;
      await entryClosedPromise;
    }).catch(() => {});
  } else {
    const discovery = discoverAndStart(discoverInput).then(() => {
      entry.discoveryReady = true;
    });
    void discovery.catch(() => {});
    entry.discovery = discovery;
  }

  const remoteAuth = remoteClient as unknown as RemoteAuthClient;
  return {
    forwardSetAuth: (...args) => {
      remoteClient.setAuth(...args);
    },
    forwardClearAuth: () => {
      remoteAuth.clearAuth();
    },
    forwardSetAdminAuth: (...args) => {
      remoteAuth.setAdminAuth?.(...args);
    },
    getPendingCount: () => entry.engine?.pendingCount?.() ?? 0,
    ensureTableReady: (tableName) =>
      entry.engine?.ensureTableReady?.(tableName) ?? Promise.resolve(),
    refresh: async () => {
      await entry.engine?.reloadIdentity?.();
    },
    close: async () => {
      entry.closed = true;
      await entry.scope.close();
    },
  };
}
