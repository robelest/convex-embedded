/**
 * Scheduled function execution.
 *
 * Provides a simple setTimeout-based scheduler for deferred function
 * invocation, matching Convex's `ctx.scheduler.runAfter` semantics
 * in the embedded runtime.
 */

import type { Database } from "@/runtime/db/database";
import type { StoreMigrationManifest } from "@/runtime/migrations/types";
import { createLogger } from "@/shared/logger";
import { withSpan, withSpanSync } from "@/tracing/spans";

const log = createLogger("scheduler");

export const SCHEDULED_FUNCTIONS_STORE_MIGRATIONS: StoreMigrationManifest = {
  store: "scheduledFunctions",
  scope: "global",
  version: 1,
};

export interface SchedulerExecutorOptions {
  db: Database;
  runFunction: (path: string, args: Record<string, unknown>) => Promise<void>;
}

interface PendingJob {
  timerId: ReturnType<typeof setTimeout>;
  functionPath: string;
  args: Record<string, unknown>;
}

/**
 * Manages deferred function execution using `setTimeout`.
 *
 * Each scheduled job gets a unique string ID that can be used to cancel
 * it before it fires. On {@link SchedulerExecutor.shutdown}, all pending
 * timeouts are cleared.
 */
export interface SchedulerExecutor {
  schedule(
    functionPath: string,
    args: Record<string, unknown>,
    delayMs: number,
  ): string;
  cancelJob(jobId: string): void;
  shutdown(): void;
}

export function createSchedulerExecutor(
  options: SchedulerExecutorOptions,
): SchedulerExecutor {
  const runFunction = options.runFunction;
  const pending: Map<string, PendingJob> = new Map();
  let nextId = 1;

  return {
    schedule(
      functionPath: string,
      args: Record<string, unknown>,
      delayMs: number,
    ): string {
      return withSpanSync("convex-embedded.scheduler.schedule", (span) => {
        span.setAttribute("convex.function_path", functionPath);
        const jobId = `job_${nextId++}`;

        const timerId = setTimeout(() => {
          pending.delete(jobId);
          void withSpan("convex-embedded.scheduler.run", (runSpan) => {
            runSpan.setAttribute("convex.function_path", functionPath);
            return runFunction(functionPath, args).catch((error) => {
              log.error(`Scheduled function "${functionPath}" failed:`, error);
            });
          });
        }, delayMs);

        pending.set(jobId, { timerId, functionPath, args });
        return jobId;
      });
    },
    cancelJob(jobId: string): void {
      const job = pending.get(jobId);
      if (job) {
        clearTimeout(job.timerId);
        pending.delete(jobId);
      }
    },
    shutdown(): void {
      for (const job of pending.values()) {
        clearTimeout(job.timerId);
      }
      pending.clear();
    },
  };
}
