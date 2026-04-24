import { createConvexClient } from "@resolve/browser/index";
import { localOnly, remoteOnly } from "@resolve/server/table";
import { afterEach, beforeEach, describe, expect, it } from "@tests/testkit";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { vi } from "vitest";

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

const mockEngineInstances: Array<{
  mutation: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}> = [];
const mockEngineFactory = {
  create: vi.fn(() => {
    const instance = {
      mutation: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    mockEngineInstances.push(instance);
    return instance;
  }),
};

vi.mock("@/client/engine", () => ({
  engine: mockEngineFactory,
}));

const REMOTE_URL = "https://remote.example.convex.cloud";
const remotePublishRef = makeFunctionReference<"mutation">("remote:publish");
const localCreateRef = makeFunctionReference<"mutation">("local:create");
const localOnlyCreateRef =
  makeFunctionReference<"mutation">("localOnly:create");
const remoteFetchRef = makeFunctionReference<"query">("remote:fetch");
const remoteRunRef = makeFunctionReference<"action">("remote:run");
const remoteWatchRef = makeFunctionReference<"query">("remote:watch");
const localWatchRef = makeFunctionReference<"query">("local:watch");
const localPaginatedWatchRef = makeFunctionReference<"query">(
  "local:paginatedWatch",
);
const nestedRemotePublishRef = makeFunctionReference<"mutation">(
  "messages/access:publish",
);
const componentMutationRef = {
  reference: "_reference/childComponent/embedded/messages/publish",
} as any;
const componentQueryRef = {
  reference: "_reference/childComponent/embedded/messages/fetch",
} as any;
const componentActionRef = {
  reference: "_reference/childComponent/embedded/messages/run",
} as any;

function createModules() {
  return {
    "_generated/api": async () => ({}),
    remote: async () => ({
      publish: remoteOnly(() => "ok"),
      fetch: remoteOnly(() => "ok"),
      run: remoteOnly(() => "ok"),
      watch: remoteOnly(() => "ok"),
    }),
    local: async () => ({
      create: () => "ok",
      watch: () => ({ source: "local" }),
      paginatedWatch: (_ctx: unknown, args: any) => ({
        page: [
          { source: "local", cursor: args.paginationOpts?.cursor ?? null },
        ],
        isDone: args.paginationOpts?.cursor !== null,
        continueCursor:
          args.paginationOpts?.cursor === null ? "cursor-2" : "_end_cursor",
      }),
    }),
    localOnly: async () => ({
      create: localOnly(() => "ok"),
    }),
    forced: async () => ({
      publish: remoteOnly(() => "ok"),
    }),
  };
}

function createNestedModules() {
  const resolveExport = () => {};
  Object.defineProperty(
    resolveExport,
    Symbol.for("convex-embedded:remoteMeta"),
    {
      value: {
        __brand: "convex-embedded:remoteMeta",
        table: "messages",
        resolveExport: "resolve",
        listExport: "list",
        schema: undefined,
      },
    },
  );

  return {
    "_generated/api": async () => ({}),
    "messages/access": async () => ({
      publish: remoteOnly(() => "ok"),
      resolve: resolveExport,
      list: () => [],
    }),
  };
}

function createDelayedSyncModules() {
  let resolveLoader!: (value: Record<string, unknown>) => void;
  const resolveExport = () => {};
  Object.defineProperty(
    resolveExport,
    Symbol.for("convex-embedded:remoteMeta"),
    {
      value: {
        __brand: "convex-embedded:remoteMeta",
        table: "tasks",
        resolveExport: "resolve",
        listExport: "list",
        schema: undefined,
      },
    },
  );

  return {
    convex: {
      modules: {
        "_generated/api": async () => ({}),
        tasks: () =>
          new Promise<Record<string, unknown>>((resolve) => {
            resolveLoader = resolve;
          }),
      },
    },
    resolveLoader: () =>
      resolveLoader({ resolve: resolveExport, list: () => [] }),
  };
}

function createSyncModules() {
  const resolveExport = () => {};
  Object.defineProperty(
    resolveExport,
    Symbol.for("convex-embedded:remoteMeta"),
    {
      value: {
        __brand: "convex-embedded:remoteMeta",
        table: "tasks",
        resolveExport: "resolve",
        listExport: "list",
        schema: undefined,
      },
    },
  );

  return {
    "_generated/api": async () => ({}),
    tasks: async () => ({
      resolve: resolveExport,
      list: () => [],
    }),
    local: async () => ({
      create: () => "ok",
    }),
  };
}

function createSyncModulesWithFailure() {
  return {
    ...createSyncModules(),
    broken: async () => {
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
    mockEngineInstances.length = 0;
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
      convex: { modules: createModules() },
      remote: { url: REMOTE_URL },
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

  it("routes remoteOnly mutations to remote client", async () => {
    const client = createConvexClient({
      convex: { modules: createModules() },
      remote: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    const forcedRemoteRef = makeFunctionReference<"mutation">("forced:publish");
    const result = await client.mutation(forcedRemoteRef, { title: "hello" });

    const convexBrowser = (await vi.importMock("convex/browser")) as any;
    const instances = convexBrowser.__mock.instances() as Array<any>;
    const remote = instances.find((c) => c.url === REMOTE_URL)!;

    expect(result.url).toBe(REMOTE_URL);
    expect(remote.mutation).toHaveBeenCalledWith(forcedRemoteRef, {
      title: "hello",
    });
  });

  it("keeps non-remote mutations on local client", async () => {
    const client = createConvexClient({
      convex: { modules: createModules() },
      remote: { url: REMOTE_URL },
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

  it("keeps localOnly mutations on the unified local path", async () => {
    const client = createConvexClient({
      convex: { modules: createModules() },
      remote: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    const result = await client.mutation(localOnlyCreateRef, {
      title: "local-only",
    });

    const convexBrowser = (await vi.importMock("convex/browser")) as any;
    const instances = convexBrowser.__mock.instances() as Array<any>;
    const remote = instances.find((c) => c.url === REMOTE_URL)!;

    expect(result.url).not.toBe(REMOTE_URL);
    expect(
      remote.mutation.mock.calls.some(
        (call: any[]) => call[0] === localOnlyCreateRef,
      ),
    ).toBe(false);
  });

  it("throws immediately when remoteOnly mutation is called offline", async () => {
    const client = createConvexClient({
      convex: { modules: createModules() },
      remote: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    const error = await client
      .mutation(remotePublishRef, {})
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<any>).data.code).toBe("ROUTE_REMOTE_OFFLINE");
    expect((error as Error).message).toMatch(/cannot run while offline/);

    const convexBrowser = (await vi.importMock("convex/browser")) as any;
    const instances = convexBrowser.__mock.instances() as Array<any>;
    const remote = instances.find((c) => c.url === REMOTE_URL)!;

    expect(
      remote.mutation.mock.calls.some(
        (call: any[]) => call[0] === remotePublishRef,
      ),
    ).toBe(false);
  });

  it("throws immediately when remoteOnly query is called offline", async () => {
    const client = createConvexClient({
      convex: { modules: createModules() },
      remote: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    const error = await client
      .query(remoteFetchRef, { id: "1" })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<any>).data.code).toBe("ROUTE_REMOTE_OFFLINE");
    expect((error as Error).message).toMatch(/cannot run while offline/);
  });

  it("throws immediately when remoteOnly action is called offline", async () => {
    const client = createConvexClient({
      convex: { modules: createModules() },
      remote: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    const error = await client
      .action(remoteRunRef, { id: "1" })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<any>).data.code).toBe("ROUTE_REMOTE_OFFLINE");
    expect((error as Error).message).toMatch(/cannot run while offline/);
  });

  it("routes remoteOnly query and onUpdate subscription to remote", async () => {
    const client = createConvexClient({
      convex: { modules: createModules() },
      remote: { url: REMOTE_URL },
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

  it("routes local onUpdate subscriptions through the runtime facade", async () => {
    const client = createConvexClient({
      convex: { modules: createModules() },
      remote: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    const callback = vi.fn();
    const unsubscribe = client.onUpdate(localWatchRef, {}, callback, vi.fn());

    expect(typeof unsubscribe).toBe("function");
    expect(typeof unsubscribe.unsubscribe).toBe("function");
    expect(typeof unsubscribe.getCurrentValue).toBe("function");

    await settle();

    const convexBrowser = (await vi.importMock("convex/browser")) as any;
    const instances = convexBrowser.__mock.instances() as Array<any>;
    const remote = instances.find((c) => c.url === REMOTE_URL)!;

    expect(remote.onUpdate).not.toHaveBeenCalledWith(
      localWatchRef,
      {},
      expect.any(Function),
      expect.any(Function),
    );
    expect(callback).toHaveBeenCalledWith(
      { source: "local" },
      expect.any(String),
    );
    expect(unsubscribe.getCurrentValue()).toEqual({ source: "local" });

    unsubscribe();
  });

  it("routes local paginated subscriptions through the runtime facade", async () => {
    const client = createConvexClient({
      convex: { modules: createModules() },
      remote: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    const callback = vi.fn();
    const unsubscribe = client.onPaginatedUpdate_experimental(
      localPaginatedWatchRef,
      {},
      { initialNumItems: 1 },
      callback,
      vi.fn(),
    );

    await settle();

    const first = unsubscribe.getCurrentValue();
    expect(first.results).toEqual([{ source: "local", cursor: null }]);
    expect(first.status).toBe("CanLoadMore");
    expect(first.loadMore(1)).toBe(true);
    expect(unsubscribe.getCurrentValue().status).toBe("LoadingMore");

    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = unsubscribe.getCurrentValue();
    expect(second.results).toEqual([
      { source: "local", cursor: null },
      { source: "local", cursor: "cursor-2" },
    ]);
    expect(second.status).toBe("Exhausted");

    const convexBrowser = (await vi.importMock("convex/browser")) as any;
    const instances = convexBrowser.__mock.instances() as Array<any>;
    const remote = instances.find((c) => c.url === REMOTE_URL)!;
    expect(remote.onPaginatedUpdate_experimental).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("routes top-level component refs to remote", async () => {
    const client = createConvexClient({
      convex: { modules: createModules() },
      remote: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    const mutationResult = await client.mutation(componentMutationRef, {
      title: "component",
    });
    const queryResult = await client.query(componentQueryRef, { id: "1" });
    const actionResult = await client.action(componentActionRef, { id: "1" });

    const convexBrowser = (await vi.importMock("convex/browser")) as any;
    const instances = convexBrowser.__mock.instances() as Array<any>;
    const remote = instances.find((c) => c.url === REMOTE_URL)!;

    expect(mutationResult.url).toBe(REMOTE_URL);
    expect(queryResult.url).toBe(REMOTE_URL);
    expect(actionResult.url).toBe(REMOTE_URL);
    expect(remote.mutation).toHaveBeenCalledWith(componentMutationRef, {
      title: "component",
    });
    expect(remote.query).toHaveBeenCalledWith(componentQueryRef, { id: "1" });
    expect(remote.action).toHaveBeenCalledWith(componentActionRef, { id: "1" });
  });

  it("fails immediately offline for component-routed calls", async () => {
    const client = createConvexClient({
      convex: { modules: createModules() },
      remote: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    const error = await client
      .query(componentQueryRef, {})
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<any>).data.code).toBe("ROUTE_REMOTE_OFFLINE");
    expect((error as Error).message).toMatch(/component-routed function/);
  });

  it("preserves nested module paths for remoteOnly routing", async () => {
    const client = createConvexClient({
      convex: { modules: createNestedModules() },
      remote: { url: REMOTE_URL },
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

  it("preserves nested module paths for remote table discovery", async () => {
    const client = createConvexClient({
      convex: { modules: createNestedModules() },
      remote: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    await settle();

    expect(mockEngineFactory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tables: {
          messages: {
            resolve: "messages/access:resolve",
            schema: undefined,
          },
        },
      }),
    );
  });

  it("forwards setAuth to remote client", async () => {
    const client = createConvexClient({
      convex: { modules: createModules() },
      remote: { url: REMOTE_URL },
    }) as any;
    clientsToClose.push(client);

    const fetchToken = vi.fn(async () => "token");
    client.setAuth(fetchToken);

    const convexBrowser = (await vi.importMock("convex/browser")) as any;
    const instances = convexBrowser.__mock.instances() as Array<any>;
    const remote = instances.find((c) => c.url === REMOTE_URL)!;
    expect(remote.setAuth).toHaveBeenCalledTimes(1);

    const wrappedFetchToken = remote.setAuth.mock.calls[0][0];
    expect(typeof wrappedFetchToken).toBe("function");
    await expect(wrappedFetchToken({ forceRefreshToken: false })).resolves.toBe(
      "token",
    );
    expect(fetchToken).toHaveBeenCalledWith({ forceRefreshToken: false });
  });

  it("does not start a discovered engine after client.close()", async () => {
    const delayed = createDelayedSyncModules();
    const client = createConvexClient({
      convex: delayed.convex as any,
      remote: { url: REMOTE_URL },
    }) as any;

    await settle();
    await client.close();
    delayed.resolveLoader();
    await settle();

    expect(mockEngineFactory.create).not.toHaveBeenCalled();
  });

  it("client.close() stops the discovered engine and closes the remote client", async () => {
    const client = createConvexClient({
      convex: { modules: createSyncModules() },
      remote: { url: REMOTE_URL },
    }) as any;

    await settle();

    const convexBrowser = (await vi.importMock("convex/browser")) as any;
    const instances = convexBrowser.__mock.instances() as Array<any>;
    const remote = instances.find((c) => c.url === REMOTE_URL)!;

    expect(mockEngineFactory.create).toHaveBeenCalledTimes(1);
    expect(mockEngineInstances[0]?.stop).not.toHaveBeenCalled();

    await client.close();

    expect(mockEngineInstances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(remote.close).toHaveBeenCalledTimes(1);
  });

  it("client.close() is idempotent after discovery completes", async () => {
    const client = createConvexClient({
      convex: { modules: createSyncModules() },
      remote: { url: REMOTE_URL },
    }) as any;

    await settle();

    const convexBrowser = (await vi.importMock("convex/browser")) as any;
    const instances = convexBrowser.__mock.instances() as Array<any>;
    const remote = instances.find((c) => c.url === REMOTE_URL)!;

    await client.close();
    await client.close();

    expect(mockEngineInstances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(remote.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces resolve setup failures instead of silently falling back", async () => {
    mockEngineFactory.create.mockImplementationOnce(() => {
      throw new Error("engine boom");
    });

    const client = createConvexClient({
      convex: { modules: createSyncModules() },
      remote: { url: REMOTE_URL },
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
        convex: { modules: createSyncModulesWithFailure() },
        remote: { url: REMOTE_URL },
      }) as any;
      clientsToClose.push(client);

      await settle();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "failed to load during remote discovery and were skipped",
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
      convex: { modules: createSyncModules() },
      remote: { url: REMOTE_URL },
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
