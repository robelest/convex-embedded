import {
  SeverityNumber,
  type AnyValue,
  type AnyValueMap,
} from "@opentelemetry/api-logs";

import { getLogger } from "@/tracing/spans";

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

function toAttributeValue(value: unknown): AnyValue {
  if (value === null || value === undefined) {
    return null;
  }
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return value as AnyValue;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function buildAttributes(category: string, args: unknown[]): AnyValueMap {
  const attributes: AnyValueMap = { category };
  if (args.length > 0) {
    attributes.args = args.map(toAttributeValue);
  }
  return attributes;
}

function emitLog(
  category: string,
  severityNumber: SeverityNumber,
  severityText: string,
  msg: string,
  args: unknown[],
): void {
  getLogger().emit({
    severityNumber,
    severityText,
    body: msg,
    attributes: buildAttributes(category, args),
  });
}

export function createLogger(category: string) {
  return {
    debug: (msg: string, ...args: unknown[]) => {
      emitLog(category, SeverityNumber.DEBUG, "debug", msg, args);
      if (debugEnabled) {
        console.debug(fmt(category, msg), ...args);
      }
    },
    info: (msg: string, ...args: unknown[]) => {
      emitLog(category, SeverityNumber.INFO, "info", msg, args);
      if (debugEnabled) {
        console.info(fmt(category, msg), ...args);
      }
    },
    warn: (msg: string, ...args: unknown[]) => {
      emitLog(category, SeverityNumber.WARN, "warn", msg, args);
      console.warn(fmt(category, msg), ...args);
    },
    error: (msg: string, ...args: unknown[]) => {
      emitLog(category, SeverityNumber.ERROR, "error", msg, args);
      console.error(fmt(category, msg), ...args);
    },
  };
}
