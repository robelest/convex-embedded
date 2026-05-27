/**
 * Thin wrappers around the OpenTelemetry tracing + metrics API used
 * throughout the embedded runtime. Apps install a tracer/meter
 * provider via {@link installInMemoryTracing} or one of the
 * platform-specific entries (`/tracing/browser`, `/tracing/node`);
 * the runtime then emits spans, events, counters, and gauges that
 * surface through the same handle.
 *
 * @packageDocumentation
 */

import {
  INVALID_SPAN_CONTEXT,
  metrics,
  trace,
  SpanStatusCode,
  type Attributes,
  type Meter,
  type Span,
  type SpanContext,
  type SpanOptions,
} from "@opentelemetry/api";
import { logs, type Logger } from "@opentelemetry/api-logs";

/** Stable tracer name used by every span the runtime emits. */
export const TRACER_NAME = "convex-embedded";

/** Stable meter name used by every counter / gauge the runtime emits. */
export const METER_NAME = "convex-embedded";

let logCaptureActive = false;
let tracingActive = false;

/**
 * Whether a tracer provider has been wired up. When false, {@link withSpan} /
 * {@link withSpanSync} skip span allocation entirely and invoke `fn` with a
 * shared no-op {@link Span}. The runtime's `installInMemoryTracing`,
 * `installNodeTracing`, and `installBrowserTracing` helpers flip this on
 * during setup and back off in their `close()` handlers.
 */
export function isTracingActive(): boolean {
  return tracingActive;
}

/**
 * Toggle the {@link withSpan} / {@link withSpanSync} fast path. Internal
 * helper called by the tracing install/close helpers.
 */
export function setTracingActive(active: boolean): void {
  tracingActive = active;
}

const NOOP_SPAN: Span = {
  spanContext(): SpanContext {
    return INVALID_SPAN_CONTEXT;
  },
  setAttribute() {
    return this;
  },
  setAttributes() {
    return this;
  },
  addEvent() {
    return this;
  },
  addLink() {
    return this;
  },
  addLinks() {
    return this;
  },
  setStatus() {
    return this;
  },
  updateName() {
    return this;
  },
  end() {},
  isRecording(): boolean {
    return false;
  },
  recordException() {},
};

/**
 * Whether a logger provider is installed and UDF console capture should run.
 * When false (production default), the runtime skips patching globals for log
 * capture so there is zero per-invocation overhead.
 *
 * @public
 */
export function isLogCaptureActive(): boolean {
  return logCaptureActive;
}

/**
 * Toggle UDF log capture. Called by the tracing install/close helpers when a
 * logger provider is wired up.
 *
 * @public
 */
export function setLogCaptureActive(active: boolean): void {
  logCaptureActive = active;
}

/**
 * Get the embedded runtime's tracer. Returns the global tracer keyed
 * on {@link TRACER_NAME}.
 *
 * @public
 */
export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Get the embedded runtime's logger. Returns the global logger keyed
 * on {@link TRACER_NAME}; LogRecords it emits flow to the same
 * in-memory buffer as spans and metrics.
 *
 * @public
 */
export function getLogger(): Logger {
  return logs.getLogger(TRACER_NAME);
}

/**
 * Get the embedded runtime's meter. Counters and observable gauges
 * registered via {@link recordCounter} / {@link registerGauge} are
 * created against this meter.
 *
 * @public
 */
export function getMeter(): Meter {
  return metrics.getMeter(METER_NAME);
}

/**
 * Run an async function inside a named span. The span auto-records
 * `OK` on success and `ERROR` on throw (with `recordException`), and
 * always ends in the `finally` block. Most runtime code paths should
 * use this rather than starting spans manually.
 *
 * @public
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  options?: SpanOptions,
): Promise<T> {
  if (!tracingActive) {
    return fn(NOOP_SPAN);
  }
  const tracer = getTracer();
  return tracer.startActiveSpan(name, options ?? {}, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      if (error instanceof Error) {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Synchronous variant of {@link withSpan}. Use only when the wrapped
 * function is genuinely synchronous; otherwise prefer the async
 * version.
 *
 * @public
 */
export function withSpanSync<T>(
  name: string,
  fn: (span: Span) => T,
  options?: SpanOptions,
): T {
  if (!tracingActive) {
    return fn(NOOP_SPAN);
  }
  const tracer = getTracer();
  return tracer.startActiveSpan(name, options ?? {}, (span) => {
    try {
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      if (error instanceof Error) {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Convenience helper for setting multiple attributes on a span. Equivalent
 * to `span.setAttributes(attrs)` but keeps call sites tighter when the
 * span value is referenced via destructuring.
 *
 * @internal
 */
export function setAttrs(span: Span, attrs: Attributes): void {
  span.setAttributes(attrs);
}

const MAX_CAPTURED_VALUE_CHARS = 8192;

export function captureValueAttr(
  span: Span,
  key: string,
  value: unknown,
): void {
  if (!logCaptureActive) {
    return;
  }
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    return;
  }
  span.setAttribute(
    key,
    json.length > MAX_CAPTURED_VALUE_CHARS
      ? json.slice(0, MAX_CAPTURED_VALUE_CHARS)
      : json,
  );
}
