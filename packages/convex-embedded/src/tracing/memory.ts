import { context, metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { Resource } from "@opentelemetry/resources";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";

import {
  createBufferingLogRecordProcessor,
  createBufferingSpanProcessor,
  type BufferedLog,
  type BufferedMetricPoint,
  type BufferedSpan,
  type BufferingTracingHandle,
} from "@/tracing/buffer";
import { setLogCaptureActive, setTracingActive } from "@/tracing/spans";

/**
 * Options for {@link installInMemoryTracing}.
 *
 * @public
 */
export interface InMemoryTracingOptions {
  /**
   * Maximum number of spans to keep in the rolling buffer. Older
   * spans are evicted FIFO once exceeded. Default 2000; clamped to a
   * minimum of 16.
   */
  capacity?: number;
  /**
   * Optional OTel `Resource` describing the process. When omitted the
   * SDK's default resource is used.
   */
  resource?: Resource;
}

/**
 * Install in-memory tracer + meter providers and return a queryable
 * handle. Use in tests + dev tools to introspect everything the
 * runtime emits — spans, events, counters, gauges — without standing
 * up a real OTel collector.
 *
 * Calling this replaces the global tracer + meter providers, so it
 * affects every consumer of `getTracer()` / `getMeter()` in the
 * process. Tests should close the returned handle in teardown.
 *
 * @public
 */
export function installInMemoryTracing(
  options: InMemoryTracingOptions = {},
): BufferingTracingHandle {
  const capacity = Math.max(16, options.capacity ?? 2000);
  const processor = createBufferingSpanProcessor(capacity);
  const provider = new BasicTracerProvider({
    resource: options.resource,
    spanProcessors: [processor],
  });
  const contextManager = new StackContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
  setTracingActive(true);

  const metricExporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
    exportTimeoutMillis: 30_000,
  });
  const meterProvider = new MeterProvider({
    resource: options.resource,
    readers: [metricReader],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const logProcessor = createBufferingLogRecordProcessor(capacity);
  const loggerProvider = new LoggerProvider({
    resource: options.resource,
    processors: [logProcessor],
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  setLogCaptureActive(true);

  return {
    getSpans: (): BufferedSpan[] => processor.getSpans(),
    clearSpans: (): void => processor.clearSpans(),
    getLogs: (): BufferedLog[] => logProcessor.getLogs(),
    clearLogs: (): void => logProcessor.clearLogs(),
    subscribe: (callback) => {
      const unsubscribeSpans = processor.subscribe(callback);
      const unsubscribeLogs = logProcessor.subscribe(callback);
      return () => {
        unsubscribeSpans();
        unsubscribeLogs();
      };
    },
    getMetrics: async (): Promise<BufferedMetricPoint[]> => {
      await meterProvider.forceFlush();
      return gatherExportedMetrics(metricExporter);
    },
    close: async (): Promise<void> => {
      context.disable();
      trace.disable();
      metrics.disable();
      logs.disable();
      setLogCaptureActive(false);
      setTracingActive(false);
      await Promise.all([
        processor.shutdown(),
        provider.shutdown(),
        meterProvider.shutdown(),
        loggerProvider.shutdown(),
      ]);
    },
  };
}

function gatherExportedMetrics(
  exporter: InMemoryMetricExporter,
): BufferedMetricPoint[] {
  const out: BufferedMetricPoint[] = [];
  for (const resourceMetrics of exporter.getMetrics()) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        const kind = inferKind(metric.dataPointType);
        for (const point of metric.dataPoints) {
          const rawValue = (point as { value?: unknown }).value;
          out.push({
            name: metric.descriptor.name,
            kind,
            value: typeof rawValue === "number" ? rawValue : 0,
            attributes: { ...point.attributes },
            timeMs: hrTimeToMs(point.endTime),
          });
        }
      }
    }
  }
  exporter.reset();
  return out;
}

function inferKind(
  pointType: DataPointType,
): "counter" | "gauge" | "histogram" {
  if (
    pointType === DataPointType.HISTOGRAM ||
    pointType === DataPointType.EXPONENTIAL_HISTOGRAM
  ) {
    return "histogram";
  }
  if (pointType === DataPointType.GAUGE) return "gauge";
  return "counter";
}

function hrTimeToMs(hrTime: [number, number]): number {
  return hrTime[0] * 1000 + hrTime[1] / 1_000_000;
}

export type {
  BufferedLog,
  BufferedMetricPoint,
  BufferedSpan,
  BufferingTracingHandle,
} from "@/tracing/buffer";
