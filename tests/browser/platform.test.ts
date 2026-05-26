import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "@tests/testkit";

type ClearableStorage = {
  clearAll: () => Promise<void>;
  close: () => Promise<void>;
};
type OpenBrowserStorageMock = (options: {
  name: string;
}) => Promise<ClearableStorage>;

let openBrowserStorageMock: ReturnType<typeof vi.fn<OpenBrowserStorageMock>>;

describe("clearBrowserLocalData", () => {
  beforeEach(() => {
    vi.resetModules();
    openBrowserStorageMock = vi.fn<OpenBrowserStorageMock>();

    vi.doMock("@/browser/sqlite/adapter", () => ({
      openBrowserStorage: openBrowserStorageMock,
    }));
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
    expect(openBrowserStorageMock).not.toHaveBeenCalled();
  });

  it("retries removeEntry until the worker releases the OPFS handle", async () => {
    vi.useFakeTimers();
    let dbAttempts = 0;
    const removeEntry = vi.fn(async (entry: string) => {
      if (entry === "demo-db") {
        dbAttempts += 1;
        if (dbAttempts <= 2) {
          throw new DOMException("locked", "NoModificationAllowedError");
        }
        return undefined;
      }
      throw new DOMException("missing", "NotFoundError");
    });
    const getDirectory = vi.fn(async () => ({ removeEntry }));
    vi.stubGlobal("navigator", { storage: { getDirectory } });

    const { clearBrowserLocalData } = await import("@resolve/browser/platform");
    const pending = clearBrowserLocalData("demo-db");
    await vi.advanceTimersByTimeAsync(500);
    await pending;

    expect(dbAttempts).toBe(3);
    expect(openBrowserStorageMock).not.toHaveBeenCalled();
  });

  it("falls back to opening storage when OPFS directory access is unavailable", async () => {
    const clearAll = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    openBrowserStorageMock.mockResolvedValue({ clearAll, close });

    vi.stubGlobal("navigator", {
      storage: {},
    });

    const { clearBrowserLocalData } = await import("@resolve/browser/platform");
    await clearBrowserLocalData("demo-db");

    expect(openBrowserStorageMock).toHaveBeenCalledWith({ name: "demo-db" });
    expect(clearAll).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
