import { createLogger } from "@/shared/logger";
import { recordCounter } from "@/tracing/metrics";
import { withSpan } from "@/tracing/spans";

import { nextFireMs, type CronSchedule } from "./cron";

const log = createLogger("cron");

export type CronFunctionType = "mutation" | "action";

export interface CronJobDefinition {
  name: string;
  functionName: string;
  type: CronFunctionType;
  args: Record<string, unknown>;
  schedule: CronSchedule;
}

export interface CronRunnerOptions {
  jobs: ReadonlyArray<CronJobDefinition>;
  runFunction: (
    type: CronFunctionType,
    functionName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, delayMs: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

interface ScheduledTimer {
  handle: unknown;
  fireAtMs: number;
}

export class CronRunner {
  private jobs: ReadonlyArray<CronJobDefinition>;
  private readonly runFunction: CronRunnerOptions["runFunction"];
  private readonly now: () => number;
  private readonly setTimeout: (fn: () => void, delayMs: number) => unknown;
  private readonly clearTimeout: (handle: unknown) => void;
  private readonly timers = new Map<string, ScheduledTimer>();
  private readonly lastFireMs = new Map<string, number>();
  private started = false;
  private shuttingDown = false;

  constructor(options: CronRunnerOptions) {
    this.jobs = options.jobs;
    this.runFunction = options.runFunction;
    this.now = options.now ?? (() => Date.now());
    this.setTimeout =
      options.setTimeoutFn ??
      ((fn, delay) => globalThis.setTimeout(fn, delay));
    this.clearTimeout =
      options.clearTimeoutFn ??
      ((handle) =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  setJobs(jobs: ReadonlyArray<CronJobDefinition>): void {
    if (this.started) {
      throw new Error("CronRunner.setJobs must be called before start()");
    }
    this.jobs = jobs;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const job of this.jobs) {
      this.scheduleNext(job);
    }
  }

  shutdown(): void {
    this.shuttingDown = true;
    for (const timer of this.timers.values()) {
      this.clearTimeout(timer.handle);
    }
    this.timers.clear();
    this.started = false;
    this.shuttingDown = false;
  }

  private scheduleNext(job: CronJobDefinition): void {
    if (this.shuttingDown) return;
    const now = this.now();
    const fireAtMs = nextFireMs(job.schedule, now, this.lastFireMs.get(job.name));
    const delayMs = Math.max(0, fireAtMs - now);
    const existing = this.timers.get(job.name);
    if (existing !== undefined) {
      this.clearTimeout(existing.handle);
    }
    const handle = this.setTimeout(() => {
      void this.fire(job);
    }, delayMs);
    this.timers.set(job.name, { handle, fireAtMs });
    log.debug(
      `scheduled cron "${job.name}" -> fireAtMs=${fireAtMs} delayMs=${delayMs}`,
    );
  }

  private async fire(job: CronJobDefinition): Promise<void> {
    if (this.shuttingDown) return;
    const firedAtMs = this.now();
    this.lastFireMs.set(job.name, firedAtMs);
    this.timers.delete(job.name);
    await withSpan(
      "convex-embedded.cron.fire",
      async (span) => {
        span.setAttributes({
          "convex.cron.name": job.name,
          "convex.cron.function": job.functionName,
          "convex.cron.type": job.type,
        });
        try {
          await this.runFunction(job.type, job.functionName, job.args);
          span.addEvent("cron.completed", {
            "convex.cron.name": job.name,
          });
          recordCounter("cron.fire", {
            "convex.cron.name": job.name,
            result: "ok",
          });
        } catch (error) {
          log.error(
            `cron "${job.name}" handler ${job.functionName} threw`,
            error,
          );
          span.addEvent("cron.failed", {
            "convex.cron.name": job.name,
            "convex.error.message":
              error instanceof Error ? error.message : String(error),
          });
          recordCounter("cron.fire", {
            "convex.cron.name": job.name,
            result: "error",
          });
        }
      },
    );
    this.scheduleNext(job);
  }

  /** @internal exposed for tests. */
  getNextFireMs(name: string): number | undefined {
    return this.timers.get(name)?.fireAtMs;
  }
}
