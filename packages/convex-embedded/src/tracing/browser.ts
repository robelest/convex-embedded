import type { Resource } from "@opentelemetry/resources";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";

export interface BrowserTracingOptions {
  resource?: Resource;
  spanProcessors?: SpanProcessor[];
}

export interface InstalledTracing {
  close(): Promise<void>;
}

export async function installBrowserTracing(
  options: BrowserTracingOptions,
): Promise<InstalledTracing> {
  const provider = new WebTracerProvider({
    resource: options.resource,
    spanProcessors: options.spanProcessors,
  });
  provider.register();
  return {
    close: () => provider.shutdown(),
  };
}
