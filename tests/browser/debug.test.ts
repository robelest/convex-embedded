import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "@tests/testkit";

let clearBrowserLocalData: ReturnType<typeof vi.fn>;
let createEmbeddedClient: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  clearBrowserLocalData = vi.fn(async () => undefined);
  createEmbeddedClient = vi.fn();

  vi.doMock("@/browser/platform", () => ({
    createBrowserPlatformAdapter: vi.fn(() => ({
      openStorage: vi.fn(),
    })),
    clearBrowserLocalData,
  }));

  vi.doMock("@/client/factory", () => ({
    createEmbeddedClient,
  }));

  delete (globalThis as any).__convexEmbedded;
});

afterEach(() => {
  delete (globalThis as any).__convexEmbedded;
  vi.resetModules();
});

describe("browser debug console hook", () => {
  it("exposes clearLocalData on the browser console namespace", async () => {
    const close = vi.fn(async () => undefined);
    createEmbeddedClient.mockReturnValue({ close });

    const { createConvexClient } = await import("@resolve/browser/index");
    createConvexClient({ convex: { modules: {} }, name: "test-db" });

    const api = (globalThis as any).__convexEmbedded;
    expect(api).toBeDefined();
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
    }) as any;

    await client.close();

    const api = (globalThis as any).__convexEmbedded;
    expect(api.listClientNames()).toEqual([]);
  });
});
