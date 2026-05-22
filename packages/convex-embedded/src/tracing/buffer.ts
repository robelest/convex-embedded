/**
 * In-memory buffering for OpenTelemetry spans + metrics. Used by
 * {@link installInMemoryTracing} to give tests, dev overlays, and
 * debug surfaces a queryable handle without standing up a full OTel
 * collector pipeline.
 *
 * @packageDocumentation
 */

import { SpanStatusCode } from "@opentelemetry/api";
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

export class BufferingSpanProcessor implements SpanProcessor {
  private readonly _spans: BufferedSpan[] = [];
  private readonly _listeners = new Set<Listener>();
  private _notifyHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly _capacity: number) {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    if (this._spans.length === 0) {
      console.log(
        `[tracing] BufferingSpanProcessor.onEnd first span: ${span.name}`,
      );
    }
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
      error: status === SpanStatusCode.ERROR ? span.status.message : undefined,
      events: span.events.map((event) => ({
        name: event.name,
        timeMs: hrTimeToMs(event.time),
        attributes: event.attributes ? { ...event.attributes } : undefined,
      })),
    };
    this._spans.push(buffered);
    if (this._spans.length > this._capacity) {
      this._spans.splice(0, this._spans.length - this._capacity);
    }
    this._scheduleNotify();
  }

  shutdown(): Promise<void> {
    if (this._notifyHandle !== null) {
      clearTimeout(this._notifyHandle);
      this._notifyHandle = null;
    }
    this._listeners.clear();
    this._spans.length = 0;
    return Promise.resolve();
  }

  getSpans(): BufferedSpan[] {
    return this._spans.slice();
  }

  clearSpans(): void {
    this._spans.length = 0;
    this._scheduleNotify();
  }

  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private _scheduleNotify(): void {
    if (this._notifyHandle !== null) return;
    this._notifyHandle = setTimeout(() => {
      this._notifyHandle = null;
      for (const listener of this._listeners) {
        try {
          listener();
        } catch {
          // ignore listener errors
        }
      }
    }, 50);
  }
}

function hrTimeToMs(hrTime: [number, number]): number {
  return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
}
