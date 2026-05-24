import { logs } from "@opentelemetry/api-logs";
import type { Resource } from "@opentelemetry/resources";
import { LoggerProvider, type LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import { setLogCaptureActive } from "@/tracing/spans";

export interface NodeTracingOptions {
  resource?: Resource;
  spanProcessors?: SpanProcessor[];
  logRecordProcessors?: LogRecordProcessor[];
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

  let loggerProvider: LoggerProvider | null = null;
  if (options.logRecordProcessors && options.logRecordProcessors.length > 0) {
    loggerProvider = new LoggerProvider({
      resource: options.resource,
      processors: options.logRecordProcessors,
    });
    logs.setGlobalLoggerProvider(loggerProvider);
    setLogCaptureActive(true);
  }

  return {
    close: async () => {
      await provider.shutdown();
      if (loggerProvider) {
        await loggerProvider.shutdown();
        setLogCaptureActive(false);
      }
    },
  };
}
