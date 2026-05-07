import type { ModuleLoader } from "@/kernel/modules";
import { createLogger } from "@/shared/logger";
import { getRouteMode, type RouteMode } from "@/shared/route";
import { recordCounter } from "@/tracing/metrics";

import type { CronSchedule } from "./cron";
import type {
  CronFunctionType,
  CronJobDefinition,
} from "./cron-runner";

const log = createLogger("cron-discover");

interface CronJobShape {
  name: unknown;
  args: unknown;
  schedule: unknown;
}

interface CronsShape {
  isCrons?: unknown;
  crons?: Record<string, CronJobShape>;
}

/**
 * Walk the `crons` module from the user's module registry and produce
 * {@link CronJobDefinition}s for each entry on the default-exported
 * `cronJobs()` object. Skips:
 *
 * - Jobs whose target function can't be loaded (logs + drops)
 * - Jobs whose target is wrapped in `remoteOnly()` — those fire on
 *   the server only; the embedded runtime ignores them
 * - Jobs with malformed schedules
 *
 * @returns the materialized job definitions; empty if `crons` is not
 *   in the registry or its default export isn't a `Crons` object.
 *
 * @public
 */
export async function discoverCronJobs(
  moduleLoader: ModuleLoader,
): Promise<CronJobDefinition[]> {
  let cronsModule;
  try {
    cronsModule = await moduleLoader.load("crons");
  } catch {
    return [];
  }
  const candidate = (cronsModule as { default?: unknown }).default ?? cronsModule;
  const shape = candidate as CronsShape;
  if (shape.isCrons !== true || typeof shape.crons !== "object" || shape.crons === null) {
    return [];
  }

  const jobs: CronJobDefinition[] = [];
  for (const [identifier, raw] of Object.entries(shape.crons)) {
    const job = await materializeCronJob(moduleLoader, identifier, raw);
    if (job !== null) {
      jobs.push(job);
    }
  }
  return jobs;
}

async function materializeCronJob(
  moduleLoader: ModuleLoader,
  identifier: string,
  raw: CronJobShape,
): Promise<CronJobDefinition | null> {
  if (typeof raw.name !== "string") {
    log.warn(`cron "${identifier}" has no function name; skipping`);
    return null;
  }
  const schedule = parseSchedule(raw.schedule);
  if (schedule === null) {
    log.warn(`cron "${identifier}" has invalid schedule shape; skipping`);
    return null;
  }
  const args = parseArgs(raw.args);
  let resolved: { type: CronFunctionType; routeMode: RouteMode | null };
  try {
    resolved = await resolveFunction(moduleLoader, raw.name);
  } catch (error) {
    log.warn(
      `cron "${identifier}" target "${raw.name}" could not be resolved; skipping`,
      error,
    );
    return null;
  }
  if (resolved.routeMode === "remote") {
    log.debug(
      `cron "${identifier}" target "${raw.name}" is remoteOnly; skipping local schedule`,
    );
    recordCounter("cron.discovery", {
      result: "skipped_remote_only",
      "convex.cron.name": identifier,
    });
    return null;
  }
  recordCounter("cron.discovery", {
    result: "registered",
    "convex.cron.name": identifier,
  });
  return {
    name: identifier,
    functionName: raw.name,
    type: resolved.type,
    args,
    schedule,
  };
}

function parseSchedule(raw: unknown): CronSchedule | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.type !== "string") return null;
  switch (r.type) {
    case "interval":
      if (typeof r.seconds === "number") {
        return { type: "interval", seconds: r.seconds };
      }
      if (typeof r.minutes === "number") {
        return { type: "interval", minutes: r.minutes };
      }
      if (typeof r.hours === "number") {
        return { type: "interval", hours: r.hours };
      }
      return null;
    case "hourly":
      if (typeof r.minuteUTC === "number") {
        return { type: "hourly", minuteUTC: r.minuteUTC };
      }
      return null;
    case "daily":
      if (
        typeof r.hourUTC === "number" &&
        typeof r.minuteUTC === "number"
      ) {
        return { type: "daily", hourUTC: r.hourUTC, minuteUTC: r.minuteUTC };
      }
      return null;
    case "weekly":
      if (
        typeof r.dayOfWeek === "string" &&
        typeof r.hourUTC === "number" &&
        typeof r.minuteUTC === "number"
      ) {
        return {
          type: "weekly",
          dayOfWeek: r.dayOfWeek as "sunday",
          hourUTC: r.hourUTC,
          minuteUTC: r.minuteUTC,
        };
      }
      return null;
    case "monthly":
      if (
        typeof r.day === "number" &&
        typeof r.hourUTC === "number" &&
        typeof r.minuteUTC === "number"
      ) {
        return {
          type: "monthly",
          day: r.day,
          hourUTC: r.hourUTC,
          minuteUTC: r.minuteUTC,
        };
      }
      return null;
    case "cron":
      if (typeof r.cron === "string") {
        return { type: "cron", cron: r.cron };
      }
      return null;
    default:
      return null;
  }
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw) && raw.length === 1 && typeof raw[0] === "object") {
    return (raw[0] as Record<string, unknown>) ?? {};
  }
  if (typeof raw === "object" && raw !== null) {
    return raw as Record<string, unknown>;
  }
  return {};
}

async function resolveFunction(
  moduleLoader: ModuleLoader,
  functionPath: string,
): Promise<{ type: CronFunctionType; routeMode: RouteMode | null }> {
  const colonIdx = functionPath.lastIndexOf(":");
  const modulePath =
    colonIdx >= 0 ? functionPath.slice(0, colonIdx) : functionPath;
  const exportName =
    colonIdx >= 0 ? functionPath.slice(colonIdx + 1) : "default";
  const mod = await moduleLoader.load(modulePath);
  const exported = (mod as Record<string, unknown>)[exportName];
  if (exported === undefined || exported === null) {
    throw new Error(
      `Module "${modulePath}" has no export "${exportName}" for cron target "${functionPath}".`,
    );
  }
  const flags = exported as { isMutation?: unknown; isAction?: unknown };
  const routeMode = getRouteMode(exported);
  if (flags.isAction === true) return { type: "action", routeMode };
  if (flags.isMutation === true) return { type: "mutation", routeMode };
  throw new Error(
    `Cron target "${functionPath}" must be a mutation or action; got ${typeof exported}.`,
  );
}
