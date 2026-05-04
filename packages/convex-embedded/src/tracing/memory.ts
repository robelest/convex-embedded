import { trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { Resource } from "@opentelemetry/resources";
import {
  BufferingSpanProcessor,
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
    close: async (): Promise<void> => {
      trace.disable();
      await processor.shutdown();
      await provider.shutdown();
    },
  };
}

export type { BufferedSpan, BufferingTracingHandle } from "@/tracing/buffer";
