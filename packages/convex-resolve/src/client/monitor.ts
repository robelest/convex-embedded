/**
 * monitor — orchestrates resolve on connect/reconnect and proxies mutations.
 *
 * The monitor bridges local embedded runtime and remote Convex:
 *   1. Monitors network state (online/offline)
 *   2. On connect: flushes queued mutations, then calls resolve() for every
 *      registered table
 *   3. Proxies mutations: writes locally first (instant), then pushes to
 *      remote (fire-and-forget when online, queued when offline)
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

/** A queued mutation waiting to be pushed to the remote backend. */
interface QueuedMutation {
  ref: unknown;
  args: Record<string, unknown>;
}

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
   * 2. When online: pushes to remote via detach (fire-and-forget). On
   *    failure the mutation is queued for replay on reconnect.
   * 3. When offline: queues the mutation for later push.
   *
   * Returns the local mutation result immediately.
   */
  mutation(ref: unknown, args: Record<string, unknown>): Promise<unknown>;

  /** Manually trigger a resolve cycle (e.g., after coming back online). */
  resolveNow(): Promise<void>;

  /** Number of mutations waiting to be pushed to remote. */
  pendingCount(): number;

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

  // In-memory queue of mutations that need to be pushed to remote
  const mutationQueue: QueuedMutation[] = [];

  // Track whether we believe we're online (based on network events)
  let isOnline = false;

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
  // Queue flush — replays queued mutations to remote sequentially
  // -------------------------------------------------------------------------

  function flushQueue(signal?: AbortSignal): Promise<void> {
    if (mutationQueue.length === 0) return Promise.resolve();

    const count = mutationQueue.length;
    log.info(`monitor: flushing ${count} queued mutation(s) to remote`);

    // Snapshot the queue and clear it — if new mutations arrive during
    // flush they'll go directly to remote (we're online now).
    const batch = mutationQueue.splice(0);

    return Fx.run(
      Fx.each(batch, (entry) =>
        Fx.defer(() => {
          if (signal?.aborted) {
            return Fx.fail(new DOMException("Aborted", "AbortError"));
          }
          return Fx.from({
            ok: () =>
              (remoteClient as any).mutation(
                entry.ref,
                entry.args,
              ) as Promise<unknown>,
            err: (e) => e as Error,
          }).pipe(
            Fx.inspect((err) =>
              Fx.sync(() =>
                log.warn(
                  "monitor: queued mutation push failed (continuing)",
                  err,
                ),
              ),
            ),
            // Recover so one failure doesn't abort the rest of the queue
            Fx.recover(() => Fx.unit),
            Fx.map(() => undefined as void),
          );
        }),
      ).pipe(
        Fx.tap(() =>
          Fx.sync(() =>
            log.info(`monitor: flush complete (${count} mutation(s))`),
          ),
        ),
        Fx.map(() => undefined as void),
      ),
    );
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
  // Push a single mutation to remote (fire-and-forget via detach)
  // -------------------------------------------------------------------------

  function pushToRemote(ref: unknown, args: Record<string, unknown>): void {
    Fx.detach(
      () =>
        Fx.run(
          Fx.from({
            ok: () =>
              (remoteClient as any).mutation(ref, args) as Promise<unknown>,
            err: (e) => e as Error,
          }).pipe(
            Fx.inspect((err) =>
              Fx.sync(() => {
                log.warn(
                  "monitor: remote push failed, queueing for retry",
                  err,
                );
                mutationQueue.push({ ref, args });
              }),
            ),
            Fx.recover(() => Fx.unit),
          ),
        ),
      "[monitor] pushToRemote:",
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

    // Flush queued mutations first, then pull remote state.
    // The entire online cycle is wrapped in an Fx pipeline.
    Fx.detach(
      () =>
        Fx.run(
          Fx.gen(function* () {
            yield* Fx.from({
              ok: () => flushQueue(signal),
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

      if (typeof globalThis !== "undefined" && "navigator" in globalThis) {
        const nav = (globalThis as { navigator?: { onLine?: boolean } })
          .navigator;
        if (nav?.onLine === false) {
          isOnline = false;
          emit({ status: "offline" });
        } else {
          handleOnline();
        }

        onOnline = handleOnline;
        onOffline = handleOffline;
        globalThis.addEventListener("online", onOnline);
        globalThis.addEventListener("offline", onOffline);
      } else {
        handleOnline();
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
      // 2. Push to remote: fire-and-forget (detach) when online, queue offline.
      return Fx.run(
        Fx.from({
          ok: () =>
            (localClient as any).mutation(ref, args) as Promise<unknown>,
          err: (e) => e as Error,
        }).pipe(
          Fx.tap((result) =>
            Fx.sync(() => {
              if (isOnline) {
                pushToRemote(ref, args);
              } else {
                log.debug(
                  "monitor: offline — queueing mutation for later push",
                );
                mutationQueue.push({ ref, args });
              }
              return result;
            }),
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
            ok: () => flushQueue(signal),
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
      return mutationQueue.length;
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
