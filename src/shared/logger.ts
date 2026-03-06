const PREFIX = "convex-resolve";

type LogLevel = "debug" | "info" | "warn" | "error";

function shouldLog(level: LogLevel): boolean {
  if (typeof globalThis !== "undefined" && "process" in globalThis) {
    const envLevel = (globalThis as any).process?.env?.CONVEX_RESOLVE_LOG;
    if (!envLevel) return level !== "debug";
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    return levels.indexOf(level) >= levels.indexOf(envLevel as LogLevel);
  }
  return level !== "debug";
}

function fmt(category: string, msg: string): string {
  return `[${PREFIX}:${category}] ${msg}`;
}

export function createLogger(category: string) {
  return {
    debug(msg: string, ...args: unknown[]) {
      if (shouldLog("debug")) console.debug(fmt(category, msg), ...args);
    },
    info(msg: string, ...args: unknown[]) {
      if (shouldLog("info")) console.info(fmt(category, msg), ...args);
    },
    warn(msg: string, ...args: unknown[]) {
      if (shouldLog("warn")) console.warn(fmt(category, msg), ...args);
    },
    error(msg: string, ...args: unknown[]) {
      if (shouldLog("error")) console.error(fmt(category, msg), ...args);
    },
  };
}
