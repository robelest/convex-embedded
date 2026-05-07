import {
  metrics,
  trace,
  SpanStatusCode,
  type Attributes,
  type Meter,
  type Span,
  type SpanOptions,
} from "@opentelemetry/api";

export const TRACER_NAME = "convex-embedded";
export const METER_NAME = "convex-embedded";

let probeLogged = false;

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

export function getMeter(): Meter {
  return metrics.getMeter(METER_NAME);
}

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

export function setAttrs(span: Span, attrs: Attributes): void {
  span.setAttributes(attrs);
}
