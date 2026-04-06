import { Fx } from "@robelest/fx";
import { ConvexClient } from "convex/browser";

import { patchRoutedConvexClient } from "@/client/adapter";
import {
  restoreAuthenticatedIfNeeded,
  setOfflineStaleIfNeeded,
  type AuthEntry,
} from "@/client/auth";
import {
  discoverRemoteMetadata,
  type DiscoveredRemoteMetadata,
  type ModuleLoadFailure,
  warnModuleLoadFailures,
} from "@/client/discovery";
import type { RouteMode } from "@/client/routing/metadata";
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
import type { ConvexModule } from "@/kernel/modules";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import type { ConnectivityAdapter } from "@/runtime/platform";

export interface RemoteOptions {
  url: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

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

export interface EngineInstance {
  mutation(
    ref: any,
    args: any,
    options?: { enqueueForReplay?: boolean },
  ): Promise<any>;
  on(event: string, cb: (status: any) => void): void;
  resolveNow?(): Promise<void>;
  reloadIdentity?(): Promise<void>;
  start(): void;
  stop(): void;
  pendingCount?(): number;
}

export interface ResolveAttachment {
  forwardSetAuth: (...args: Parameters<ConvexClient["setAuth"]>) => void;
  forwardClearAuth: () => void;
  forwardSetAdminAuth: (...args: any[]) => void;
  getPendingCount: () => number;
  refresh: () => Promise<void>;
  close: () => Promise<void>;
}

export interface ResolveEntry {
  engine: EngineInstance | null;
  state: RemoteState;
  listeners: Set<(state: RemoteState) => void>;
  routeModes: Map<string, RouteMode>;
  discovery: Promise<void> | null;
  discoveryReady: boolean;
  closed: boolean;
}

type DiscoveryResult =
  | { _tag: "Closed" }
  | {
      _tag: "Empty";
      routeModes: Map<string, RouteMode>;
      moduleLoadFailures: ModuleLoadFailure[];
    }
  | {
      _tag: "Ready";
      routeModes: Map<string, RouteMode>;
      moduleLoadFailures: ModuleLoadFailure[];
      tables: Record<
        string,
        { resolve: string; query: string; schema?: unknown }
      >;
    };

const resolveEntries = new WeakMap<ConvexClient, ResolveEntry>();

export function getRemoteState(client: ConvexClient): RemoteState {
  return resolveEntries.get(client)?.state ?? { status: "idle" };
}

export function subscribeRemoteState(
  client: ConvexClient,
  callback: (state: RemoteState) => void,
): () => void {
  const entry = resolveEntries.get(client);
  if (!entry) return () => {};
  entry.listeners.add(callback);
  return () => entry.listeners.delete(callback);
}

export function deleteResolveEntry(client: ConvexClient): void {
  resolveEntries.delete(client);
}

async function loadEngine(): Promise<any> {
  const { engine } = await import("@/client/engine");
  return engine;
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

function executeLocalMutation(
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

function deferUntilDiscovery<T>(
  entry: ResolveEntry,
  run: () => Promise<T>,
): Promise<T> {
  return Fx.run(
    Fx.gen(function* () {
      if (entry.discovery) {
        yield* Fx.from({
          ok: () => entry.discovery!,
          err: (err) => err as Error,
        });
      }

      return yield* Fx.from({ ok: run, err: (err) => err as Error });
    }),
  );
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
      }
    : {
        _tag: "Ready",
        routeModes: accumulator.routeModes,
        moduleLoadFailures: accumulator.moduleLoadFailures,
        tables: accumulator.tables,
      };
}

function notifyResolveListeners(entry: ResolveEntry, state: RemoteState): void {
  entry.state = state;
  for (const cb of entry.listeners) {
    try {
      cb(state);
    } catch {
      /* listener error */
    }
  }
}

function toResolvePhase(status: any): BrowserResolvePhase {
  if (!status) return { _tag: "Idle" };

  const handlers = {
    resolving: (current: any): BrowserResolvePhase => ({
      _tag: "Syncing",
      progress: current.progress
        ? {
            completed: current.progress.completed,
            total: current.progress.total,
          }
        : undefined,
    }),
    resolved: (): BrowserResolvePhase => ({ _tag: "Ready" }),
    error: (current: any): BrowserResolvePhase => ({
      _tag: "Error",
      error: current.error,
    }),
    offline: (): BrowserResolvePhase => ({ _tag: "Offline" }),
    idle: (): BrowserResolvePhase => ({ _tag: "Idle" }),
  } as const;

  const handler =
    handlers[(status.status as keyof typeof handlers) ?? "idle"] ??
    handlers.idle;
  return handler(status);
}

function mapStatus(s: any): RemoteState {
  return Fx.pipe(s, toResolvePhase, (phase) =>
    matchTag(phase, "_tag", {
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
    }),
  );
}

async function discoverAndStart(input: {
  entry: ResolveEntry;
  authEntry: AuthEntry;
  embedded: {
    client: ConvexClient;
    ingestDocuments: (
      table: string,
      documents: Array<Record<string, unknown>>,
    ) => Promise<void>;
    getDocumentsForTable: (
      table: string,
    ) => Promise<Array<Record<string, unknown>>>;
    executeLocal: EmbeddedRuntime["executeLocal"];
  };
  remoteClient: ConvexClient;
  resolveOpts: RemoteOptions;
  modules: Record<string, () => Promise<ConvexModule>>;
  getIdentityKeyForSync: () => string | null;
  getReplayPayloadVersion?: (refName: string) => number;
  connectivity?: ConnectivityAdapter;
  processorId?: string;
}): Promise<void> {
  const {
    entry,
    authEntry,
    embedded,
    remoteClient,
    resolveOpts,
    modules,
    getIdentityKeyForSync,
    getReplayPayloadVersion,
    connectivity,
    processorId,
  } = input;
  const setup = Fx.gen(function* () {
    const engineFactory = yield* Fx.from({
      ok: loadEngine,
      err: (err) => err as Error,
    });
    if (!engineFactory || entry.closed) return;

    const discovered = yield* Fx.from({
      ok: async () => {
        const accumulator = await discoverRemoteMetadata({
          modules,
          shouldStop: () => entry.closed,
        });

        return accumulator === null
          ? ({ _tag: "Closed" } satisfies DiscoveryResult)
          : toDiscoveryResult(entry, accumulator);
      },
      err: (err) => err as Error,
    });

    return yield* Fx.from({
      ok: async () => {
        matchTag(discovered, "_tag", {
          Closed: () => undefined,
          Empty: (current) => {
            entry.routeModes = current.routeModes;
            warnModuleLoadFailures(current.moduleLoadFailures);
            if (entry.routeModes.size === 0) {
              console.warn(
                "[convex-embedded] remote enabled but no remote metadata found in modules. Make sure your Convex modules export `tasks.resolve` (for example `export const resolve = tasks.resolve`).",
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
              maxRetries: resolveOpts.maxRetries,
              retryDelayMs: resolveOpts.retryDelayMs,
              getIdentityKey: getIdentityKeyForSync,
              getReplayPayloadVersion,
              connectivity,
              processorId,
            });

            if (entry.closed) {
              engine.stop();
              return;
            }

            entry.engine = engine;
            engine.on("change", (monitorStatus: any) => {
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
      },
      err: (err) => err as Error,
    });
  }).pipe(
    Fx.inspect((err) =>
      Fx.sync(() => {
        if (entry.closed) return;
        const error =
          err instanceof Error
            ? err
            : new Error(String(err ?? "unknown error"));
        console.error("[convex-embedded] resolve setup failed", error);
        notifyResolveListeners(entry, { status: "error", error });
      }),
    ),
  );

  return Fx.run(setup);
}

export function attachResolve(input: {
  client: ConvexClient;
  runtime: EmbeddedRuntime;
  authEntry: AuthEntry;
  resolveOpts: RemoteOptions;
  modules: Record<string, () => Promise<ConvexModule>>;
  getIdentityKeyForSync: () => string | null;
  getReplayPayloadVersion?: (refName: string) => number;
  connectivity?: ConnectivityAdapter;
  processorId?: string;
}): ResolveAttachment {
  const {
    client,
    runtime,
    authEntry,
    resolveOpts,
    modules,
    getIdentityKeyForSync,
    getReplayPayloadVersion,
  } = input;
  const remoteClient = new ConvexClient(resolveOpts.url);

  const embedded = {
    client,
    ingestDocuments: runtime.ingestDocuments.bind(runtime),
    getDocumentsForTable: runtime.getDocumentsForTable.bind(runtime),
    executeLocal: runtime.executeLocal.bind(runtime),
  };

  const entry: ResolveEntry = {
    engine: null,
    state: { status: "idle" },
    listeners: new Set(),
    routeModes: new Map(),
    discovery: null,
    discoveryReady: false,
    closed: false,
  };

  patchRoutedConvexClient({
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
    executeLocalMutation: (ref, args, enqueueForReplay) =>
      executeLocalMutation(entry, runtime, ref, args, enqueueForReplay),
    waitUntilReady: (run) => deferUntilDiscovery(entry, run),
    isReady: () => entry.discoveryReady,
    connectivity: input.connectivity,
  });

  resolveEntries.set(client, entry);

  const discovery = discoverAndStart({
    entry,
    authEntry,
    embedded,
    remoteClient,
    resolveOpts,
    modules,
    getIdentityKeyForSync,
    getReplayPayloadVersion,
    connectivity: input.connectivity,
    processorId: input.processorId,
  }).finally(() => {
    entry.discoveryReady = true;
  });
  void discovery.catch(() => {});
  entry.discovery = discovery;

  return {
    forwardSetAuth: (...args) => {
      (remoteClient as any).setAuth(...args);
    },
    forwardClearAuth: () => {
      (remoteClient as any).clearAuth();
    },
    forwardSetAdminAuth: (...args) => {
      (remoteClient as any).setAdminAuth?.(...args);
    },
    getPendingCount: () => entry.engine?.pendingCount?.() ?? 0,
    refresh: () => entry.engine?.reloadIdentity?.() ?? Promise.resolve(),
    close: async () => {
      entry.closed = true;
      if (entry.engine) {
        entry.engine.stop();
      }
      await remoteClient.close();
    },
  };
}
