import { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { jsonToConvex, type JSONValue } from "convex/values";

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
import { EmbeddedClient } from "@/client/embedded";
import type { IdMap } from "@/client/ids";
import type { Preloaded } from "@/client/preload";
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
import type { PullInput } from "@/client/services/pull";
import type { ConvexInput } from "@/kernel/modules";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import type { ConnectivityAdapter } from "@/runtime/platform";
import type { QueryCacheStorage } from "@/runtime/sqlite/cache";
import { toErrorMessage } from "@/shared/error";
import { createLogger } from "@/shared/logger";
import type { RouteMode } from "@/shared/route";
import type { EngineStatus } from "@/shared/types";
import { stableValueKey } from "@/shared/valuekey";
import { createPubSub, type PubSub } from "@/utils/pubsub";
import { createDisposableScope, type DisposableScope } from "@/utils/scope";

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

interface EngineHandle {
  mutation(
    ref: unknown,
    args: Record<string, unknown>,
    options?: { enqueueForReplay?: boolean },
  ): Promise<unknown>;
  on(event: "change", cb: (status: EngineStatus) => void): void;
  pullNow?(): Promise<void>;
  ensureTableReady?(tableName: string): Promise<void>;
  ensureScopeReady?(
    tableName: string,
    scopeArgs?: Record<string, unknown>,
    readKey?: string,
  ): Promise<void>;
  releaseScopeRead?(
    tableName: string,
    scopeArgs: Record<string, unknown> | undefined,
    readKey: string,
  ): void;
  onScopeResolved?(
    tableName: string,
    scopeArgs: Record<string, unknown> | undefined,
    cb: () => void,
  ): () => void;
  reloadIdentity?(): Promise<void>;
  start(): void;
  stop(): void;
  pendingCount?(): number;
  readonly idMap?: IdMap;
}

function readScopeArgs(
  engine: EngineHandle,
  readArgs?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const filtered = readArgs
    ? Object.fromEntries(
        Object.entries(readArgs).filter(([key]) => key !== "paginationOpts"),
      )
    : undefined;
  if (!filtered || Object.keys(filtered).length === 0) {
    return undefined;
  }
  return engine.idMap?.translateLocalIdsToRemote(filtered) ?? filtered;
}

/**
 * Derive the `(tableName, scopeArgs)` a query read maps to — the same mapping
 * the live read path uses in `ensureReadReady`, so callers (e.g. preload
 * gating) target the exact scope the query resolves.
 */
function deriveQueryScope(
  engine: EngineHandle,
  refName: string,
  readArgs?: Record<string, unknown>,
): { tableName: string; scopeArgs: Record<string, unknown> | undefined } {
  return {
    tableName: refName.split(":")[0] ?? "",
    scopeArgs: readScopeArgs(engine, readArgs),
  };
}

/**
 * Internal control hooks returned when remote sync is attached to a client.
 * @internal
 */
export interface PullAttachment {
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
export interface PullEntry {
  engine: EngineHandle | null;
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

const PULL_ENTRIES = Symbol.for("convex-embedded:client/remote:pullEntries");

type RemoteGlobal = typeof globalThis & {
  [PULL_ENTRIES]?: WeakMap<ConvexClient, PullEntry>;
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

function getPullEntriesStore() {
  const globalState = globalThis as RemoteGlobal;
  globalState[PULL_ENTRIES] ??= new WeakMap<ConvexClient, PullEntry>();
  return globalState[PULL_ENTRIES];
}

/**
 * Read the current remote sync state for a browser client.
 *
 * @param client - Browser `ConvexClient` instance.
 * @returns The current remote sync state snapshot.
 */
export function getRemoteState(client: ConvexClient): RemoteState {
  return getPullEntriesStore().get(client)?.state ?? { status: "idle" };
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
  const entry = getPullEntriesStore().get(client);
  if (!entry) return () => {};

  return entry.stateHub.subscribe((state) => {
    try {
      callback(state);
    } catch {
      /* listener error */
    }
  });
}

function preloadedScope(
  engine: EngineHandle,
  preloaded: { _name: string; _argsJSON: JSONValue },
): { tableName: string; scopeArgs: Record<string, unknown> | undefined } {
  const args = jsonToConvex(preloaded._argsJSON) as Record<string, unknown>;
  return deriveQueryScope(engine, preloaded._name, args);
}

/**
 * Resolves once a preloaded query's value can hand off to the live local query —
 * i.e. when that query's scope has resolved from remote at least once (so its
 * local rows are no longer stale-only), or when the client is offline, or when
 * there is no embedded sync engine attached (local-only). Use it to swap a
 * `preloadQuery` value over to the live query without a stale-data flash.
 *
 * @param client - Browser `ConvexClient` instance.
 * @param preloaded - The payload returned by `preloadQuery`.
 * @returns A promise that resolves when the live query should take over.
 */
export function whenPreloaded<Query extends FunctionReference<"query">>(
  client: ConvexClient,
  preloaded: Preloaded<Query>,
): Promise<void> {
  const entry = getPullEntriesStore().get(client);
  if (!entry) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = () => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      resolve();
    };

    // Offline: the local rows are the source of truth, hand off immediately.
    if (entry.state.status === "offline") {
      finish();
      return;
    }
    cleanups.push(
      entry.stateHub.subscribe((state) => {
        if (state.status === "offline") finish();
      }),
    );

    const attach = () => {
      if (settled) return;
      const engine = entry.engine;
      if (!engine?.onScopeResolved) return;
      const { tableName, scopeArgs } = preloadedScope(engine, preloaded);
      if (!tableName) {
        finish();
        return;
      }
      cleanups.push(engine.onScopeResolved(tableName, scopeArgs, finish));
    };

    if (entry.engine) {
      attach();
    } else if (entry.discovery) {
      // Engine is wired during discovery; attach once it's available.
      void entry.discovery.then(attach).catch(() => finish());
    } else {
      finish();
    }
  });
}

/**
 * Remove the remote sync entry associated with a browser client.
 *
 * @param client - Browser `ConvexClient` instance.
 * @internal
 */
export function deletePullEntry(client: ConvexClient): void {
  getPullEntriesStore().delete(client);
}

async function loadEngine(): Promise<{
  create(config: unknown): EngineHandle;
}> {
  const mod = await import("@/client/engine");
  return mod.engine as unknown as {
    create(config: unknown): EngineHandle;
  };
}

function routeMutation(entry: PullEntry, ref: unknown) {
  const refName = getFunctionRefName(ref);
  const refPath = getFunctionRefPath(ref);
  const routeMode =
    refName.length > 0 ? (entry.routeModes.get(refName) ?? null) : null;
  return planMutationExecution({ refName, refPath, routeMode });
}

function routeRead(entry: PullEntry, ref: unknown) {
  const refName = getFunctionRefName(ref);
  const refPath = getFunctionRefPath(ref);
  const routeMode =
    refName.length > 0 ? (entry.routeModes.get(refName) ?? null) : null;
  return planReadExecution({ refName, refPath, routeMode });
}

async function executeLocalMutation(
  entry: PullEntry,
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
  entry: PullEntry,
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
  entry: PullEntry,
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

function notifyPullListeners(entry: PullEntry, state: RemoteState): void {
  entry.state = state;
  entry.stateHub.publish(state);
}

function toPullPhase(
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
  const phase = toPullPhase(s);
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

async function discoverAndStart(input: PullInput): Promise<void> {
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
        const engine: EngineHandle = engineFactory.create({
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
          notifyPullListeners(entry, mapStatus(monitorStatus));

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
    notifyPullListeners(entry, { status: "error", error });
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
}): PullAttachment {
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

  const entry: PullEntry = {
    engine: null,
    state: { status: "idle" },
    stateHub: createPubSub<RemoteState>(),
    routeModes: new Map(),
    discovery: null,
    discoveryReady: false,
    closed: false,
    scope: createDisposableScope(),
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

  if (!(client instanceof EmbeddedClient)) {
    throw new Error(
      "[convex-embedded] attachResolve requires an EmbeddedClient instance.",
    );
  }
  const patchHandle = client.installRouting({
    runtime,
    remoteClient,
    getRefName: getFunctionRefName,
    asError,
    planMutation: (ref) => routeMutation(entry, ref),
    planRead: (ref) => routeRead(entry, ref),
    planReadByName: (refName) =>
      planReadExecution({
        refName,
        refPath: getFunctionRefPath(refName),
        routeMode: entry.routeModes.get(refName) ?? null,
      }),
    ensureReadReady: async (refName, readArgs) => {
      const engine = entry.engine;
      if (!engine) return;
      const { tableName, scopeArgs } = deriveQueryScope(
        engine,
        refName,
        readArgs,
      );
      if (!tableName) return;
      const readKey = `${refName} ${stableValueKey(readArgs ?? {})}`;
      await engine.ensureScopeReady?.(tableName, scopeArgs, readKey);
    },
    releaseRead: (refName, readArgs) => {
      const engine = entry.engine;
      if (!engine?.releaseScopeRead) return;
      const { tableName, scopeArgs } = deriveQueryScope(
        engine,
        refName,
        readArgs,
      );
      if (!tableName) return;
      const readKey = `${refName} ${stableValueKey(readArgs ?? {})}`;
      engine.releaseScopeRead(tableName, scopeArgs, readKey);
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

  getPullEntriesStore().set(client, entry);

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
    let pullDiscovery: () => void = () => {};
    entry.discovery = new Promise<void>((resolve) => {
      pullDiscovery = resolve;
    });
    let enteredLeaderCallback = false;
    void leaderLock(async () => {
      enteredLeaderCallback = true;
      if (entry.closed) {
        pullDiscovery();
        return;
      }
      try {
        await discoverAndStart(discoverInput);
        entry.discoveryReady = true;
      } finally {
        pullDiscovery();
      }
      await entryClosedPromise;
    }).catch(() => {
      pullDiscovery();
    });
    setTimeout(() => {
      if (!enteredLeaderCallback) {
        pullDiscovery();
      }
    }, 50);
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
