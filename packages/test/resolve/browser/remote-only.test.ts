import { createConvexClient } from "@resolve/browser/index";
import { remoteOnly } from "@resolve/server/setup";
import { makeFunctionReference } from "convex/server";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

vi.mock("convex/browser", () => {
  function makeUnsubscribe() {
    const unsub = (() => {}) as any;
    unsub.unsubscribe = unsub;
    unsub.getCurrentValue = () => undefined;
    return unsub;
  }

  class MockConvexClient {
    static instances: MockConvexClient[] = [];

    url: string;

    mutation = vi.fn(async (...args: unknown[]) => ({
      kind: "mutation",
      url: this.url,
      args,
    }));

    query = vi.fn(async (...args: unknown[]) => ({
      kind: "query",
      url: this.url,
      args,
    }));

    action = vi.fn(async (...args: unknown[]) => ({
      kind: "action",
      url: this.url,
      args,
    }));

    onUpdate = vi.fn((..._args: unknown[]) => makeUnsubscribe());

    onPaginatedUpdate_experimental = vi.fn((..._args: unknown[]) =>
      makeUnsubscribe(),
    );

    close = vi.fn(async () => {});

    setAuth = vi.fn((..._args: unknown[]) => {});

    constructor(url: string) {
      this.url = url;
      MockConvexClient.instances.push(this);
    }
  }

  return {
    ConvexClient: MockConvexClient,
    __mock: {
      reset: () => {
        MockConvexClient.instances.length = 0;
      },
      instances: () => MockConvexClient.instances,
    },
  };
});

const REMOTE_URL = "https://remote.example.convex.cloud";
const remotePublishRef = makeFunctionReference<"mutation">("remote:publish");
const localCreateRef = makeFunctionReference<"mutation">("local:create");
const remoteFetchRef = makeFunctionReference<"query">("remote:fetch");
const remoteWatchRef = makeFunctionReference<"query">("remote:watch");

function createModules() {
  return {
    "./convex/_generated/api.ts": async () => ({}),
    "./convex/remote.ts": async () => ({
      publish: remoteOnly(() => "ok"),
      fetch: remoteOnly(() => "ok"),
      watch: remoteOnly(() => "ok"),
    }),
    "./convex/local.ts": async () => ({
      create: () => "ok",
    }),
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("remoteOnly routing", () => {
  let originalNavigator: Navigator | undefined;
  const clientsToClose: Array<{ close: () => Promise<void> }> = [];

  beforeEach(async () => {
    originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: true },
      writable: true,
      configurable: true,
    });

    const convexBrowser = (await vi.importMock("convex/browser")) as {
      __mock: { reset: () => void };
    };
    convexBrowser.__mock.reset();
  });

  afterEach(async () => {
    for (const client of clientsToClose.splice(0)) {
      await client.close();
    }

    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });

  it("routes remoteOnly mutations to remote client", async () => {
    const client = createConvexClient({
      modules: createModules(),
      sync: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    const result = await client.mutation(remotePublishRef, { title: "hello" });

    const convexBrowser = (await vi.importMock("convex/browser")) as any;
    const instances = convexBrowser.__mock.instances() as Array<any>;
    const remote = instances.find((c) => c.url === REMOTE_URL)!;

    expect(result.url).toBe(REMOTE_URL);
    expect(remote.mutation).toHaveBeenCalledWith(remotePublishRef, {
      title: "hello",
    });
  });

  it("keeps non-remote mutations on local client", async () => {
    const client = createConvexClient({
      modules: createModules(),
      sync: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    const result = await client.mutation(localCreateRef, { title: "local" });

    const convexBrowser = (await vi.importMock("convex/browser")) as any;
    const instances = convexBrowser.__mock.instances() as Array<any>;
    const remote = instances.find((c) => c.url === REMOTE_URL)!;

    expect(result.url).not.toBe(REMOTE_URL);
    expect(
      remote.mutation.mock.calls.some(
        (call: any[]) => call[0] === localCreateRef,
      ),
    ).toBe(false);
  });

  it("throws immediately when remoteOnly mutation is called offline", async () => {
    const client = createConvexClient({
      modules: createModules(),
      sync: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    await expect(client.mutation(remotePublishRef, {})).rejects.toThrow(
      /cannot run while offline/,
    );

    const convexBrowser = (await vi.importMock("convex/browser")) as any;
    const instances = convexBrowser.__mock.instances() as Array<any>;
    const remote = instances.find((c) => c.url === REMOTE_URL)!;

    expect(
      remote.mutation.mock.calls.some(
        (call: any[]) => call[0] === remotePublishRef,
      ),
    ).toBe(false);
  });

  it("routes remoteOnly query and onUpdate subscription to remote", async () => {
    const client = createConvexClient({
      modules: createModules(),
      sync: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    const result = await client.query(remoteFetchRef, { id: "1" });

    const onError = vi.fn();
    const unsubscribe = client.onUpdate(remoteWatchRef, {}, vi.fn(), onError);
    await settle();

    const convexBrowser = (await vi.importMock("convex/browser")) as any;
    const instances = convexBrowser.__mock.instances() as Array<any>;
    const remote = instances.find((c) => c.url === REMOTE_URL)!;

    expect(result.url).toBe(REMOTE_URL);
    expect(remote.query).toHaveBeenCalledWith(remoteFetchRef, { id: "1" });

    expect(remote.onUpdate).toHaveBeenCalledWith(
      remoteWatchRef,
      {},
      expect.any(Function),
      onError,
    );
    expect(onError).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("forwards setAuth to remote client", async () => {
    const client = createConvexClient({
      modules: createModules(),
      sync: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    const fetchToken = vi.fn(async () => "token");
    client.setAuth(fetchToken);

    const convexBrowser = (await vi.importMock("convex/browser")) as any;
    const instances = convexBrowser.__mock.instances() as Array<any>;
    const remote = instances.find((c) => c.url === REMOTE_URL)!;
    expect(remote.setAuth).toHaveBeenCalledWith(fetchToken);
  });
});
