/**
 * Deterministic runtime ops that replace non-deterministic globals during
 * UDF execution.
 *
 * Every UDF invocation gets a fresh {@link OpsContext} that provides:
 * - A seeded PRNG (`random`, `randomUUID`)
 * - A pinned timestamp (`now`)
 * - Captured console output
 *
 * This mirrors the approach used by the real Convex UDF runtime
 * (see `udf-runtime/src/setup.ts`), but implemented entirely in
 * user-space without patching globals.
 */

import { logs, SeverityNumber } from "@opentelemetry/api-logs";

const UDF_LOGGER_NAME = "convex-embedded:udf";

export type LogLevel = "log" | "warn" | "error" | "info" | "debug";

export interface CapturedConsole {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

function formatLogArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack ?? arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

/**
 * Mulberry32 — a simple, fast 32-bit seeded PRNG with a full 2^32 period.
 * Returns a function that produces numbers in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

const HEX = "0123456789abcdef";

/**
 * Generate a RFC 4122 version 4 UUID using the provided PRNG.
 *
 * Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 * where `y` is one of [8, 9, a, b].
 */
function uuidV4(rng: () => number): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 4) {
    const r = (rng() * 0x100000000) >>> 0;
    bytes[i] = r & 0xff;
    bytes[i + 1] = (r >>> 8) & 0xff;
    bytes[i + 2] = (r >>> 16) & 0xff;
    bytes[i + 3] = (r >>> 24) & 0xff;
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  let uuid = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) {
      uuid += "-";
    }
    uuid += HEX[bytes[i]! >> 4];
    uuid += HEX[bytes[i]! & 0x0f];
  }
  return uuid;
}

/**
 * Deterministic execution context created fresh for each UDF invocation.
 *
 * Provides replacements for `Math.random`, `Date.now`, `crypto.randomUUID`,
 * and `console.*` that are fully deterministic (given the same seed) and
 * whose side-effects (console output) can be inspected after execution.
 */
export class OpsContext {
  private readonly rng: () => number;
  private readonly pinnedTimestamp: number;

  /** Captured console proxy. */
  readonly console: CapturedConsole;

  constructor(seed: number, timestamp: number) {
    this.rng = mulberry32(seed);
    this.pinnedTimestamp = timestamp;

    const record = (
      level: LogLevel,
      severityNumber: SeverityNumber,
      args: unknown[],
    ): void => {
      logs.getLogger(UDF_LOGGER_NAME).emit({
        severityNumber,
        severityText: level,
        body: formatLogArgs(args),
        attributes: { source: "udf" },
      });
    };
    this.console = {
      log: (...args: unknown[]) => record("log", SeverityNumber.INFO, args),
      warn: (...args: unknown[]) => record("warn", SeverityNumber.WARN, args),
      error: (...args: unknown[]) => record("error", SeverityNumber.ERROR, args),
      info: (...args: unknown[]) => record("info", SeverityNumber.INFO, args),
      debug: (...args: unknown[]) => record("debug", SeverityNumber.DEBUG, args),
    };
  }

  /** Seeded PRNG — drop-in replacement for `Math.random()`. */
  random(): number {
    return this.rng();
  }

  /** Pinned timestamp — drop-in replacement for `Date.now()`. */
  now(): number {
    return this.pinnedTimestamp;
  }

  /** Deterministic UUID v4 — drop-in replacement for `crypto.randomUUID()`. */
  randomUUID(): string {
    return uuidV4(this.rng);
  }
}

let opsSeedCounter = 0;

/**
 * Create a fresh {@link OpsContext} for a single UDF invocation.
 *
 * @param seed — PRNG seed. Pass an explicit seed for reproducible test runs.
 *   When omitted, the seed mixes the wall clock with a per-invocation counter
 *   so that invocations occurring within the same millisecond still receive
 *   distinct seeds (otherwise rapid mutations would replay identical
 *   `crypto.randomUUID()` sequences and collide on document ids).
 */
export function createOpsContext(seed?: number): OpsContext {
  const timestamp = Date.now();
  const effectiveSeed =
    seed ?? ((timestamp ^ Math.imul(opsSeedCounter++, 0x9e3779b1)) | 0);
  return new OpsContext(effectiveSeed, timestamp);
}
