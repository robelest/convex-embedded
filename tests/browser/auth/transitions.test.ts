import { createTestIdentity } from "@embedded/auth/resolver";
import { EmbeddedRuntime } from "@embedded/runtime/embedded";
import {
  createConvexClient,
  getAuthState,
  switchIdentity,
} from "@resolve/browser/index";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

vi.mock("convex/browser", () => {
  class MockConvexClient {
    static instances: MockConvexClient[] = [];

    url: string;
    authFetcher:
      | ((args: { forceRefreshToken: boolean }) => Promise<unknown>)
      | null = null;

    mutation = vi.fn(async () => undefined);
    query = vi.fn(async () => undefined);
    action = vi.fn(async () => undefined);
    onUpdate = vi.fn(() => (() => {}) as any);
    close = vi.fn(async () => {});
    setAuth = vi.fn((fetchToken: typeof this.authFetcher) => {
      this.authFetcher = fetchToken;
    });

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

const engineInstances: Array<{
  emitChange: (status: unknown) => void;
  setPendingCount: (count: number) => void;
  reloadIdentity: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("@/client/engine", () => ({
  engine: {
    create: vi.fn(() => {
      let onChange: ((status: unknown) => void) | null = null;
      let pendingCount = 0;

      const instance = {
        mutation: vi.fn(),
        on: vi.fn((event: string, cb: (status: unknown) => void) => {
          if (event === "change") {
            onChange = cb;
          }
        }),
        start: vi.fn(),
        stop: vi.fn(),
        pendingCount: vi.fn(() => pendingCount),
        reloadIdentity: vi.fn(async () => {}),
      };

      engineInstances.push({
        emitChange: (status) => onChange?.(status),
        setPendingCount: (count) => {
          pendingCount = count;
        },
        reloadIdentity: instance.reloadIdentity,
      });

      return instance;
    }),
  },
}));

const REMOTE_URL = "https://remote.example.convex.cloud";

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
    "./convex/_generated/api.ts": async () => ({}),
    "./convex/tasks.ts": async () => ({
      resolve: resolveExport,
      list: () => [],
    }),
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mockIdentityQueries(
  resolver: (path: string) => unknown,
): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(EmbeddedRuntime.prototype, "executeLocal")
    .mockImplementation(async function (request) {
      if (request.kind === "query") {
        return resolver(request.path);
      }
      return null;
    });
}

describe("auth state transitions", () => {
  const clientsToClose: Array<{ close: () => Promise<void> }> = [];

  beforeEach(async () => {
    engineInstances.length = 0;
    const convexBrowser = (await vi.importMock("convex/browser")) as {
      __mock: { reset: () => void };
    };
    convexBrowser.__mock.reset();
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: true },
      writable: true,
      configurable: true,
    });

    vi.spyOn(EmbeddedRuntime.prototype, "executeLocal").mockImplementation(
      async function (request) {
        if (request.kind === "query") {
          if (request.path === "_system:authStateGetActive") {
            return null;
          }
          if (request.path === "_system:pendingListIdentityKeys") {
            return [];
          }
        }
        return null;
      },
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const client of clientsToClose.splice(0)) {
      await client.close();
    }
  });

  it("transitions authenticated -> offlineStale -> authenticated with remote events", async () => {
    const identity = createTestIdentity({ subject: "alice" });
    const client = createConvexClient({
      modules: createSyncModules(),
      remote: { url: REMOTE_URL },
      auth: { getUserIdentity: async () => identity },
    });
    clientsToClose.push(client as any);

    await settle();
    expect(getAuthState(client)).toEqual({
      status: "authenticated",
      identity,
      identityKey: identity.tokenIdentifier,
    });

    engineInstances[0]!.emitChange({ status: "offline" });
    expect(getAuthState(client)).toEqual({
      status: "offlineStale",
      identity,
      identityKey: identity.tokenIdentifier,
    });

    engineInstances[0]!.emitChange({ status: "resolving" });
    expect(getAuthState(client)).toEqual({
      status: "authenticated",
      identity,
      identityKey: identity.tokenIdentifier,
    });
  });

  it("transitions to reauthRequired when a previously authenticated token becomes unavailable", async () => {
    const identity = createTestIdentity({ subject: "alice" });
    const fetchToken = vi
      .fn<
        (
          ...args: Array<{ forceRefreshToken: boolean }>
        ) => Promise<string | null>
      >()
      .mockResolvedValueOnce("token")
      .mockResolvedValueOnce(null);

    const client = createConvexClient({
      modules: createSyncModules(),
      remote: { url: REMOTE_URL },
      auth: {
        fetchToken,
        getUserIdentity: async () => identity,
      },
    });
    clientsToClose.push(client as any);

    const convexBrowser = (await vi.importMock("convex/browser")) as {
      __mock: { instances: () => Array<any> };
    };
    const embeddedClient = convexBrowser.__mock.instances()[0];

    await embeddedClient.authFetcher({ forceRefreshToken: false });
    expect(getAuthState(client)).toEqual({
      status: "authenticated",
      identity,
      identityKey: identity.tokenIdentifier,
    });

    await embeddedClient.authFetcher({ forceRefreshToken: true });
    expect(getAuthState(client)).toEqual({
      status: "reauthRequired",
      identity,
      identityKey: identity.tokenIdentifier,
    });
  });

  it("transitions to identityMismatch when identity changes with pending replay work", async () => {
    let currentIdentity = createTestIdentity({ subject: "alice" });
    const fetchToken = vi.fn(async () => "token");

    const client = createConvexClient({
      modules: createSyncModules(),
      remote: { url: REMOTE_URL },
      auth: {
        fetchToken,
        getUserIdentity: async () => currentIdentity,
      },
    });
    clientsToClose.push(client as any);

    const convexBrowser = (await vi.importMock("convex/browser")) as {
      __mock: { instances: () => Array<any> };
    };
    const embeddedClient = convexBrowser.__mock.instances()[0];

    await embeddedClient.authFetcher({ forceRefreshToken: false });
    expect(getAuthState(client)).toEqual({
      status: "authenticated",
      identity: currentIdentity,
      identityKey: currentIdentity.tokenIdentifier,
    });

    mockIdentityQueries((path) => {
      if (path === "_system:authStateGetActive") {
        return null;
      }
      if (path === "_system:pendingListIdentityKeys") {
        return ["issuer|alice", "issuer|bob"];
      }
      return null;
    });

    currentIdentity = createTestIdentity({ subject: "bob" });
    await embeddedClient.authFetcher({ forceRefreshToken: true });

    expect(getAuthState(client)).toEqual({
      status: "identityMismatch",
      identity: currentIdentity,
      identityKey: currentIdentity.tokenIdentifier,
    });
  });

  it("switchIdentity preserves data but surfaces identityMismatch when pending work exists", async () => {
    const alice = createTestIdentity({ subject: "alice" });
    const bob = createTestIdentity({ subject: "bob" });

    const client = createConvexClient({
      modules: createSyncModules(),
      remote: { url: REMOTE_URL },
      auth: { getUserIdentity: async () => alice },
    });
    clientsToClose.push(client as any);

    await settle();
    mockIdentityQueries((path) => {
      if (path === "_system:authStateGetActive") {
        return null;
      }
      if (path === "_system:pendingListIdentityKeys") {
        return ["issuer|alice"];
      }
      return null;
    });

    await switchIdentity(client, bob);

    expect(getAuthState(client)).toEqual({
      status: "identityMismatch",
      identity: bob,
      identityKey: bob.tokenIdentifier,
    });
    expect(engineInstances[0]!.reloadIdentity).toHaveBeenCalled();
  });

  it("switching back resumes the previous identity namespace", async () => {
    const alice = createTestIdentity({ subject: "alice" });
    const bob = createTestIdentity({ subject: "bob" });

    const client = createConvexClient({
      modules: createSyncModules(),
      remote: { url: REMOTE_URL },
      auth: { getUserIdentity: async () => alice },
    });
    clientsToClose.push(client as any);

    await settle();

    const executeLocalSpy = mockIdentityQueries((path) => {
      if (path === "_system:authStateGetActive") {
        return null;
      }
      if (path === "_system:pendingListIdentityKeys") {
        return ["issuer|alice"];
      }
      return null;
    });

    await switchIdentity(client, bob);
    executeLocalSpy.mockImplementation(async function (request: any) {
      if (request.kind === "query") {
        if (request.path === "_system:authStateGetActive") {
          return null;
        }
        if (request.path === "_system:pendingListIdentityKeys") {
          return ["issuer|alice", "issuer|bob"];
        }
      }
      return null;
    });

    await switchIdentity(client, alice);

    expect(getAuthState(client)).toEqual({
      status: "identityMismatch",
      identity: alice,
      identityKey: alice.tokenIdentifier,
    });
    expect(engineInstances[0]!.reloadIdentity).toHaveBeenCalledTimes(2);
  });
});
