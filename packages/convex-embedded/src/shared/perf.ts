import { createLogger } from "@/shared/logger";

const perfLog = createLogger("perf");

const DEFAULT_SLOW_THRESHOLD_MS = 32;

export function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function logSlow(
  label: string,
  startedAt: number,
  details?: Record<string, unknown>,
  thresholdMs = DEFAULT_SLOW_THRESHOLD_MS,
): number {
  const durationMs = nowMs() - startedAt;
  if (durationMs >= thresholdMs) {
    perfLog.warn(`${label} took ${durationMs.toFixed(1)}ms`, details ?? {});
  }
  return durationMs;
}
