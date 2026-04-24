import type { Resource } from "@opentelemetry/resources";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

export interface NodeTracingOptions {
  resource?: Resource;
  spanProcessors?: SpanProcessor[];
}

export interface InstalledTracing {
  close(): Promise<void>;
}

export async function installNodeTracing(
  options: NodeTracingOptions,
): Promise<InstalledTracing> {
  const provider = new NodeTracerProvider({
    resource: options.resource,
    spanProcessors: options.spanProcessors,
  });
  provider.register();
  return {
    close: () => provider.shutdown(),
  };
}
