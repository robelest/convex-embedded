import { createLogger, setLoggerDebug } from "@resolve/shared/logger";
import { describe, expect, it, vi, type MockInstance } from "@tests/testkit";

interface ConsoleSpies {
  debug: MockInstance<typeof console.debug>;
  info: MockInstance<typeof console.info>;
  warn: MockInstance<typeof console.warn>;
  error: MockInstance<typeof console.error>;
}

function spyOnConsole(): ConsoleSpies {
  return {
    debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

describe("createLogger", () => {
  it("mirrors info to console with the category when debug enabled", ({
    track,
  }) => {
    const spies = spyOnConsole();
    track({ close: () => setLoggerDebug(false) });
    setLoggerDebug(true);

    createLogger("test").info("hello");

    expect(spies.info).toHaveBeenCalledWith("[convex-embedded:test] hello");
  });

  it("passes extra args through", ({ track }) => {
    const spies = spyOnConsole();
    track({ close: () => setLoggerDebug(false) });
    const extra = { foo: 42 };

    createLogger("cat").warn("warning", extra);

    expect(spies.warn).toHaveBeenCalledWith(
      "[convex-embedded:cat] warning",
      extra,
    );
  });

  it("delegates debug to console.debug when enabled", ({ track }) => {
    const spies = spyOnConsole();
    track({ close: () => setLoggerDebug(false) });
    setLoggerDebug(true);

    createLogger("verbose").debug("trace msg");

    expect(spies.debug).toHaveBeenCalledWith(
      "[convex-embedded:verbose] trace msg",
    );
  });

  it("silences debug by default", ({ track }) => {
    const spies = spyOnConsole();
    track({ close: () => setLoggerDebug(false) });

    createLogger("verbose").debug("trace msg");

    expect(spies.debug).not.toHaveBeenCalled();
  });

  it("mirrors warn and error to console once; info stays silent by default", ({
    track,
  }) => {
    const spies = spyOnConsole();
    track({ close: () => setLoggerDebug(false) });
    const log = createLogger("noisy");

    log.info("info msg");
    log.warn("warn msg");
    log.error("error msg");

    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.error).toHaveBeenCalledTimes(1);
  });
});
