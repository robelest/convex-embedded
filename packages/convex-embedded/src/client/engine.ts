/**
 * @internal
 *
 * Engine — internal resolve orchestrator between local embedded
 * runtime and remote Convex backend.
 *
 * This module is NOT part of the public API. Use `createConvexClient()`
 * from `@robelest/convex-embedded/browser` instead.
 */

import { Fx } from "@robelest/fx";
import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import * as Y from "yjs";

import { IdMap } from "@/client/id-map";
import { PendingQueue } from "@/client/pending-queue";
import type { PendingEntry } from "@/client/pending-queue";
import { materializeYjsDoc } from "@/client/schema";
import { initYjsDoc } from "@/server/schema";
import type { Definition } from "@/server/schema";
import { createLogger } from "@/shared/logger";
import type { EngineStatus, ResolveProgress } from "@/shared/types";

const log = createLogger("resolve");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip fields marked with `schema.omit()` from a set of documents.
 *
 * Remote documents may contain fields that only exist on the remote
 * Convex backend and should not be synced to the local embedded
 * runtime (e.g. large blobs, server-side computed fields).
 *
 * If there are no omitted fields in the schema, returns the original
 * array as-is (no allocation).
 */
function stripOmittedFields(
  schemaDef: Definition,
  docs: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const omittedFields = schemaDef.getOmittedFields();
  if (omittedFields.length === 0) return docs;

  return docs.map((doc) => {
    const stripped = { ...doc };
    for (const field of omittedFields) {
      delete stripped[field];
    }
    return stripped;
  });
}

function createRemoteUpdateHandler(input: {
  ingestDocuments: (
    table: string,
    documents: Array<Record<string, unknown>>,
  ) => Promise<void>;
  schema: Definition;
  tableName: string;
}) {
  return (remoteDocs: Array<Record<string, unknown>>) => {
    const cleaned = stripOmittedFields(input.schema, remoteDocs);
    Fx.detach(
      () =>
        Fx.run(
          Fx.from({
            ok: () => input.ingestDocuments(input.tableName, cleaned),
            err: (e) => e as Error,
          }).pipe(
            Fx.inspect((err) =>
              Fx.sync(() => {
                log.error(
                  `sync: failed to ingest remote data for "${input.tableName}"`,
                  err,
                );
              }),
            ),
            Fx.recover(() => Fx.unit),
          ),
        ),
      `[sync] ingest ${input.tableName}:`,
    );
  };
}

function createRemoteSubscriptionErrorHandler(tableName: string) {
  return (err: Error) => {
    log.error(`sync: remote subscription error for "${tableName}"`, err);
  };
}

function registerRemoteSubscription(input: {
  ingestDocuments: (
    table: string,
    documents: Array<Record<string, unknown>>,
  ) => Promise<void>;
  onUnsubscribe: (unsub: () => void) => void;
  remoteClient: ConvexClient;
  tableConfig: TableConfig;
  tableName: string;
}) {
  const unsub = (input.remoteClient as any).onUpdate(
    input.tableConfig.query,
    input.tableConfig.resolveArgs?.() ?? {},
    createRemoteUpdateHandler({
      ingestDocuments: input.ingestDocuments,
      schema: input.tableConfig.schema,
      tableName: input.tableName,
    }),
    createRemoteSubscriptionErrorHandler(input.tableName),
  );

  input.onUnsubscribe(unsub);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @internal
 *
 * Per-table sync configuration.
 *
 * - `resolve` — the Yjs CRDT catch-up query called on connect/reconnect
 *   to merge any state that diverged while offline.
 * - `query` — the standard Convex query that the sync engine subscribes to
 *   on the remote while online. When the remote pushes new results the
 *   sync engine diffs them against local state and ingests the changes.
 */
export interface TableConfig {
  /** The resolve query reference (from register() output). */
  resolve: unknown;

  /**
   * The remote query reference to subscribe to while online.
   *
   * This should be the same query the app uses locally (e.g.
   * `api.tasks.list`). The remote `ConvexClient` subscribes to it
   * reactively and pipes every update into the embedded runtime.
   */
  query: unknown;

  /** Optional args factory for the remote resolve-scoped subscription query. */
  resolveArgs?: () => Record<string, unknown>;

  /**
   * The schema {@link Definition} for this table (from `schema.define()`).
   *
   * Required for the Yjs CRDT resolve path: the sync engine uses this to
   * encode local documents into Yjs state vectors, apply server diffs,
   * and materialize merged Yjs docs back to plain records.
   *
   * Also used to strip `schema.omit()`-ed fields from remote documents
   * before ingesting them into the embedded runtime.
   */
  schema: Definition;
}

/**
 * @internal
 *
 * The embedded client — provides both the `ConvexClient` for local
 * mutations and the `ingestDocuments` capability for remote → local sync.
 *
 * This matches the {@link EmbeddedClient} interface exported by
 * `@robelest/convex-embedded/browser`.
 */
export interface EmbeddedClientLike {
  readonly client: ConvexClient;
  ingestDocuments(
    table: string,
    documents: Array<Record<string, unknown>>,
  ): Promise<void>;

  /**
   * Return all documents for a table from the local embedded database.
   *
   * Used by the resolve path to encode local Yjs state vectors before
   * sending them to the server for CRDT diff computation.
   */
  getDocumentsForTable(table: string): Promise<Array<Record<string, unknown>>>;

  /**
   * Execute a query directly against the embedded database, bypassing
   * the ConvexClient subscription machinery.
   *
   * When provided, IdMap and PendingQueue use this for hydration reads
   * instead of `client.query()`. This avoids the `Invalid start version`
   * bug caused by hydration subscriptions colliding with the app's
   * `useQuery` version counter on the shared ConvexClient.
   *
   * Optional — when absent, hydration falls back to `client.query()`.
   */
  queryDirect?(path: string, args: Record<string, unknown>): Promise<unknown>;

  /**
   * Execute a `_system:*` mutation directly against the embedded database,
   * bypassing the ConvexClient session, version counter, and loopback
   * WebSocket entirely.
   *
   * Used by IdMap and PendingQueue for internal bookkeeping writes
   * (`_system:idMapSet`, `_system:pendingPush`, etc.). These writes must
   * not produce Transition messages that race with app-query Transitions —
   * doing so causes `Invalid start version` errors.
   *
   * The browser entry point binds this to `EmbeddedRuntime.mutationDirect`.
   *
   * Optional — when absent, falls back to `localClient.mutation()`.
   */
  mutationDirect?(
    ref: unknown,
    args: Record<string, unknown>,
  ): Promise<unknown>;

  /**
   * Execute a user-facing mutation on the local ConvexClient, bypassing
   * only the **patched** `client.mutation()` (to avoid infinite recursion)
   * but still routing through the loopback WebSocket so `useQuery`
   * reactivity fires.
   *
   * This is the original, unpatched `ConvexClient.mutation` captured
   * before `patchedMutation` is installed.
   *
   * Used by `engine.mutation()` for the user's local write step.
   *
   * Optional — when absent, falls back to `localClient.mutation()`.
   */
  localMutation?(ref: unknown, args: Record<string, unknown>): Promise<unknown>;
}

/** @internal */
export interface EngineConfig {
  /**
   * The embedded client — receives all mutations first for instant
   * local writes, and supports `ingestDocuments` for remote → local sync.
   */
  embedded: EmbeddedClientLike;

  /**
   * A ConvexClient pointed at the remote Convex backend.
   * Used for resolve queries, reactive subscriptions, and forwarding
   * mutations.
   */
  remoteClient: ConvexClient;

  /** Table configurations keyed by table name. */
  tables: Record<string, TableConfig>;

  /** Maximum number of retries for resolve calls (default: 3). */
  maxRetries?: number;

  /** Delay between retries in ms (default: 1000). Doubles on each retry. */
  retryDelayMs?: number;

  /**
   * Returns the active identity key for identity-scoped local sync state.
   */
  getIdentityKey?: () => string | null;
}

type ChangeListener = (status: EngineStatus) => void;

type SyncCycleRoute =
  | { _tag: "Skip" }
  | { _tag: "DeferUntilQueueDrains" }
  | { _tag: "Resolve" };

type QueueEntryRoute =
  | { _tag: "Stop" }
  | { _tag: "DropMappedCreate"; localResult: string }
  | { _tag: "Push"; localResult: unknown };

type StartLifecycleRoute =
  | { _tag: "Offline" }
  | { _tag: "WaitForHydrationThenOnline" };

type LocalYjsEntry = {
  localDoc: Record<string, unknown>;
  yjsDoc: Y.Doc;
};

type ResolveDocument = {
  docId: string;
  vector: ArrayBuffer;
};

type ResolveResultRow = {
  docId: string;
  diff?: ArrayBuffer;
};

type PreparedResolveInput = {
  localYjsMap: Map<string, LocalYjsEntry>;
  resolveDocuments: Array<ResolveDocument>;
  schemaDef: Definition;
};

type MergeResolveOutput = {
  diffCount: number;
  mergedDocs: Array<Record<string, unknown>>;
};

/** @internal */
export interface EngineInstance {
  /** Start monitoring network state and triggering resolves. */
  start(): void;

  /** Stop monitoring and clean up listeners. */
  stop(): void;

  /** Subscribe to status changes. Returns unsubscribe function. */
  on(event: "change", listener: ChangeListener): () => void;

  /** Get the current status. */
  getStatus(): EngineStatus;

  /**
   * Proxy a mutation through the sync engine.
   *
   * 1. Writes to the local embedded client (instant, always awaited).
   * 2. Persists to the pending queue for durability.
   * 3. When online: processes queue serially with ID translation.
   * 4. When offline: queue waits until reconnect.
   *
   * Returns the local mutation result immediately.
   */
  mutation(ref: unknown, args: Record<string, unknown>): Promise<unknown>;

  /** Manually trigger a resolve cycle (e.g., after coming back online). */
  resolveNow(): Promise<void>;

  /** Re-hydrate identity-scoped state and resume sync for the active identity. */
  reloadIdentity(): Promise<void>;

  /** Number of mutations waiting to be pushed to remote. */
  pendingCount(): number;

  /** Access the ID map (for testing / advanced use). */
  readonly idMap: IdMap;

  /** Access the pending queue (for testing / advanced use). */
  readonly pendingQueue: PendingQueue;

  /** Async dispose — delegates to stop(). */
  [Symbol.asyncDispose](): Promise<void>;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * State transitions:
 *   [*] → Offline (no network)
 *   [*] → Resolving (network available)
 *   Offline → Resolving (online event)
 *   Resolving → Resolved (all resolve() calls succeed)
 *   Resolving → Error (resolve() fails after retries)
 *   Resolved → Offline (offline event)
 *   Resolved → Resolving (reconnect after temporary disconnect)
 *   Error → Resolving (retry / online event)
 *   Offline → Offline (mutations queue locally)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Infer the table name from a mutation function reference.
 *
 * Convex function references have an internal structure with the UDF path.
 * The convention is `"tableName:functionName"` — we extract the table part.
 * Falls back to empty string if the ref doesn't match expected patterns.
 */
function inferTableFromRef(
  ref: unknown,
  tables: Record<string, TableConfig>,
): string {
  // Try to extract the UDF path from a function reference object.
  // Convex SDK function references have a `name` property like "tasks:create".
  const name =
    typeof ref === "string"
      ? ref
      : typeof ref === "object" && ref !== null && "name" in ref
        ? String((ref as Record<string, unknown>).name)
        : "";

  // Extract module name (before the colon) and check if it's a known table.
  const moduleName = name.split(":")[0] ?? "";
  if (moduleName in tables) {
    return moduleName;
  }

  // Fallback: return first registered table (common case: single table app)
  const tableNames = Object.keys(tables);
  return tableNames[0] ?? "";
}

function matchTag<
  T extends Record<K, string>,
  K extends keyof T & string,
  Handlers extends {
    [V in T[K] & string]: (value: Extract<T, Record<K, V>>) => unknown;
  },
>(value: T, key: K, handlers: Handlers): ReturnType<Handlers[T[K] & string]> {
  const handler = handlers[value[key] as T[K] & string] as (
    current: T,
  ) => ReturnType<Handlers[T[K] & string]>;
  return handler(value);
}

function getSyncCycleRoute(input: {
  aborted: boolean;
  forceResolve: boolean;
  hasPending: boolean;
  isOnline: boolean;
  started: boolean;
}): SyncCycleRoute {
  if (input.aborted) return { _tag: "Skip" };
  if (!input.forceResolve && (!input.started || !input.isOnline)) {
    return { _tag: "Skip" };
  }
  if (input.hasPending) {
    return { _tag: "DeferUntilQueueDrains" };
  }
  return { _tag: "Resolve" };
}

function shouldStartRemoteSubscriptions(input: {
  aborted: boolean;
  forceResolve: boolean;
  hasPending: boolean;
  isOnline: boolean;
  started: boolean;
}): boolean {
  return (
    !input.aborted &&
    input.started &&
    input.isOnline &&
    !input.hasPending &&
    !input.forceResolve
  );
}

function getStartLifecycleRoute(input: {
  hasNavigator: boolean;
  navigatorOnline: boolean | undefined;
}): StartLifecycleRoute {
  return input.hasNavigator && input.navigatorOnline === false
    ? { _tag: "Offline" }
    : { _tag: "WaitForHydrationThenOnline" };
}

function createHydrationAwareOnlineHandler(input: {
  handleOnline: () => void;
  hydrationPromise: Promise<unknown>;
  isStarted: () => boolean;
}): () => void {
  return () => {
    void input.hydrationPromise.then(() => {
      if (input.isStarted()) {
        input.handleOnline();
      }
    });
  };
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return buf;
}

function prepareResolveInput(
  schemaDef: Definition,
  localDocs: Array<Record<string, unknown>>,
): PreparedResolveInput {
  return localDocs.reduce<PreparedResolveInput>(
    (acc, doc) => {
      const docId = doc._id as string | undefined;
      if (!docId) {
        return acc;
      }

      const yjsDoc = initYjsDoc(schemaDef, doc);
      acc.localYjsMap.set(docId, { localDoc: doc, yjsDoc });
      acc.resolveDocuments.push({
        docId,
        vector: toArrayBuffer(Y.encodeStateVector(yjsDoc)),
      });
      return acc;
    },
    {
      schemaDef,
      localYjsMap: new Map<string, LocalYjsEntry>(),
      resolveDocuments: [],
    },
  );
}

function createResolveRetrySchedule(input: {
  maxRetries: number;
  retryDelayMs: number;
  signal?: AbortSignal;
}) {
  return Fx.retry.while(
    Fx.retry.compose(
      Fx.retry.jittered(Fx.retry.exponential(input.retryDelayMs)),
      Fx.retry.recurs(input.maxRetries - 1),
    ),
    (meta) => {
      if (input.signal?.aborted) return false;
      const err = meta.input as Error;
      return !(err instanceof DOMException && err.name === "AbortError");
    },
  );
}

function mergeResolveResult(input: {
  localYjsMap: Map<string, LocalYjsEntry>;
  resolveResult: Array<ResolveResultRow>;
  schemaDef: Definition;
  tableName: string;
}): MergeResolveOutput {
  return input.resolveResult.reduce<MergeResolveOutput>(
    (acc, { docId, diff }) => {
      const entry = input.localYjsMap.get(docId);
      if (!entry) {
        log.warn(
          `sync: resolve returned diff for unknown doc "${docId}" in "${input.tableName}"`,
        );
        return acc;
      }

      if (diff) {
        Y.applyUpdateV2(entry.yjsDoc, new Uint8Array(diff));
        acc.diffCount += 1;
      }

      const materialized = materializeYjsDoc(input.schemaDef, entry.yjsDoc);
      materialized._id = entry.localDoc._id;
      materialized._creationTime = entry.localDoc._creationTime;
      acc.mergedDocs.push(materialized);
      return acc;
    },
    { diffCount: 0, mergedDocs: [] },
  );
}

function ingestMergedDocsFx(input: {
  ingestDocuments: (
    table: string,
    documents: Array<Record<string, unknown>>,
  ) => Promise<void>;
  mergedDocs: Array<Record<string, unknown>>;
  tableName: string;
}) {
  return input.mergedDocs.length === 0
    ? Fx.unit
    : Fx.from({
        ok: () => input.ingestDocuments(input.tableName, input.mergedDocs),
        err: (e) => e as Error,
      });
}

function getQueueEntryRoute(input: {
  entry: PendingEntry | undefined;
  hasLocalId: (localId: string) => boolean;
  isOnline: boolean;
  signal?: AbortSignal;
}): QueueEntryRoute {
  if (input.entry === undefined || !input.isOnline || input.signal?.aborted) {
    return { _tag: "Stop" };
  }

  const localResult = JSON.parse(input.entry.localResult);
  return input.entry.ref.endsWith(":create") &&
    typeof localResult === "string" &&
    input.hasLocalId(localResult)
    ? { _tag: "DropMappedCreate", localResult }
    : { _tag: "Push", localResult };
}

// ---------------------------------------------------------------------------
// engine.create()
// ---------------------------------------------------------------------------

function createEngine(config: EngineConfig): EngineInstance {
  const {
    embedded,
    remoteClient,
    tables,
    maxRetries = 3,
    retryDelayMs = 1000,
    getIdentityKey,
  } = config;

  // Destructure the embedded client for convenience.
  const localClient = embedded.client;
  const ingestDocuments = embedded.ingestDocuments.bind(embedded);
  const getDocumentsForTable = embedded.getDocumentsForTable.bind(embedded);
  const queryDirect = embedded.queryDirect?.bind(embedded);
  // System mutation bypass — runs _system:* writes directly against the
  // embedded database, bypassing the ConvexClient entirely. Used by
  // IdMap and PendingQueue so their writes don't produce Transition
  // messages that race with app-query Transitions.
  const mutationDirect = embedded.mutationDirect?.bind(embedded);
  // User mutation bypass — the original, unpatched ConvexClient.mutation.
  // Routes through the loopback WebSocket (so useQuery updates) but avoids
  // infinite recursion through patchedMutation.
  const localMutation = embedded.localMutation?.bind(embedded);

  const tableNames = Object.keys(tables);

  let status: EngineStatus = { status: "idle" };
  const listeners = new Set<ChangeListener>();
  let started = false;
  let abortController: AbortController | null = null;

  // ID map and persistent pending queue.
  // When queryDirect / mutationDirect are available, all reads and
  // writes bypass the patched ConvexClient methods entirely —
  // preventing infinite recursion through patchedMutation.
  const idMap = new IdMap(
    localClient,
    queryDirect,
    mutationDirect,
    getIdentityKey,
  );
  const pendingQueue = new PendingQueue(
    localClient,
    queryDirect,
    mutationDirect,
    getIdentityKey,
  );

  // Track whether we believe we're online (based on network events)
  let isOnline = false;

  // Serial queue processor state
  let queueProcessingPromise: Promise<void> | null = null;
  let syncCyclePromise: Promise<void> | null = null;

  // Network event handlers
  let onOnline: (() => void) | null = null;
  let onOffline: (() => void) | null = null;

  // Active remote reactive subscriptions (unsubscribe functions)
  const remoteUnsubscribes: Array<() => void> = [];

  function emit(newStatus: EngineStatus) {
    status = newStatus;
    for (const listener of listeners) {
      try {
        listener(newStatus);
      } catch (err) {
        log.error("sync: listener threw", err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Serial queue processor — processes pending mutations one at a time
  // -------------------------------------------------------------------------

  /**
   * Process the pending queue serially.
   *
   * Each mutation is awaited before the next starts. This ensures:
   * 1. `create` completes and populates the ID map before a subsequent
   *    `update`/`remove` that references the same document.
   * 2. Ordering is preserved — mutations replay in the exact order they
   *    were issued locally.
   *
   * On failure, the entry stays in the queue for retry on next cycle.
   */
  async function processQueue(signal?: AbortSignal): Promise<void> {
    if (queueProcessingPromise) return queueProcessingPromise;
    if (pendingQueue.isEmpty) return;

    log.info(`sync: processing ${pendingQueue.length} queued mutation(s)`);

    queueProcessingPromise = Fx.run(
      Fx.bracket(
        // Acquire: no-op, queueProcessingPromise is the active guard
        Fx.unit,
        // Use: process entries
        () =>
          Fx.gen(function* () {
            while (!pendingQueue.isEmpty && isOnline && !signal?.aborted) {
              const entry = pendingQueue.peek();
              const route = getQueueEntryRoute({
                entry,
                hasLocalId: (localId) => idMap.hasLocalId(localId),
                isOnline,
                signal,
              });

              const shouldContinue = yield* matchTag(route, "_tag", {
                Stop: () => Fx.succeed(false),
                DropMappedCreate: () =>
                  Fx.from({
                    ok: () => pendingQueue.shift(),
                    err: (e) => e as Error,
                  }).pipe(
                    Fx.tap(() =>
                      Fx.sync(() => {
                        log.debug(
                          `sync: dropping already-mapped create mutation (remaining: ${pendingQueue.length})`,
                        );
                      }),
                    ),
                    Fx.map(() => true),
                  ),
                Push: (current) =>
                  Fx.from({
                    ok: async () => {
                      const ref = makeFunctionReference<"mutation">(entry!.ref);
                      const originalArgs = JSON.parse(entry!.args) as Record<
                        string,
                        unknown
                      >;
                      const translatedArgs = idMap.translateArgs(originalArgs);
                      const remoteResult = await (remoteClient as any).mutation(
                        ref,
                        translatedArgs,
                      );

                      if (
                        typeof current.localResult === "string" &&
                        typeof remoteResult === "string" &&
                        current.localResult !== remoteResult
                      ) {
                        await idMap.set(
                          current.localResult,
                          remoteResult,
                          entry!.table,
                        );
                      }

                      await pendingQueue.shift();

                      log.debug(
                        `sync: pushed mutation to remote (table: ${entry!.table}, remaining: ${pendingQueue.length})`,
                      );
                      return true;
                    },
                    err: (e) => e as Error,
                  }).pipe(
                    Fx.inspect((err) =>
                      Fx.sync(() =>
                        log.warn(
                          "sync: remote push failed, stopping queue processing",
                          err,
                        ),
                      ),
                    ),
                    Fx.recover(() => Fx.succeed(false)),
                  ),
              });

              if (!shouldContinue) break;
            }
          }),
        // Release: no-op, queueProcessingPromise is cleared in finally()
        () => Fx.unit,
      ),
    ).finally(() => {
      queueProcessingPromise = null;
    });

    await queueProcessingPromise;

    if (pendingQueue.isEmpty) {
      log.info("sync: queue fully processed");
    }
  }

  function runSyncCycle(options?: { forceResolve?: boolean }): Promise<void> {
    if (syncCyclePromise) return syncCyclePromise;

    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;

    syncCyclePromise = Fx.run(
      Fx.gen(function* () {
        yield* Fx.from({
          ok: () => processQueue(signal),
          err: (e) => e as Error,
        });

        const route = getSyncCycleRoute({
          aborted: signal.aborted,
          forceResolve: options?.forceResolve ?? false,
          hasPending: !pendingQueue.isEmpty,
          isOnline,
          started,
        });

        yield* matchTag(route, "_tag", {
          Skip: () => Fx.unit,
          DeferUntilQueueDrains: () =>
            Fx.sync(() => {
              stopRemoteSubscriptions();
              log.warn(
                "sync: deferring resolve and remote subscriptions until pending queue drains",
              );
            }),
          Resolve: () =>
            Fx.from({
              ok: () => resolveAll(signal),
              err: (e) => e as Error,
            }),
        });

        if (
          shouldStartRemoteSubscriptions({
            aborted: signal.aborted,
            forceResolve: options?.forceResolve ?? false,
            hasPending: !pendingQueue.isEmpty,
            isOnline,
            started,
          })
        ) {
          startRemoteSubscriptions();
        }
      }).pipe(
        Fx.inspect((err) =>
          Fx.sync(() => {
            if (!(err instanceof DOMException && err.name === "AbortError")) {
              log.error("sync: online cycle failed", err);
            }
          }),
        ),
        Fx.recover(() => Fx.unit),
      ),
    ).finally(() => {
      syncCyclePromise = null;
      if (abortController?.signal === signal) {
        abortController = null;
      }
    });

    return syncCyclePromise;
  }

  // -------------------------------------------------------------------------
  // Resolve — pulls remote state via CRDT diff
  // -------------------------------------------------------------------------

  function resolveAll(signal?: AbortSignal): Promise<void> {
    const progress: ResolveProgress = {
      tables: [...tableNames],
      completed: 0,
      total: tableNames.length,
    };

    emit({ status: "resolving", progress });

    return Fx.run(
      Fx.each(tableNames, (tableName) =>
        Fx.defer(() => {
          if (signal?.aborted) {
            return Fx.fail(new DOMException("Aborted", "AbortError"));
          }
          return resolveTableFx(tableName, tables[tableName]!, signal).pipe(
            Fx.tap(() =>
              Fx.sync(() => {
                progress.completed++;
                emit({ status: "resolving", progress: { ...progress } });
              }),
            ),
          );
        }),
      ).pipe(
        Fx.tap(() =>
          Fx.sync(() => {
            emit({ status: "resolved" });
            log.info("sync: all tables resolved successfully");
          }),
        ),
        Fx.inspect((err) =>
          Fx.sync(() => {
            if (signal?.aborted) return;
            if (err instanceof DOMException && err.name === "AbortError")
              return;
            log.error("sync: resolve failed", err);
            emit({
              status: "error",
              error: err instanceof Error ? err : new Error(String(err)),
            });
          }),
        ),
        // Recover so the outer promise doesn't reject for resolve failures
        // (they're already surfaced via status emission)
        Fx.recover((err) => {
          if (err instanceof DOMException && err.name === "AbortError") {
            return Fx.unit as any;
          }
          return Fx.unit as any;
        }),
        Fx.map(() => undefined as void),
      ),
    );
  }

  function resolveTableFx(
    tableName: string,
    tableConfig: TableConfig,
    signal?: AbortSignal,
  ) {
    let attempts = 0;
    const retrySchedule = createResolveRetrySchedule({
      maxRetries,
      retryDelayMs,
      signal,
    });

    return Fx.gen(function* () {
      // ------------------------------------------------------------------
      // 1. Read local documents and encode Yjs state vectors.
      // ------------------------------------------------------------------

      const localDocs = yield* Fx.from({
        ok: () => getDocumentsForTable(tableName),
        err: (e) => e as Error,
      });

      const { schemaDef, localYjsMap, resolveDocuments } = prepareResolveInput(
        tableConfig.schema,
        localDocs,
      );

      log.debug(
        `sync: resolving "${tableName}" with ${resolveDocuments.length} local doc(s)`,
      );

      // ------------------------------------------------------------------
      // 2. Call the remote resolve query with retry.
      // ------------------------------------------------------------------

      const resolveResult: Array<ResolveResultRow> = yield* Fx.defer(() => {
        if (signal?.aborted) {
          return Fx.fail(new DOMException("Aborted", "AbortError"));
        }
        attempts++;
        return Fx.from({
          ok: () =>
            (remoteClient as any).query(tableConfig.resolve, {
              documents: resolveDocuments,
            }) as Promise<Array<ResolveResultRow>>,
          err: (err) => err as Error,
        });
      }).pipe(
        Fx.inspect((err) =>
          Fx.sync(() => {
            if (!(err instanceof DOMException && err.name === "AbortError")) {
              log.warn(
                `sync: resolve attempt ${attempts}/${maxRetries} failed for "${tableName}"`,
                err,
              );
            }
          }),
        ),
        Fx.retry(retrySchedule),
      );

      // ------------------------------------------------------------------
      // 3. Apply diffs, materialize, and ingest.
      // ------------------------------------------------------------------

      const { mergedDocs, diffCount } = mergeResolveResult({
        localYjsMap,
        resolveResult,
        schemaDef,
        tableName,
      });

      // ------------------------------------------------------------------
      // 4. Ingest the merged documents.
      //    ingestDocuments diffs against local state, so docs that didn't
      //    change will be no-ops (no unnecessary writes).
      // ------------------------------------------------------------------

      yield* ingestMergedDocsFx({
        ingestDocuments,
        mergedDocs,
        tableName,
      });

      log.debug(
        `sync: resolved table "${tableName}" — ` +
          `${resolveResult.length} doc(s), ${diffCount} diff(s) applied`,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Reactive remote subscriptions
  // -------------------------------------------------------------------------

  /**
   * Subscribe to each table's remote query via `remoteClient.onUpdate()`.
   *
   * When the remote Convex backend pushes new query results (because
   * any client mutated the data), the callback diffs the remote
   * documents against local state and ingests the changes into the
   * embedded runtime.
   *
   * This is the primary mechanism for cross-client real-time sync
   * while online. Resolve (Yjs CRDT diff) handles the offline
   * catch-up case.
   */
  function startRemoteSubscriptions(): void {
    // Avoid duplicate subscriptions.
    stopRemoteSubscriptions();

    for (const [tableName, tableConfig] of Object.entries(tables)) {
      registerRemoteSubscription({
        ingestDocuments,
        onUnsubscribe: (unsub) => remoteUnsubscribes.push(unsub),
        remoteClient,
        tableConfig,
        tableName,
      });
    }

    log.info(`sync: subscribed to ${tableNames.length} remote table(s)`);
  }

  /**
   * Unsubscribe from all active remote reactive subscriptions.
   */
  function stopRemoteSubscriptions(): void {
    if (remoteUnsubscribes.length === 0) return;

    for (const unsub of remoteUnsubscribes) {
      try {
        unsub();
      } catch {
        // Ignore — the remote client may already be closed.
      }
    }
    remoteUnsubscribes.length = 0;

    log.info("sync: unsubscribed from remote tables");
  }

  // -------------------------------------------------------------------------
  // Network event handlers
  // -------------------------------------------------------------------------

  function handleOnline() {
    log.info("sync: online event — flushing queue, resolving, subscribing");
    isOnline = true;

    // Process the serial queue, pull remote state, then start reactive
    // subscriptions so we receive ongoing changes from other clients.
    Fx.detach(() => runSyncCycle(), "[sync] handleOnline:");
  }

  function handleOffline() {
    log.info("sync: offline event");
    isOnline = false;
    abortController?.abort();
    abortController = null;
    stopRemoteSubscriptions();
    emit({ status: "offline" });
  }

  function hydrateIdentityState(): Promise<void> {
    return Fx.run(
      Fx.zip(
        Fx.from({ ok: () => idMap.hydrate(), err: (e) => e as Error }),
        Fx.from({ ok: () => pendingQueue.hydrate(), err: (e) => e as Error }),
      ).pipe(
        Fx.inspect((err) =>
          Fx.sync(() => log.warn("sync: hydration failed", err)),
        ),
        Fx.recover(() => Fx.unit),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    start() {
      if (started) return;
      started = true;

      log.info("sync: started");

      // Hydrate ID map and pending queue from embedded DB.
      // This is fire-and-forget — the queue processor will wait
      // for hydration to complete before accessing the data.
      const hydrationPromise = hydrateIdentityState();

      const runOnlineAfterHydration = createHydrationAwareOnlineHandler({
        handleOnline,
        hydrationPromise,
        isStarted: () => started,
      });

      const hasNavigator =
        typeof globalThis !== "undefined" && "navigator" in globalThis;
      const nav = hasNavigator
        ? (globalThis as { navigator?: { onLine?: boolean } }).navigator
        : undefined;

      const startRoute = getStartLifecycleRoute({
        hasNavigator,
        navigatorOnline: nav?.onLine,
      });

      matchTag(startRoute, "_tag", {
        Offline: () => {
          isOnline = false;
          emit({ status: "offline" });
        },
        WaitForHydrationThenOnline: () => {
          runOnlineAfterHydration();
        },
      });

      if (hasNavigator) {
        onOnline = runOnlineAfterHydration;
        onOffline = handleOffline;
        globalThis.addEventListener("online", onOnline);
        globalThis.addEventListener("offline", onOffline);
      }
    },

    stop() {
      if (!started) return;
      started = false;

      log.info("sync: stopped");

      abortController?.abort();
      abortController = null;

      stopRemoteSubscriptions();

      if (onOnline) globalThis.removeEventListener("online", onOnline);
      if (onOffline) globalThis.removeEventListener("offline", onOffline);
      onOnline = null;
      onOffline = null;

      listeners.clear();
      emit({ status: "idle" });
    },

    on(event: "change", listener: ChangeListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getStatus(): EngineStatus {
      return status;
    },

    mutation(ref: unknown, args: Record<string, unknown>): Promise<unknown> {
      // 1. Write to local embedded client first (instant).
      // 2. Persist to pending queue for durability.
      // 3. When online: kick the serial queue processor.
      //
      // Use localMutation when available — it calls the original,
      // unpatched ConvexClient.mutation() which still routes through
      // the loopback WebSocket (so useQuery reactivity fires) but
      // avoids infinite recursion through patchedMutation.
      //
      // NOTE: This is NOT the same as mutationDirect, which bypasses
      // the ConvexClient entirely. User mutations need reactivity.
      const localMutate = localMutation
        ? (r: unknown, a: Record<string, unknown>) => localMutation(r, a)
        : (r: unknown, a: Record<string, unknown>) =>
            (localClient as any).mutation(r, a) as Promise<unknown>;
      return Fx.run(
        Fx.from({
          ok: () => localMutate(ref, args),
          err: (e) => e as Error,
        }).pipe(
          Fx.tap((localResult) =>
            Fx.from({
              ok: async () => {
                const table = inferTableFromRef(ref, tables);
                await pendingQueue.push(ref, args, localResult, table);

                if (isOnline) {
                  stopRemoteSubscriptions();
                  void runSyncCycle();
                } else {
                  log.debug("sync: offline — mutation queued for later push");
                }
              },
              err: (e) => e as Error,
            }).pipe(
              Fx.inspect((err) =>
                Fx.sync(() => log.warn("sync: failed to queue mutation", err)),
              ),
            ),
          ),
        ),
      );
    },

    resolveNow(): Promise<void> {
      if (isOnline) {
        stopRemoteSubscriptions();
      }
      return runSyncCycle({ forceResolve: true });
    },

    async reloadIdentity(): Promise<void> {
      await hydrateIdentityState();

      if (!started) {
        return;
      }

      if (isOnline) {
        stopRemoteSubscriptions();
        await runSyncCycle({ forceResolve: true });
        return;
      }

      emit({ status: "offline" });
    },

    pendingCount(): number {
      return pendingQueue.length;
    },

    get idMap() {
      return idMap;
    },

    get pendingQueue() {
      return pendingQueue;
    },

    async [Symbol.asyncDispose](): Promise<void> {
      this.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** @internal */
export const engine = {
  create: createEngine,
};
