import { logs } from "@opentelemetry/api-logs";
import type { Resource } from "@opentelemetry/resources";
import {
  LoggerProvider,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";

import { setLogCaptureActive, setTracingActive } from "@/tracing/spans";

export interface BrowserTracingOptions {
  resource?: Resource;
  spanProcessors?: SpanProcessor[];
  logRecordProcessors?: LogRecordProcessor[];
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
  setTracingActive(true);

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
      setTracingActive(false);
    },
  };
}
