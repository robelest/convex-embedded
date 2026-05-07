import { metrics, trace } from "@opentelemetry/api";
import { Resource } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

import {
  BufferingSpanProcessor,
  type BufferedMetricPoint,
  type BufferedSpan,
  type BufferingTracingHandle,
} from "@/tracing/buffer";

export interface InMemoryTracingOptions {
  capacity?: number;
  resource?: Resource;
}

export function installInMemoryTracing(
  options: InMemoryTracingOptions = {},
): BufferingTracingHandle {
  const capacity = Math.max(16, options.capacity ?? 2000);
  const processor = new BufferingSpanProcessor(capacity);
  const provider = new BasicTracerProvider({
    resource: options.resource,
    spanProcessors: [processor],
  });
  const registered = trace.setGlobalTracerProvider(provider);

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

  // eslint-disable-next-line no-console
  console.log(
    `[tracing] installInMemoryTracing registered=${registered} capacity=${capacity}`,
  );
  const probeTracer = trace.getTracer("convex-embedded");
  // eslint-disable-next-line no-console
  console.log(
    `[tracing] probe tracer constructor=${probeTracer.constructor?.name ?? "?"}`,
  );

  return {
    getSpans: (): BufferedSpan[] => processor.getSpans(),
    clearSpans: (): void => processor.clearSpans(),
    subscribe: (callback) => processor.subscribe(callback),
    getMetrics: async (): Promise<BufferedMetricPoint[]> => {
      await meterProvider.forceFlush();
      return collectExportedMetrics(metricExporter);
    },
    close: async (): Promise<void> => {
      trace.disable();
      metrics.disable();
      await processor.shutdown();
      await provider.shutdown();
      await meterProvider.shutdown();
    },
  };
}

function collectExportedMetrics(
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
            attributes: { ...(point.attributes ?? {}) },
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
  BufferedMetricPoint,
  BufferedSpan,
  BufferingTracingHandle,
} from "@/tracing/buffer";
