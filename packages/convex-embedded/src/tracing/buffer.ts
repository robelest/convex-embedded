/**
 * In-memory buffering for OpenTelemetry spans + metrics. Used by
 * {@link installInMemoryTracing} to give tests, dev overlays, and
 * debug surfaces a queryable handle without standing up a full OTel
 * collector pipeline.
 *
 * @packageDocumentation
 */

import { SpanStatusCode } from "@opentelemetry/api";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

/**
 * A snapshot of a finished span captured by {@link BufferingSpanProcessor}.
 * Mirrors `ReadableSpan` but flattens the parts callers actually inspect:
 * timing in milliseconds (not hrtime tuples), status as a string union, and
 * events with their attributes inlined.
 *
 * @public
 */
export interface BufferedSpan {
  /** Span name (e.g. `convex-embedded.runUdf.mutation`). */
  name: string;
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  /** Span start time in milliseconds since the unix epoch. */
  startMs: number;
  /** Wall-clock duration of the span in milliseconds. */
  durMs: number;
  attributes: Record<string, unknown>;
  status: "ok" | "error" | "unset";
  /** Populated only when `status === "error"`. */
  error?: string;
  /**
   * Span events recorded via `span.addEvent(...)` — used for
   * state-transition signals like `lease.acquired`, `replay.failed`,
   * `cron.skipped_remote_only`.
   */
  events: Array<{
    name: string;
    timeMs: number;
    attributes?: Record<string, unknown>;
  }>;
}

/**
 * A single observation of a counter / gauge / histogram emitted by
 * the embedded runtime, returned from
 * {@link BufferingTracingHandle.getMetrics}. One metric (e.g.
 * `convex.embedded.http_dispatch`) may produce multiple points across
 * different attribute sets (e.g. `result: "ok"` vs `result: "404"`).
 *
 * @public
 */
export interface BufferedMetricPoint {
  /** Metric name (e.g. `convex.embedded.replay.success`). */
  name: string;
  /** Metric kind. */
  kind: "counter" | "gauge" | "histogram";
  /** Numeric value at this collection cycle. */
  value: number;
  /** Attribute set for this point. */
  attributes: Record<string, unknown>;
  /** Timestamp of the latest observation in ms. */
  timeMs: number;
}

export interface BufferedLog {
  severity: string;
  severityNumber: number;
  body: string;
  attributes: Record<string, unknown>;
  timeMs: number;
  traceId?: string;
  spanId?: string;
}

/**
 * Handle returned by {@link installInMemoryTracing}. Lets tests and
 * dev tools introspect everything the runtime emits — spans, events,
 * counters, gauges — without standing up a real OTel collector.
 *
 * Closing the handle disables the global tracer + meter providers,
 * so call it in test teardown to avoid leakage between cases.
 *
 * @public
 */
export interface BufferingTracingHandle {
  /** Snapshot of every span finished since installation (or last `clearSpans`). */
  getSpans(): BufferedSpan[];
  clearSpans(): void;
  getLogs(): BufferedLog[];
  clearLogs(): void;
  /** Subscribe to a debounced callback that fires when new spans arrive. */
  subscribe(callback: () => void): () => void;
  /**
   * Force a metrics collection cycle and return every captured point. When
   * no metrics provider is installed (legacy tracing-only handle) this
   * returns an empty array.
   */
  getMetrics(): Promise<BufferedMetricPoint[]>;
  /** Tear down the providers + clear all buffers. */
  close(): Promise<void>;
}

type Listener = () => void;

export interface BufferingSpanProcessor extends SpanProcessor {
  getSpans(): BufferedSpan[];
  clearSpans(): void;
  subscribe(listener: Listener): () => void;
}

export function createBufferingSpanProcessor(
  capacity: number,
): BufferingSpanProcessor {
  const spans: BufferedSpan[] = [];
  const listeners = new Set<Listener>();
  let notifyHandle: ReturnType<typeof setTimeout> | null = null;

  function scheduleNotify(): void {
    if (notifyHandle !== null) return;
    notifyHandle = setTimeout(() => {
      notifyHandle = null;
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // ignore listener errors
        }
      }
    }, 50);
  }

  return {
    forceFlush(): Promise<void> {
      return Promise.resolve();
    },
    onStart(): void {},
    onEnd(span: ReadableSpan): void {
      const ctx = span.spanContext();
      const startMs = hrTimeToMs(span.startTime);
      const endMs = hrTimeToMs(span.endTime);
      const status = span.status.code;
      const buffered: BufferedSpan = {
        name: span.name,
        spanId: ctx.spanId,
        parentSpanId: span.parentSpanContext?.spanId,
        traceId: ctx.traceId,
        startMs,
        durMs: Math.max(0, endMs - startMs),
        attributes: { ...span.attributes },
        status:
          status === SpanStatusCode.OK
            ? "ok"
            : status === SpanStatusCode.ERROR
              ? "error"
              : "unset",
        error:
          status === SpanStatusCode.ERROR ? span.status.message : undefined,
        events: span.events.map((event) => ({
          name: event.name,
          timeMs: hrTimeToMs(event.time),
          attributes: event.attributes ? { ...event.attributes } : undefined,
        })),
      };
      spans.push(buffered);
      if (spans.length > capacity) {
        spans.splice(0, spans.length - capacity);
      }
      scheduleNotify();
    },
    shutdown(): Promise<void> {
      if (notifyHandle !== null) {
        clearTimeout(notifyHandle);
        notifyHandle = null;
      }
      listeners.clear();
      spans.length = 0;
      return Promise.resolve();
    },
    getSpans(): BufferedSpan[] {
      return spans.slice();
    },
    clearSpans(): void {
      spans.length = 0;
      scheduleNotify();
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface BufferingLogRecordProcessor extends LogRecordProcessor {
  getLogs(): BufferedLog[];
  clearLogs(): void;
  subscribe(listener: Listener): () => void;
}

export function createBufferingLogRecordProcessor(
  capacity: number,
): BufferingLogRecordProcessor {
  const logs: BufferedLog[] = [];
  const listeners = new Set<Listener>();
  let notifyHandle: ReturnType<typeof setTimeout> | null = null;

  function scheduleNotify(): void {
    if (notifyHandle !== null) return;
    notifyHandle = setTimeout(() => {
      notifyHandle = null;
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // ignore listener errors
        }
      }
    }, 50);
  }

  return {
    onEmit(logRecord: SdkLogRecord): void {
      const sc = logRecord.spanContext;
      const body = logRecord.body;
      logs.push({
        severity:
          logRecord.severityText ??
          severityNumberToText(logRecord.severityNumber),
        severityNumber: logRecord.severityNumber ?? 0,
        body:
          typeof body === "string"
            ? body
            : body === undefined
              ? ""
              : JSON.stringify(body),
        attributes: { ...logRecord.attributes },
        timeMs: hrTimeToMs(logRecord.hrTime),
        traceId: sc?.traceId,
        spanId: sc?.spanId,
      });
      if (logs.length > capacity) {
        logs.splice(0, logs.length - capacity);
      }
      scheduleNotify();
    },
    forceFlush(): Promise<void> {
      return Promise.resolve();
    },
    shutdown(): Promise<void> {
      if (notifyHandle !== null) {
        clearTimeout(notifyHandle);
        notifyHandle = null;
      }
      listeners.clear();
      logs.length = 0;
      return Promise.resolve();
    },
    getLogs(): BufferedLog[] {
      return logs.slice();
    },
    clearLogs(): void {
      logs.length = 0;
      scheduleNotify();
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function severityNumberToText(severityNumber: number | undefined): string {
  if (severityNumber === undefined || severityNumber <= 0) return "info";
  if (severityNumber >= 21) return "fatal";
  if (severityNumber >= 17) return "error";
  if (severityNumber >= 13) return "warn";
  if (severityNumber >= 9) return "info";
  if (severityNumber >= 5) return "debug";
  return "trace";
}

function hrTimeToMs(hrTime: [number, number]): number {
  return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
}
