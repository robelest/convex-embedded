/**
 * monitor — orchestrates resolve on connect/reconnect.
 *
 * The monitor bridges local embedded runtime and remote Convex:
 *   1. Monitors network state (online/offline)
 *   2. On connect: calls resolve() for every registered table
 *   3. Tracks resolve progress and exposes status to the app
 *   4. Handles errors and retries
 *
 * Usage:
 *   import { monitor } from 'convex-resolve/client';
 *   import { ConvexClient } from 'convex/browser';
 *   import { api } from '../convex/_generated/api';
 *
 *   const remoteClient = new ConvexClient(CONVEX_URL);
 *   const m = monitor.create({
 *     remoteClient,
 *     tables: {
 *       tasks: { resolve: api.tasks.resolve },
 *       comments: { resolve: api.comments.resolve },
 *     },
 *   });
 *
 *   m.start();
 *   m.on('change', (status) => console.log(status));
 *   m.stop();
 */
import * as Y from "yjs";
import { Fx } from "@robelest/fx";
import type {
  MonitorStatus,
  ResolveProgress,
} from "@/shared/types";
import { createLogger } from "@/shared/logger";

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
  /** A ConvexClient pointed at the remote Convex backend. */
  remoteClient: { query(name: unknown, args: Record<string, unknown>): Promise<unknown> };

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

  /** Manually trigger a resolve cycle (e.g., after coming back online). */
  resolveNow(): Promise<void>;

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
  const { remoteClient, tables, maxRetries = 3, retryDelayMs = 1000 } = config;
  const tableNames = Object.keys(tables);

  let status: MonitorStatus = { status: "idle" };
  const listeners = new Set<ChangeListener>();
  let started = false;
  let abortController: AbortController | null = null;

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

  async function resolveAll(signal?: AbortSignal): Promise<void> {
    const progress: ResolveProgress = {
      tables: [...tableNames],
      completed: 0,
      total: tableNames.length,
    };

    emit({ status: "resolving", progress });

    for (const tableName of tableNames) {
      if (signal?.aborted) {
        log.debug("monitor: resolve aborted");
        return;
      }

      const tableConfig = tables[tableName]!;

      try {
        await resolveTable(tableName, tableConfig, signal);
        progress.completed++;
        emit({ status: "resolving", progress: { ...progress } });
      } catch (err) {
        if (signal?.aborted) return;
        log.error(`monitor: resolve failed for table "${tableName}"`, err);
        emit({
          status: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return;
      }
    }

    emit({ status: "resolved" });
    log.info("monitor: all tables resolved successfully");
  }

  async function resolveTable(
    tableName: string,
    tableConfig: TableConfig,
    signal?: AbortSignal,
  ): Promise<void> {
    let attempts = 0;

    const retrySchedule = Fx.retry.while(
      Fx.retry.compose(
        Fx.retry.jittered(Fx.retry.exponential(retryDelayMs)),
        Fx.retry.recurs(maxRetries - 1),
      ),
      (meta) => {
        // Stop retrying if the signal has been aborted
        if (signal?.aborted) return false;
        const err = meta.input as Error;
        if (err instanceof DOMException && err.name === "AbortError") return false;
        return true;
      },
    );

    const attempt = Fx.defer(() => {
      if (signal?.aborted) {
        return Fx.fail(new DOMException("Aborted", "AbortError"));
      }
      attempts++;
      return Fx.from({
        ok: () => remoteClient.query(tableConfig.resolve, { documents: [] }),
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
    );

    await Fx.run(
      attempt.pipe(
        Fx.retry(retrySchedule),
        Fx.tap(() =>
          Fx.sync(() =>
            log.debug(`monitor: resolved table "${tableName}"`),
          ),
        ),
      ),
    );
  }

  function handleOnline() {
    log.info("monitor: online event — starting resolve");
    abortController?.abort();
    abortController = new AbortController();
    resolveAll(abortController.signal).catch((err) => {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        log.error("monitor: resolveAll unhandled error", err);
      }
    });
  }

  function handleOffline() {
    log.info("monitor: offline event");
    // Abort any in-progress resolve
    abortController?.abort();
    abortController = null;
    emit({ status: "offline" });
  }

  return {
    start() {
      if (started) return;
      started = true;

      log.info("monitor: started");

      // Check initial network state
      if (typeof globalThis !== "undefined" && "navigator" in globalThis) {
        const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
        if (nav?.onLine === false) {
          emit({ status: "offline" });
        } else {
          handleOnline();
        }

        // Listen for network events
        onOnline = handleOnline;
        onOffline = handleOffline;
        globalThis.addEventListener("online", onOnline);
        globalThis.addEventListener("offline", onOffline);
      } else {
        // Server-side or non-browser — assume online
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

    async resolveNow(): Promise<void> {
      abortController?.abort();
      abortController = new AbortController();
      await resolveAll(abortController.signal);
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
