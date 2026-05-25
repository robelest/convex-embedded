import { createLogger } from "@embedded/shared/logger";
import { installInMemoryTracing } from "@embedded/tracing/memory";
import type { BufferingTracingHandle } from "@embedded/tracing/memory";
import { withSpan } from "@embedded/tracing/spans";
import { afterEach, describe, expect, it } from "@tests/testkit";

let handle: BufferingTracingHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
});

describe("unified observability", () => {
  it("captures logger output as buffered log records", () => {
    handle = installInMemoryTracing();
    const log = createLogger("test-category");

    log.warn("hello world", { extra: 1 });

    const logs = handle.getLogs();
    const entry = logs.find((candidate) => candidate.body === "hello world");
    expect(entry).toBeDefined();
    expect(entry?.severity).toBe("warn");
    expect(entry?.attributes.category).toBe("test-category");
  });

  it("correlates a log emitted inside a span", async () => {
    handle = installInMemoryTracing();
    const log = createLogger("test-category");

    await withSpan("convex-embedded.test.op", () => {
      log.error("inside span");
      return Promise.resolve();
    });

    const entry = handle
      .getLogs()
      .find((candidate) => candidate.body === "inside span");
    expect(entry).toBeDefined();
    expect(entry?.traceId).toBeTruthy();
    expect(entry?.spanId).toBeTruthy();
  });

  it("is a noop when no provider is installed", () => {
    const log = createLogger("test-category");
    expect(() => log.info("no provider")).not.toThrow();
  });
});
