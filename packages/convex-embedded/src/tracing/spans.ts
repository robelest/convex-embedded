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
  metrics,
  trace,
  SpanStatusCode,
  type Attributes,
  type Meter,
  type Span,
  type SpanOptions,
} from "@opentelemetry/api";

/** Stable tracer name used by every span the runtime emits. */
export const TRACER_NAME = "convex-embedded";

/** Stable meter name used by every counter / gauge the runtime emits. */
export const METER_NAME = "convex-embedded";

let probeLogged = false;

/**
 * Get the embedded runtime's tracer. Returns the global tracer keyed
 * on {@link TRACER_NAME}; logs a one-time probe identifying the
 * tracer's concrete class so misconfigured providers (e.g. forgetting
 * to call `installInMemoryTracing()`) are diagnosable.
 *
 * @public
 */
export function getTracer() {
  const tracer = trace.getTracer(TRACER_NAME);
  if (!probeLogged) {
    probeLogged = true;
    // eslint-disable-next-line no-console
    console.log(
      `[tracing] first getTracer() called, tracer=${tracer.constructor?.name ?? "?"}`,
    );
  }
  return tracer;
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
