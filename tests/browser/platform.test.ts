import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "@tests/testkit";

let openBrowserPersistence: ReturnType<typeof vi.fn>;

describe("clearBrowserLocalData", () => {
  beforeEach(() => {
    vi.resetModules();
    openBrowserPersistence = vi.fn();

    vi.doMock("@/browser/sqlite/adapter", () => ({
      openBrowserPersistence,
    }));
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("deletes sqlite files directly from OPFS when available", async () => {
    const removeEntry = vi.fn(async () => undefined);
    const getDirectory = vi.fn(async () => ({ removeEntry }));

    vi.stubGlobal("navigator", {
      storage: {
        getDirectory,
      },
    });

    const { clearBrowserLocalData } = await import("@resolve/browser/platform");
    await clearBrowserLocalData("demo-db");

    expect(getDirectory).toHaveBeenCalledTimes(1);
    expect(removeEntry).toHaveBeenNthCalledWith(1, "demo-db");
    expect(removeEntry).toHaveBeenNthCalledWith(2, "demo-db-journal");
    expect(removeEntry).toHaveBeenNthCalledWith(3, "demo-db-wal");
    expect(openBrowserPersistence).not.toHaveBeenCalled();
  });

  it("falls back to opening storage when OPFS directory access is unavailable", async () => {
    const clear = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    openBrowserPersistence.mockResolvedValue({ clear, close });

    vi.stubGlobal("navigator", {
      storage: {},
    });

    const { clearBrowserLocalData } = await import("@resolve/browser/platform");
    await clearBrowserLocalData("demo-db");

    expect(openBrowserPersistence).toHaveBeenCalledWith({ name: "demo-db" });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
