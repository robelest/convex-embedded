import { createLogger, setLoggerDebug } from "@resolve/shared/logger";
import { describe, it, expect, beforeEach, afterEach } from "@tests/testkit";
import { vi } from "vitest";

describe("createLogger", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setLoggerDebug(false);
  });

  it("creates a logger with category prefix", () => {
    const log = createLogger("test");
    log.info("hello");

    expect(console.info).toHaveBeenCalledWith("[convex-embedded:test] hello");
  });

  it("passes extra args through", () => {
    const log = createLogger("cat");
    const extra = { foo: 42 };
    log.warn("warning", extra);

    expect(console.warn).toHaveBeenCalledWith(
      "[convex-embedded:cat] warning",
      extra,
    );
  });

  it("delegates debug to console.debug when enabled", () => {
    setLoggerDebug(true);
    const log = createLogger("verbose");
    log.debug("trace msg");

    expect(console.debug).toHaveBeenCalledWith(
      "[convex-embedded:verbose] trace msg",
    );
  });

  it("silences debug by default", () => {
    const log = createLogger("verbose");
    log.debug("trace msg");

    expect(console.debug).not.toHaveBeenCalled();
  });

  it("logs info/warn/error", () => {
    const log = createLogger("noisy");
    log.info("info msg");
    log.warn("warn msg");
    log.error("error msg");

    expect(console.info).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
