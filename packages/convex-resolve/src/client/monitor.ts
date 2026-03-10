/**
 * monitor — orchestrates resolve on connect/reconnect and proxies mutations.
 *
 * The monitor bridges local embedded runtime and remote Convex:
 *   1. Monitors network state (online/offline)
 *   2. On connect: hydrates ID map + pending queue, flushes queued mutations
 *      with ID translation, then calls resolve() for every registered table
 *   3. Proxies mutations: writes locally first (instant), persists to pending
 *      queue, then pushes to remote with translated IDs (serial queue)
 *   4. Tracks resolve progress and exposes status to the app
 *   5. Handles errors and retries
 *
 * Usage:
 *   import { monitor } from 'convex-resolve/client';
 *   import { ConvexClient } from 'convex/browser';
 *   import { getClient } from 'convex-embedded/browser';
 *   import { api } from '../convex/_generated/api';
 *
 *   const localClient = getClient({ modules, workerUrl });
 *   const remoteClient = new ConvexClient(CONVEX_URL);
 *   const m = monitor.create({
 *     localClient,
 *     remoteClient,
 *     tables: {
 *       tasks: { resolve: api.tasks.resolve },
 *     },
 *   });
 *
 *   m.start();
 *   m.on('change', (status) => console.log(status));
 *
 *   // All mutations go through the monitor
 *   await m.mutation(api.tasks.create, { title: 'Buy milk', body: '' });
 *   m.stop();
 */

import { Fx } from "@robelest/fx";
import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { IdMap } from "@/client/id-map";
import { PendingQueue } from "@/client/pending-queue";
import { createLogger } from "@/shared/logger";
import type { MonitorStatus, ResolveProgress } from "@/shared/types";

const log = createLogger("monitor");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Table configuration for the monitor. Each table has a `resolve`
 * query reference that the monitor calls on connect/reconnect.
 */
export interface TableConfig {
  /** The resolve query reference (from register() output). */
  resolve: unknown;
}

export interface MonitorConfig {
  /**
   * The local embedded ConvexClient — receives all mutations first
   * for instant local writes.
   */
  localClient: ConvexClient;

  /**
   * A ConvexClient pointed at the remote Convex backend.
   * Used for resolve queries and forwarding mutations.
   */
  remoteClient: ConvexClient;

  /** Table configurations keyed by table name. */
  tables: Record<string, TableConfig>;

  /** Maximum number of retries for resolve calls (default: 3). */
  maxRetries?: number;

  /** Delay between retries in ms (default: 1000). Doubles on each retry. */
  retryDelayMs?: number;
}

type ChangeListener = (status: MonitorStatus) => void;

export interface MonitorInstance {
  /** Start monitoring network state and triggering resolves. */
  start(): void;

  /** Stop monitoring and clean up listeners. */
  stop(): void;

  /** Subscribe to status changes. Returns unsubscribe function. */
  on(event: "change", listener: ChangeListener): () => void;

  /** Get the current status. */
  getStatus(): MonitorStatus;

  /**
   * Proxy a mutation through the monitor.
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

// ---------------------------------------------------------------------------
// monitor.create()
// ---------------------------------------------------------------------------

function createMonitor(config: MonitorConfig): MonitorInstance {
  const {
    localClient,
    remoteClient,
    tables,
    maxRetries = 3,
    retryDelayMs = 1000,
  } = config;
  const tableNames = Object.keys(tables);

  let status: MonitorStatus = { status: "idle" };
  const listeners = new Set<ChangeListener>();
  let started = false;
  let abortController: AbortController | null = null;

  // ID map and persistent pending queue
  const idMap = new IdMap(localClient);
  const pendingQueue = new PendingQueue(localClient);

  // Track whether we believe we're online (based on network events)
  let isOnline = false;

  // Serial queue processor state
  let processingQueue = false;

  // Network event handlers
  let onOnline: (() => void) | null = null;
  let onOffline: (() => void) | null = null;

  function emit(newStatus: MonitorStatus) {
    status = newStatus;
    for (const listener of listeners) {
      try {
        listener(newStatus);
      } catch (err) {
        log.error("monitor: listener threw", err);
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
  async function processQueue(): Promise<void> {
    if (processingQueue) return;
    if (pendingQueue.isEmpty) return;

    processingQueue = true;
    log.info(
      `monitor: processing ${pendingQueue.length} queued mutation(s)`,
    );

    try {
      while (!pendingQueue.isEmpty && isOnline) {
        const entry = pendingQueue.peek();
        if (entry === undefined) break;

        try {
          // Deserialize the entry.
          // entry.ref is a function name string (e.g. "tasks:create"),
          // reconstruct a proper FunctionReference for the Convex SDK.
          const ref = makeFunctionReference<"mutation">(entry.ref);
          const originalArgs = JSON.parse(entry.args) as Record<
            string,
            unknown
          >;
          const localResult = JSON.parse(entry.localResult);

          // Translate local IDs → remote IDs in the args
          const translatedArgs = idMap.translateArgs(originalArgs);

          // Push to remote
          const remoteResult = await (remoteClient as any).mutation(
            ref,
            translatedArgs,
          );

          // If the local result was a string (likely a new document ID from
          // a create mutation) and the remote result is also a string,
          // record the ID mapping.
          if (
            typeof localResult === "string" &&
            typeof remoteResult === "string" &&
            localResult !== remoteResult
          ) {
            await idMap.set(localResult, remoteResult, entry.table);
          }

          // Successfully processed — remove from queue
          await pendingQueue.shift();

          log.debug(
            `monitor: pushed mutation to remote (table: ${entry.table}, remaining: ${pendingQueue.length})`,
          );
        } catch (err) {
          // Failed — stop processing. The entry stays in the queue for
          // retry on the next online cycle.
          log.warn(
            "monitor: remote push failed, stopping queue processing",
            err,
          );
          break;
        }
      }
    } finally {
      processingQueue = false;
    }

    if (pendingQueue.isEmpty) {
      log.info("monitor: queue fully processed");
    }
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
            log.info("monitor: all tables resolved successfully");
          }),
        ),
        Fx.inspect((err) =>
          Fx.sync(() => {
            if (signal?.aborted) return;
            if (err instanceof DOMException && err.name === "AbortError")
              return;
            log.error("monitor: resolve failed", err);
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

    const retrySchedule = Fx.retry.while(
      Fx.retry.compose(
        Fx.retry.jittered(Fx.retry.exponential(retryDelayMs)),
        Fx.retry.recurs(maxRetries - 1),
      ),
      (meta) => {
        if (signal?.aborted) return false;
        const err = meta.input as Error;
        if (err instanceof DOMException && err.name === "AbortError")
          return false;
        return true;
      },
    );

    return Fx.defer(() => {
      if (signal?.aborted) {
        return Fx.fail(new DOMException("Aborted", "AbortError"));
      }
      attempts++;
      return Fx.from({
        ok: () =>
          (remoteClient as any).query(
            tableConfig.resolve,
            { documents: [] },
          ) as Promise<unknown>,
        err: (err) => err as Error,
      });
    }).pipe(
      Fx.inspect((err) =>
        Fx.sync(() => {
          if (!(err instanceof DOMException && err.name === "AbortError")) {
            log.warn(
              `monitor: resolve attempt ${attempts}/${maxRetries} failed for "${tableName}"`,
              err,
            );
          }
        }),
      ),
      Fx.retry(retrySchedule),
      Fx.tap(() =>
        Fx.sync(() => log.debug(`monitor: resolved table "${tableName}"`)),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Network event handlers
  // -------------------------------------------------------------------------

  function handleOnline() {
    log.info("monitor: online event — flushing queue then resolving");
    isOnline = true;
    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;

    // Process the serial queue, then pull remote state.
    Fx.detach(
      () =>
        Fx.run(
          Fx.gen(function* () {
            yield* Fx.from({
              ok: () => processQueue(),
              err: (e) => e as Error,
            });

            if (signal.aborted) return;

            yield* Fx.from({
              ok: () => resolveAll(signal),
              err: (e) => e as Error,
            });
          }).pipe(
            Fx.inspect((err) =>
              Fx.sync(() => {
                if (
                  !(err instanceof DOMException && err.name === "AbortError")
                ) {
                  log.error("monitor: online cycle failed", err);
                }
              }),
            ),
            Fx.recover(() => Fx.unit),
          ),
        ),
      "[monitor] handleOnline:",
    );
  }

  function handleOffline() {
    log.info("monitor: offline event");
    isOnline = false;
    abortController?.abort();
    abortController = null;
    emit({ status: "offline" });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    start() {
      if (started) return;
      started = true;

      log.info("monitor: started");

      // Hydrate ID map and pending queue from embedded DB.
      // This is fire-and-forget — the queue processor will wait
      // for hydration to complete before accessing the data.
      const hydrationPromise = Promise.all([
        idMap.hydrate(),
        pendingQueue.hydrate(),
      ]).catch((err) => {
        log.warn("monitor: hydration failed", err);
      });

      if (typeof globalThis !== "undefined" && "navigator" in globalThis) {
        const nav = (globalThis as { navigator?: { onLine?: boolean } })
          .navigator;
        if (nav?.onLine === false) {
          isOnline = false;
          emit({ status: "offline" });
        } else {
          // Wait for hydration before the first online cycle
          void hydrationPromise.then(() => {
            if (started) handleOnline();
          });
        }

        onOnline = () => {
          void hydrationPromise.then(() => {
            if (started) handleOnline();
          });
        };
        onOffline = handleOffline;
        globalThis.addEventListener("online", onOnline);
        globalThis.addEventListener("offline", onOffline);
      } else {
        void hydrationPromise.then(() => {
          if (started) handleOnline();
        });
      }
    },

    stop() {
      if (!started) return;
      started = false;

      log.info("monitor: stopped");

      abortController?.abort();
      abortController = null;

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

    getStatus(): MonitorStatus {
      return status;
    },

    mutation(
      ref: unknown,
      args: Record<string, unknown>,
    ): Promise<unknown> {
      // 1. Write to local embedded client first (instant).
      // 2. Persist to pending queue for durability.
      // 3. When online: kick the serial queue processor.
      return Fx.run(
        Fx.from({
          ok: () =>
            (localClient as any).mutation(ref, args) as Promise<unknown>,
          err: (e) => e as Error,
        }).pipe(
          Fx.tap((localResult) =>
            Fx.from({
              ok: async () => {
                const table = inferTableFromRef(ref, tables);
                await pendingQueue.push(ref, args, localResult, table);

                if (isOnline) {
                  // Kick the serial queue processor (fire-and-forget).
                  // It will pick up this entry and process it.
                  void processQueue();
                } else {
                  log.debug(
                    "monitor: offline — mutation queued for later push",
                  );
                }
              },
              err: (e) => e as Error,
            }).pipe(
              Fx.inspect((err) =>
                Fx.sync(() =>
                  log.warn("monitor: failed to queue mutation", err),
                ),
              ),
              Fx.recover(() => Fx.unit),
            ),
          ),
        ),
      );
    },

    resolveNow(): Promise<void> {
      abortController?.abort();
      abortController = new AbortController();
      const signal = abortController.signal;

      return Fx.run(
        Fx.gen(function* () {
          yield* Fx.from({
            ok: () => processQueue(),
            err: (e) => e as Error,
          });
          yield* Fx.from({
            ok: () => resolveAll(signal),
            err: (e) => e as Error,
          });
        }),
      );
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

export const monitor = {
  create: createMonitor,
};
