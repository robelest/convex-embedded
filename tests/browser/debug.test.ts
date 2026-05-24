import {
  getBrowserDebugApi,
  unregisterBrowserDebugClient,
} from "@embedded/browser/debug";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "@tests/testkit";

type DebugTestClient = { close: () => Promise<void> };

let clearBrowserLocalData: ReturnType<
  typeof vi.fn<(name: string) => Promise<void>>
>;
let createEmbeddedClient: ReturnType<typeof vi.fn<() => DebugTestClient>>;

function debugApi() {
  const api = getBrowserDebugApi();
  expect(api).not.toBeNull();
  return api!;
}

beforeEach(() => {
  vi.resetModules();
  clearBrowserLocalData = vi.fn(async () => undefined);
  createEmbeddedClient = vi.fn<() => DebugTestClient>();

  vi.doMock("@/browser/platform", () => ({
    createBrowserPlatformAdapter: vi.fn(() => ({
      openStorage: vi.fn(),
    })),
    clearBrowserLocalData,
  }));

  vi.doMock("@/client/factory", () => ({
    createEmbeddedClient,
  }));

  for (const name of debugApi().listClientNames()) {
    unregisterBrowserDebugClient(name);
  }
});

afterEach(() => {
  vi.resetModules();
});

describe("browser debug console hook", () => {
  it("exposes clearLocalData on the browser console namespace", async () => {
    const close = vi.fn(async () => undefined);
    createEmbeddedClient.mockReturnValue({ close });

    const { createConvexClient } = await import("@resolve/browser/index");
    createConvexClient({ convex: { modules: {} }, name: "test-db" });

    const api = debugApi();
    expect(api.listClientNames()).toEqual(["test-db"]);

    await api.clearLocalData();

    expect(close).toHaveBeenCalledTimes(1);
    expect(clearBrowserLocalData).toHaveBeenCalledWith("test-db");
  });

  it("unregisters the client when close is called", async () => {
    const close = vi.fn(async () => undefined);
    createEmbeddedClient.mockReturnValue({ close });

    const { createConvexClient } = await import("@resolve/browser/index");
    const client = createConvexClient({
      convex: { modules: {} },
      name: "test-db",
    });

    await client.close();

    expect(debugApi().listClientNames()).toEqual([]);
  });
});
