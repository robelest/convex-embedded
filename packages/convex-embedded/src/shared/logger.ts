const PREFIX = "convex-embedded";

let debugEnabled = false;

export function setLoggerDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isLoggerDebug(): boolean {
  return debugEnabled;
}

function fmt(category: string, msg: string): string {
  return `[${PREFIX}:${category}] ${msg}`;
}

export function createLogger(category: string) {
  return {
    debug: (msg: string, ...args: unknown[]) => {
      if (!debugEnabled) return;
      console.debug(fmt(category, msg), ...args);
    },
    info: (msg: string, ...args: unknown[]) =>
      console.info(fmt(category, msg), ...args),
    warn: (msg: string, ...args: unknown[]) =>
      console.warn(fmt(category, msg), ...args),
    error: (msg: string, ...args: unknown[]) =>
      console.error(fmt(category, msg), ...args),
  };
}
