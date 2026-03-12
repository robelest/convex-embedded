const PREFIX = "convex-embedded";

function fmt(category: string, msg: string): string {
  return `[${PREFIX}:${category}] ${msg}`;
}

export function createLogger(category: string) {
  return {
    debug: (msg: string, ...args: unknown[]) =>
      console.debug(fmt(category, msg), ...args),
    info: (msg: string, ...args: unknown[]) =>
      console.info(fmt(category, msg), ...args),
    warn: (msg: string, ...args: unknown[]) =>
      console.warn(fmt(category, msg), ...args),
    error: (msg: string, ...args: unknown[]) =>
      console.error(fmt(category, msg), ...args),
  };
}
