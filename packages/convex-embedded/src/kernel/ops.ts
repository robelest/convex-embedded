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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "log" | "warn" | "error" | "info" | "debug";

export interface LogEntry {
  level: LogLevel;
  args: unknown[];
  timestamp: number;
}

export interface CapturedConsole {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Mulberry32 PRNG
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// UUID v4 generation from PRNG
// ---------------------------------------------------------------------------

const HEX = "0123456789abcdef";

/**
 * Generate a RFC 4122 version 4 UUID using the provided PRNG.
 *
 * Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 * where `y` is one of [8, 9, a, b].
 */
function uuidV4(rng: () => number): string {
  const bytes = new Uint8Array(16);
  // Fill with random bytes (4 bytes per rng call)
  for (let i = 0; i < 16; i += 4) {
    const r = (rng() * 0x100000000) >>> 0;
    bytes[i] = r & 0xff;
    bytes[i + 1] = (r >>> 8) & 0xff;
    bytes[i + 2] = (r >>> 16) & 0xff;
    bytes[i + 3] = (r >>> 24) & 0xff;
  }

  // Set version (4) and variant (10xx)
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let uuid = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) {
      uuid += "-";
    }
    uuid += HEX[bytes[i] >> 4];
    uuid += HEX[bytes[i] & 0x0f];
  }
  return uuid;
}

// ---------------------------------------------------------------------------
// OpsContext
// ---------------------------------------------------------------------------

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
  private readonly _logs: LogEntry[] = [];

  /** Captured console proxy. */
  readonly console: CapturedConsole;

  constructor(seed: number, timestamp: number) {
    this.rng = mulberry32(seed);
    this.pinnedTimestamp = timestamp;

    // Build the captured console once so the same object can be reused
    // throughout the UDF invocation.
    const logs = this._logs;
    const ts = this.pinnedTimestamp;
    this.console = {
      log(...args: unknown[]) {
        logs.push({ level: "log", args, timestamp: ts });
      },
      warn(...args: unknown[]) {
        logs.push({ level: "warn", args, timestamp: ts });
      },
      error(...args: unknown[]) {
        logs.push({ level: "error", args, timestamp: ts });
      },
      info(...args: unknown[]) {
        logs.push({ level: "info", args, timestamp: ts });
      },
      debug(...args: unknown[]) {
        logs.push({ level: "debug", args, timestamp: ts });
      },
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

  /** All console output captured during this invocation. */
  get logs(): ReadonlyArray<LogEntry> {
    return this._logs;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh {@link OpsContext} for a single UDF invocation.
 *
 * @param seed — PRNG seed. Defaults to `Date.now()` for convenience during
 *   development; pass an explicit seed for reproducible test runs.
 */
export function createOpsContext(seed?: number): OpsContext {
  const effectiveSeed = seed ?? Date.now();
  const timestamp = Date.now();
  return new OpsContext(effectiveSeed, timestamp);
}
