import { createConvexClient } from "@resolve/browser/index";
import { localOnly, remoteOnly } from "@resolve/server/table";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
} from "@tests/testkit";
import type { ConvexClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";

type AnyRef =
  | FunctionReference<"query" | "mutation" | "action">
  | {
      reference: string;
    };

interface MockRemoteInstance {
  url: string;
  mutation: Mock;
  query: Mock;
  action: Mock;
  onUpdate: Mock;
  onPaginatedUpdate_experimental: Mock;
  setAuth: Mock;
  close: Mock;
}

interface MockBrowserModule {
  __mock: {
    reset: () => void;
    instances: () => MockRemoteInstance[];
  };
}

vi.mock("convex/browser", () => {
  function makeUnsubscribe() {
    const unsub = (() => {}) as (() => void) & {
      unsubscribe: () => void;
      getCurrentValue: () => unknown;
    };
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

interface MockIdMap {
  translateLocalIdsToRemote: Mock;
  translateClientIdsToRuntime: Mock;
  translateResult: Mock;
}

interface MockEngineInstance {
  mutation: Mock;
  on: Mock;
  start: Mock;
  stop: Mock;
  idMap: MockIdMap;
}

const mockEngineInstances: MockEngineInstance[] = [];
const mockEngineFactory = {
  create: vi.fn<() => MockEngineInstance>(() => {
    const instance: MockEngineInstance = {
      mutation: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      idMap: {
        translateLocalIdsToRemote: vi.fn((value: unknown) => value),
        translateClientIdsToRuntime: vi.fn((value: unknown) => value),
        translateResult: vi.fn((value: unknown) => value),
      },
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
const remotePaginatedWatchRef = makeFunctionReference<"query">(
  "remote:paginatedWatch",
);
const localWatchRef = makeFunctionReference<"query">("local:watch");
const localPaginatedWatchRef = makeFunctionReference<"query">(
  "local:paginatedWatch",
);
const nestedRemotePublishRef = makeFunctionReference<"mutation">(
  "messages/access:publish",
);
const componentMutationRef = {
  reference: "_reference/childComponent/embedded/messages/publish",
};
const componentQueryRef = {
  reference: "_reference/childComponent/embedded/messages/fetch",
};
const componentActionRef = {
  reference: "_reference/childComponent/embedded/messages/run",
};

interface PaginationArgs {
  paginationOpts?: { cursor: string | null; numItems?: number; id?: number };
}

function createModules() {
  return {
    "_generated/api": async () => ({}),
    remote: async () => ({
      publish: remoteOnly(() => "ok"),
      fetch: remoteOnly(() => "ok"),
      run: remoteOnly(() => "ok"),
      watch: remoteOnly(() => "ok"),
      paginatedWatch: remoteOnly(() => "ok"),
    }),
    local: async () => ({
      create: () => "ok",
      watch: () => ({ source: "local" }),
      paginatedWatch: (_ctx: unknown, args: PaginationArgs) => ({
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

function createModulesWithRemoteMetadata() {
  const resolveExport = () => {};
  Object.defineProperty(
    resolveExport,
    Symbol.for("convex-embedded:remoteMeta"),
    {
      value: {
        __brand: "convex-embedded:remoteMeta",
        table: "projects",
        resolveExport: "resolve",
        listExport: "list",
        schema: undefined,
      },
    },
  );

  return {
    ...createModules(),
    projects: async () => ({
      resolve: resolveExport,
      list: () => [],
    }),
  };
}

function createManifestRoutedModules() {
  return {
    modules: {
      "_generated/api": async () => ({}),
      remote: async () => ({
        paginatedWatch: () => ({
          page: [{ source: "local" }],
          isDone: true,
          continueCursor: "_end_cursor",
        }),
      }),
    },
    manifest: {
      remote: {
        routeModes: {
          "remote:paginatedWatch": "remote" as const,
        },
        tables: {},
      },
    },
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

function asRoutedClient(client: ConvexClient): RoutedClient {
  return client as unknown as RoutedClient;
}

interface RoutedUnsubscribe {
  (): void;
  unsubscribe: () => void;
  getCurrentValue: () => unknown;
}

interface RoutedClient {
  mutation(ref: AnyRef, args: Record<string, unknown>): Promise<unknown>;
  query(ref: AnyRef, args: Record<string, unknown>): Promise<unknown>;
  action(ref: AnyRef, args: Record<string, unknown>): Promise<unknown>;
  onUpdate(
    ref: AnyRef,
    args: Record<string, unknown>,
    callback: (...args: unknown[]) => void,
    onError: (error: Error) => void,
  ): RoutedUnsubscribe;
  onPaginatedUpdate_experimental(
    ref: AnyRef,
    args: Record<string, unknown>,
    options: { initialNumItems: number },
    callback: (...args: unknown[]) => void,
    onError: (error: Error) => void,
  ): RoutedUnsubscribe;
  setAuth(
    fetchToken: (args: {
      forceRefreshToken: boolean;
    }) => Promise<string | null>,
  ): void;
  close(): Promise<void>;
}

function callUrl(result: unknown): string | undefined {
  return (result as { url?: string }).url;
}

function routeErrorCode(error: unknown): string | undefined {
  return error instanceof ConvexError
    ? (error.data as { code?: string }).code
    : undefined;
}

async function remoteInstance(): Promise<MockRemoteInstance> {
  const convexBrowser = (await vi.importMock(
    "convex/browser",
  )) as MockBrowserModule;
  const remote = convexBrowser.__mock
    .instances()
    .find((instance) => instance.url === REMOTE_URL);
  expect(remote).toBeDefined();
  return remote!;
}

function calledWithRef(mock: Mock, ref: AnyRef): boolean {
  return mock.mock.calls.some((call) => call[0] === ref);
}

describe("remoteOnly routing", () => {
  let originalNavigator: Navigator | undefined;

  function goOffline(): void {
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });
  }

  beforeEach(async () => {
    originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: true },
      writable: true,
      configurable: true,
    });

    const convexBrowser = (await vi.importMock(
      "convex/browser",
    )) as MockBrowserModule;
    convexBrowser.__mock.reset();
    mockEngineInstances.length = 0;
    mockEngineFactory.create.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });

  it("routes remoteOnly mutations to remote client", async ({ track }) => {
    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createModules() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    const result = await client.mutation(remotePublishRef, { title: "hello" });

    const remote = await remoteInstance();
    expect(callUrl(result)).toBe(REMOTE_URL);
    expect(remote.mutation).toHaveBeenCalledWith(remotePublishRef, {
      title: "hello",
    });
  });

  it("routes forced remoteOnly mutations to remote client", async ({
    track,
  }) => {
    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createModules() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    const forcedRemoteRef = makeFunctionReference<"mutation">("forced:publish");
    const result = await client.mutation(forcedRemoteRef, { title: "hello" });

    const remote = await remoteInstance();
    expect(callUrl(result)).toBe(REMOTE_URL);
    expect(remote.mutation).toHaveBeenCalledWith(forcedRemoteRef, {
      title: "hello",
    });
  });

  it("keeps non-remote mutations on local client", async ({ track }) => {
    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createModules() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    const result = await client.mutation(localCreateRef, { title: "local" });

    const remote = await remoteInstance();
    expect(callUrl(result)).not.toBe(REMOTE_URL);
    expect(calledWithRef(remote.mutation, localCreateRef)).toBe(false);
  });

  it("keeps localOnly mutations on the unified local path", async ({
    track,
  }) => {
    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createModules() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    const result = await client.mutation(localOnlyCreateRef, {
      title: "local-only",
    });

    const remote = await remoteInstance();
    expect(callUrl(result)).not.toBe(REMOTE_URL);
    expect(calledWithRef(remote.mutation, localOnlyCreateRef)).toBe(false);
  });

  it("throws immediately when remoteOnly mutation is called offline", async ({
    track,
  }) => {
    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createModules() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    goOffline();

    const error = await client
      .mutation(remotePublishRef, {})
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConvexError);
    expect(routeErrorCode(error)).toBe("ROUTE_REMOTE_OFFLINE");
    expect((error as Error).message).toMatch(/cannot run while offline/);

    const remote = await remoteInstance();
    expect(calledWithRef(remote.mutation, remotePublishRef)).toBe(false);
  });

  it("throws immediately when remoteOnly query is called offline", async ({
    track,
  }) => {
    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createModules() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    goOffline();

    const error = await client
      .query(remoteFetchRef, { id: "1" })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConvexError);
    expect(routeErrorCode(error)).toBe("ROUTE_REMOTE_OFFLINE");
    expect((error as Error).message).toMatch(/cannot run while offline/);
  });

  it("throws immediately when remoteOnly action is called offline", async ({
    track,
  }) => {
    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createModules() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    goOffline();

    const error = await client
      .action(remoteRunRef, { id: "1" })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConvexError);
    expect(routeErrorCode(error)).toBe("ROUTE_REMOTE_OFFLINE");
    expect((error as Error).message).toMatch(/cannot run while offline/);
  });

  it("routes remoteOnly query and onUpdate subscription to remote", async ({
    track,
  }) => {
    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createModules() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    const result = await client.query(remoteFetchRef, { id: "1" });

    const onError = vi.fn();
    const unsubscribe = client.onUpdate(remoteWatchRef, {}, vi.fn(), onError);
    await vi.waitFor(async () => {
      expect((await remoteInstance()).onUpdate).toHaveBeenCalledWith(
        remoteWatchRef,
        {},
        expect.any(Function),
        onError,
      );
    });

    const remote = await remoteInstance();
    expect(callUrl(result)).toBe(REMOTE_URL);
    expect(remote.query).toHaveBeenCalledWith(remoteFetchRef, { id: "1" });
    expect(onError).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("translates local ids before remote-routed query subscriptions", async ({
    track,
  }) => {
    mockEngineFactory.create.mockImplementationOnce(() => {
      const instance: MockEngineInstance = {
        mutation: vi.fn(),
        on: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        idMap: {
          translateLocalIdsToRemote: vi.fn((value: unknown) =>
            JSON.parse(
              JSON.stringify(value).replaceAll(
                "local-project",
                "remote-project",
              ),
            ),
          ),
          translateClientIdsToRuntime: vi.fn((value: unknown) => value),
          translateResult: vi.fn((value: unknown) => value),
        },
      };
      mockEngineInstances.push(instance);
      return instance;
    });
    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createModulesWithRemoteMetadata() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    const result = await client.query(remoteFetchRef, {
      projectId: "local-project",
    });
    const unsubscribe = client.onUpdate(
      remoteWatchRef,
      {
        projectId: "local-project",
        paginationOpts: { cursor: null, numItems: 100, id: 1 },
      },
      vi.fn(),
      vi.fn(),
    );
    await vi.waitFor(async () => {
      expect((await remoteInstance()).onUpdate).toHaveBeenCalledWith(
        remoteWatchRef,
        {
          projectId: "remote-project",
          paginationOpts: { cursor: null, numItems: 100, id: 1 },
        },
        expect.any(Function),
        expect.any(Function),
      );
    });

    const remote = await remoteInstance();
    expect(callUrl(result)).toBe(REMOTE_URL);
    expect(remote.query).toHaveBeenCalledWith(remoteFetchRef, {
      projectId: "remote-project",
    });

    unsubscribe();
  });

  it("routes local onUpdate subscriptions through the cache pipeline", async ({
    track,
  }) => {
    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createModules() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    const callback = vi.fn();
    const unsubscribe = client.onUpdate(localWatchRef, {}, callback, vi.fn());

    expect(typeof unsubscribe).toBe("function");
    expect(typeof unsubscribe.unsubscribe).toBe("function");
    expect(typeof unsubscribe.getCurrentValue).toBe("function");

    await vi.waitFor(() => {
      expect(unsubscribe.getCurrentValue()).toEqual({ source: "local" });
    });

    const remote = await remoteInstance();
    expect(remote.onUpdate).toHaveBeenCalledWith(
      "local:watch",
      {},
      expect.any(Function),
      expect.any(Function),
    );

    unsubscribe();
  });

  it("routes local paginated subscriptions through the cache pipeline", async ({
    track,
  }) => {
    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createModules() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    const callback = vi.fn();
    const unsubscribe = client.onPaginatedUpdate_experimental(
      localPaginatedWatchRef,
      {},
      { initialNumItems: 1 },
      callback,
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(unsubscribe.getCurrentValue()).toEqual(
        expect.objectContaining({
          results: expect.any(Array),
          status: expect.any(String),
          loadMore: expect.any(Function),
        }),
      );
    });

    const remote = await remoteInstance();
    expect(remote.onUpdate).toHaveBeenCalledWith(
      "local:paginatedWatch",
      expect.objectContaining({
        paginationOpts: expect.objectContaining({ numItems: 1 }),
      }),
      expect.any(Function),
      expect.any(Function),
    );

    unsubscribe();
  });

  it("routes manifest-marked paginated subscriptions to the remote client", async ({
    track,
  }) => {
    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: createManifestRoutedModules(),
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    const callback = vi.fn();
    const unsubscribe = client.onPaginatedUpdate_experimental(
      remotePaginatedWatchRef,
      { projectId: "project-1" },
      { initialNumItems: 100 },
      callback,
      vi.fn(),
    );

    await vi.waitFor(async () => {
      expect(
        (await remoteInstance()).onPaginatedUpdate_experimental,
      ).toHaveBeenCalledWith(
        remotePaginatedWatchRef,
        { projectId: "project-1" },
        { initialNumItems: 100 },
        expect.any(Function),
        expect.any(Function),
      );
    });

    const remote = await remoteInstance();
    expect(remote.onUpdate).not.toHaveBeenCalledWith(
      "remote:paginatedWatch",
      expect.anything(),
      expect.any(Function),
      expect.any(Function),
    );

    unsubscribe();
  });

  it("routes top-level component refs to remote", async ({ track }) => {
    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createModules() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    const mutationResult = await client.mutation(componentMutationRef, {
      title: "component",
    });
    const queryResult = await client.query(componentQueryRef, { id: "1" });
    const actionResult = await client.action(componentActionRef, { id: "1" });

    const remote = await remoteInstance();
    expect(callUrl(mutationResult)).toBe(REMOTE_URL);
    expect(callUrl(queryResult)).toBe(REMOTE_URL);
    expect(callUrl(actionResult)).toBe(REMOTE_URL);
    expect(remote.mutation).toHaveBeenCalledWith(componentMutationRef, {
      title: "component",
    });
    expect(remote.query).toHaveBeenCalledWith(componentQueryRef, { id: "1" });
    expect(remote.action).toHaveBeenCalledWith(componentActionRef, { id: "1" });
  });

  it("fails immediately offline for component-routed calls", async ({
    track,
  }) => {
    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createModules() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    goOffline();

    const error = await client
      .query(componentQueryRef, {})
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConvexError);
    expect(routeErrorCode(error)).toBe("ROUTE_REMOTE_OFFLINE");
    expect((error as Error).message).toMatch(/component-routed function/);
  });

  it("preserves nested module paths for remoteOnly routing", async ({
    track,
  }) => {
    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createNestedModules() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    const result = await client.mutation(nestedRemotePublishRef, {
      title: "hi",
    });

    const remote = await remoteInstance();
    expect(callUrl(result)).toBe(REMOTE_URL);
    expect(remote.mutation).toHaveBeenCalledWith(nestedRemotePublishRef, {
      title: "hi",
    });
  });

  it("preserves nested module paths for remote table discovery", async ({
    track,
  }) => {
    track(
      createConvexClient({
        convex: { modules: createNestedModules() },
        remote: { url: REMOTE_URL },
      }),
    );

    await vi.waitFor(() => {
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
  });

  it("forwards setAuth to remote client", async ({ track }) => {
    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createModules() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    const fetchToken = vi.fn(async () => "token");
    client.setAuth(fetchToken);

    const remote = await remoteInstance();
    expect(remote.setAuth).toHaveBeenCalledTimes(1);

    const wrappedFetchToken = remote.setAuth.mock.calls[0]?.[0] as (args: {
      forceRefreshToken: boolean;
    }) => Promise<string | null>;
    expect(typeof wrappedFetchToken).toBe("function");
    await expect(wrappedFetchToken({ forceRefreshToken: false })).resolves.toBe(
      "token",
    );
    expect(fetchToken).toHaveBeenCalledWith({ forceRefreshToken: false });
  });

  it("does not start a discovered engine after client.close()", async () => {
    const delayed = createDelayedSyncModules();
    const client = createConvexClient({
      convex: delayed.convex,
      remote: { url: REMOTE_URL },
    });

    await flushDiscovery();
    await client.close();
    delayed.resolveLoader();
    await flushDiscovery();

    expect(mockEngineFactory.create).not.toHaveBeenCalled();
  });

  it("client.close() stops the discovered engine and closes the remote client", async () => {
    const client = createConvexClient({
      convex: { modules: createSyncModules() },
      remote: { url: REMOTE_URL },
    });

    await vi.waitFor(() => {
      expect(mockEngineFactory.create).toHaveBeenCalledTimes(1);
    });
    const remote = await remoteInstance();
    expect(mockEngineInstances[0]?.stop).not.toHaveBeenCalled();

    await client.close();

    expect(mockEngineInstances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(remote.close).toHaveBeenCalledTimes(1);
  });

  it("client.close() is idempotent after discovery completes", async () => {
    const client = createConvexClient({
      convex: { modules: createSyncModules() },
      remote: { url: REMOTE_URL },
    });

    await vi.waitFor(() => {
      expect(mockEngineFactory.create).toHaveBeenCalledTimes(1);
    });
    const remote = await remoteInstance();

    await client.close();
    await client.close();

    expect(mockEngineInstances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(remote.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces resolve setup failures instead of silently falling back", async ({
    track,
  }) => {
    mockEngineFactory.create.mockImplementationOnce(() => {
      throw new Error("engine boom");
    });

    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createSyncModules() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    await expect(client.mutation(localCreateRef, {})).rejects.toThrow(
      "engine boom",
    );
  });

  it("warns when module discovery skips failed loaders", async ({ track }) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    track(
      createConvexClient({
        convex: { modules: createSyncModulesWithFailure() },
        remote: { url: REMOTE_URL },
      }),
    );

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "failed to load during remote discovery and were skipped",
        ),
        expect.any(Error),
      );
    });
  });

  it("routes deferred discovery failures to subscription onError", async ({
    track,
  }) => {
    mockEngineFactory.create.mockImplementationOnce(() => {
      throw new Error("engine boom");
    });

    const client = asRoutedClient(
      track(
        createConvexClient({
          convex: { modules: createSyncModules() },
          remote: { url: REMOTE_URL },
        }),
      ),
    );

    const onError = vi.fn();
    const unsubscribe = client.onUpdate(localCreateRef, {}, vi.fn(), onError);

    expect(typeof unsubscribe).toBe("function");
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });

    const [firstError] = onError.mock.calls[0] ?? [];
    expect(firstError).toBeInstanceOf(Error);
    expect((firstError as Error).message).toBe("engine boom");
  });
});

async function flushDiscovery(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
