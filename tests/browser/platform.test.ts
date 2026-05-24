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
