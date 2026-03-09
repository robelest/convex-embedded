/**
 * Scheduled function execution.
 *
 * Provides a simple setTimeout-based scheduler for deferred function
 * invocation, matching Convex's `ctx.scheduler.runAfter` semantics
 * in the embedded runtime.
 */

import type { Database } from "$/core/database";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SchedulerExecutorOptions {
  /** Reference to the database (reserved for future job persistence). */
  db: Database;
  /** Callback that executes a Convex function by path + args. */
  runFunction: (path: string, args: Record<string, unknown>) => Promise<void>;
}

interface PendingJob {
  timerId: ReturnType<typeof setTimeout>;
  functionPath: string;
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// SchedulerExecutor
// ---------------------------------------------------------------------------

/**
 * Manages deferred function execution using `setTimeout`.
 *
 * Each scheduled job gets a unique string ID that can be used to cancel
 * it before it fires. On {@link shutdown}, all pending timeouts are
 * cleared.
 */
export class SchedulerExecutor {
  private _db: Database;
  private _runFunction: (path: string, args: Record<string, unknown>) => Promise<void>;
  private _pending: Map<string, PendingJob> = new Map();
  private _nextId = 1;

  constructor(options: SchedulerExecutorOptions) {
    this._db = options.db;
    this._runFunction = options.runFunction;
  }

  /**
   * Schedule a function for execution after `delayMs` milliseconds.
   *
   * @param functionPath  Convex function path (e.g. `"messages:send"`).
   * @param args          Arguments to pass to the function.
   * @param delayMs       Delay in milliseconds (0 = next tick).
   * @returns A unique job ID that can be passed to {@link cancelJob}.
   */
  schedule(functionPath: string, args: Record<string, unknown>, delayMs: number): string {
    const jobId = `job_${this._nextId++}`;

    const timerId = setTimeout(() => {
      this._pending.delete(jobId);
      // Fire-and-forget; errors are swallowed to match Convex's
      // scheduled function semantics (failures are logged, not thrown).
      this._runFunction(functionPath, args).catch((err) => {
        console.error(
          `[SchedulerExecutor] Scheduled function "${functionPath}" failed:`,
          err,
        );
      });
    }, delayMs);

    this._pending.set(jobId, { timerId, functionPath, args });
    return jobId;
  }

  /**
   * Cancel a previously scheduled job. No-op if the job has already
   * executed or does not exist.
   */
  cancelJob(jobId: string): void {
    const job = this._pending.get(jobId);
    if (job) {
      clearTimeout(job.timerId);
      this._pending.delete(jobId);
    }
  }

  /** Clear all pending timeouts. */
  shutdown(): void {
    for (const job of this._pending.values()) {
      clearTimeout(job.timerId);
    }
    this._pending.clear();
  }
}
