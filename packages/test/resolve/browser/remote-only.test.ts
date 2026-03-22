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

const mockEngineFactory = {
  create: vi.fn(() => ({
    mutation: vi.fn(),
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  })),
};

vi.mock("@/client/engine", () => ({
  engine: mockEngineFactory,
}));

const REMOTE_URL = "https://remote.example.convex.cloud";
const remotePublishRef = makeFunctionReference<"mutation">("remote:publish");
const localCreateRef = makeFunctionReference<"mutation">("local:create");
const remoteFetchRef = makeFunctionReference<"query">("remote:fetch");
const remoteWatchRef = makeFunctionReference<"query">("remote:watch");
const nestedRemotePublishRef = makeFunctionReference<"mutation">(
  "messages/access:publish",
);

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

function createNestedModules() {
  const resolveExport = () => {};
  Object.defineProperty(resolveExport, Symbol.for("convex-resolve:syncMeta"), {
    value: {
      __brand: "convex-resolve:syncMeta",
      table: "messages",
      resolveExport: "resolve",
      listExport: "list",
      schema: undefined,
    },
  });

  return {
    "./convex/_generated/api.ts": async () => ({}),
    "./convex/messages/access.ts": async () => ({
      publish: remoteOnly(() => "ok"),
      resolve: resolveExport,
      list: () => [],
    }),
  };
}

function createDelayedSyncModules() {
  let resolveLoader!: (value: Record<string, unknown>) => void;
  const resolveExport = () => {};
  Object.defineProperty(resolveExport, Symbol.for("convex-resolve:syncMeta"), {
    value: {
      __brand: "convex-resolve:syncMeta",
      table: "tasks",
      resolveExport: "resolve",
      listExport: "list",
      schema: undefined,
    },
  });

  return {
    modules: {
      "./convex/_generated/api.ts": async () => ({}),
      "./convex/tasks.ts": () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveLoader = resolve;
        }),
    },
    resolveLoader: () =>
      resolveLoader({ resolve: resolveExport, list: () => [] }),
  };
}

function createSyncModules() {
  const resolveExport = () => {};
  Object.defineProperty(resolveExport, Symbol.for("convex-resolve:syncMeta"), {
    value: {
      __brand: "convex-resolve:syncMeta",
      table: "tasks",
      resolveExport: "resolve",
      listExport: "list",
      schema: undefined,
    },
  });

  return {
    "./convex/_generated/api.ts": async () => ({}),
    "./convex/tasks.ts": async () => ({
      resolve: resolveExport,
      list: () => [],
    }),
    "./convex/local.ts": async () => ({
      create: () => "ok",
    }),
  };
}

function createSyncModulesWithFailure() {
  return {
    ...createSyncModules(),
    "./convex/broken.ts": async () => {
      throw new Error("broken module loader");
    },
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
    mockEngineFactory.create.mockClear();
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

  it("preserves nested module paths for remoteOnly routing", async () => {
    const client = createConvexClient({
      modules: createNestedModules(),
      sync: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    const result = await client.mutation(nestedRemotePublishRef, {
      title: "hi",
    });

    const convexBrowser = (await vi.importMock("convex/browser")) as any;
    const instances = convexBrowser.__mock.instances() as Array<any>;
    const remote = instances.find((c) => c.url === REMOTE_URL)!;

    expect(result.url).toBe(REMOTE_URL);
    expect(remote.mutation).toHaveBeenCalledWith(nestedRemotePublishRef, {
      title: "hi",
    });
  });

  it("preserves nested module paths for sync table discovery", async () => {
    const client = createConvexClient({
      modules: createNestedModules(),
      sync: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    await settle();

    expect(mockEngineFactory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tables: {
          messages: {
            query: "messages/access:list",
            resolve: "messages/access:resolve",
            schema: undefined,
          },
        },
      }),
    );
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

  it("does not start a discovered engine after client.close()", async () => {
    const delayed = createDelayedSyncModules();
    const client = createConvexClient({
      modules: delayed.modules as any,
      sync: { url: REMOTE_URL },
    }) as any;

    await settle();
    await client.close();
    delayed.resolveLoader();
    await settle();

    expect(mockEngineFactory.create).not.toHaveBeenCalled();
  });

  it("surfaces resolve setup failures instead of silently falling back", async () => {
    mockEngineFactory.create.mockImplementationOnce(() => {
      throw new Error("engine boom");
    });

    const client = createConvexClient({
      modules: createSyncModules(),
      sync: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    await expect(client.mutation(localCreateRef, {})).rejects.toThrow(
      "engine boom",
    );
  });

  it("warns when module discovery skips failed loaders", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const client = createConvexClient({
        modules: createSyncModulesWithFailure(),
        sync: { url: REMOTE_URL },
      }) as any;
      clientsToClose.push(client);

      await settle();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "failed to load during sync discovery and were skipped",
        ),
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("routes deferred discovery failures to subscription onError", async () => {
    mockEngineFactory.create.mockImplementationOnce(() => {
      throw new Error("engine boom");
    });

    const client = createConvexClient({
      modules: createSyncModules(),
      sync: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    const onError = vi.fn();
    const unsubscribe = client.onUpdate(
      localCreateRef as any,
      {},
      vi.fn(),
      onError,
    );

    expect(typeof unsubscribe).toBe("function");
    await settle();

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onError.mock.calls[0][0].message).toBe("engine boom");
  });
});
