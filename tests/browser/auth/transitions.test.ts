import { getEmbeddedClientEntry } from "@embedded/client/entry";
import type {
  EmbeddedRuntime,
  LocalExecutionRequest,
} from "@embedded/runtime/embedded";
import type { EngineStatus } from "@embedded/shared/types";
import { createTestIdentity } from "@embedded/test";
import {
  createConvexClient,
  getAuthState,
  switchIdentity,
} from "@resolve/browser/index";
import { afterEach, beforeEach, describe, expect, it } from "@tests/testkit";
import type { ConvexClient } from "convex/browser";

type AuthFetcher = (args: {
  forceRefreshToken: boolean;
}) => Promise<string | null>;

interface MockConvexClientInstance {
  url: string;
  authFetcher: AuthFetcher | null;
}

interface MockBrowserModule {
  __mock: {
    reset: () => void;
    instances: () => MockConvexClientInstance[];
  };
}

vi.mock("convex/browser", () => {
  class MockConvexClient {
    static instances: MockConvexClient[] = [];

    url: string;
    authFetcher: AuthFetcher | null = null;

    mutation = vi.fn(async () => undefined);
    query = vi.fn(async () => undefined);
    action = vi.fn(async () => undefined);
    onUpdate = vi.fn(() => () => {});
    close = vi.fn(async () => {});
    setAuth = vi.fn((fetchToken: AuthFetcher | null) => {
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

interface EngineProbe {
  emitChange: (status: EngineStatus) => void;
  setPendingCount: (count: number) => void;
  reloadIdentity: ReturnType<typeof vi.fn>;
}

const engineInstances: EngineProbe[] = [];

vi.mock("@/client/engine", () => ({
  engine: {
    create: vi.fn(() => {
      let onChange: ((status: EngineStatus) => void) | null = null;
      let pendingCount = 0;

      const instance = {
        mutation: vi.fn(),
        on: vi.fn((event: string, cb: (status: EngineStatus) => void) => {
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
    "_generated/api": async () => ({}),
    tasks: async () => ({
      resolve: resolveExport,
      list: () => [],
    }),
  };
}

function clientRuntime(client: ConvexClient): EmbeddedRuntime {
  const runtime = getEmbeddedClientEntry(client)?.runtime;
  if (!runtime) {
    throw new Error("[test] expected embedded runtime entry on client");
  }
  return runtime;
}

function installDefaultIdentityStub(client: ConvexClient) {
  return vi
    .spyOn(clientRuntime(client), "executeLocal")
    .mockImplementation(async (request: LocalExecutionRequest) => {
      if (request.kind === "query") {
        if (request.path === "_system:authStateGetActive") {
          return null;
        }
        if (request.path === "_system:pendingListIdentityKeys") {
          return [];
        }
      }
      return null;
    });
}

function mockIdentityQueries(
  client: ConvexClient,
  resolver: (path: string) => unknown,
) {
  return vi
    .spyOn(clientRuntime(client), "executeLocal")
    .mockImplementation(async (request: LocalExecutionRequest) => {
      if (request.kind === "query") {
        return resolver(request.path);
      }
      return null;
    });
}

async function mockBrowserModule(): Promise<MockBrowserModule> {
  return (await vi.importMock("convex/browser")) as MockBrowserModule;
}

describe("auth state transitions", () => {
  beforeEach(async () => {
    engineInstances.length = 0;
    (await mockBrowserModule()).__mock.reset();
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: true },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("transitions authenticated -> offlineStale -> authenticated with remote events", async ({
    track,
  }) => {
    const identity = createTestIdentity({ subject: "alice" });
    const client = track(
      createConvexClient({
        convex: { modules: createSyncModules() },
        remote: { url: REMOTE_URL },
        auth: { getUserIdentity: async () => identity },
      }),
    );
    installDefaultIdentityStub(client);

    await vi.waitFor(() => {
      expect(getAuthState(client)).toEqual({
        status: "authenticated",
        identity,
        identityKey: identity.tokenIdentifier,
      });
    });

    engineInstances[0]!.emitChange({ status: "offline" });
    expect(getAuthState(client)).toEqual({
      status: "offlineStale",
      identity,
      identityKey: identity.tokenIdentifier,
    });

    engineInstances[0]!.emitChange({ status: "resolved" });
    expect(getAuthState(client)).toEqual({
      status: "authenticated",
      identity,
      identityKey: identity.tokenIdentifier,
    });
  });

  it("transitions to reauthRequired when a previously authenticated token becomes unavailable", async ({
    track,
  }) => {
    const identity = createTestIdentity({ subject: "alice" });
    const fetchToken = vi
      .fn<AuthFetcher>()
      .mockResolvedValueOnce("token")
      .mockResolvedValueOnce(null);

    const client = track(
      createConvexClient({
        convex: { modules: createSyncModules() },
        remote: { url: REMOTE_URL },
        auth: { fetchToken, getUserIdentity: async () => identity },
      }),
    );
    installDefaultIdentityStub(client);

    const embeddedClient = (await mockBrowserModule()).__mock.instances()[0]!;

    await embeddedClient.authFetcher!({ forceRefreshToken: false });
    expect(getAuthState(client)).toEqual({
      status: "authenticated",
      identity,
      identityKey: identity.tokenIdentifier,
    });

    await embeddedClient.authFetcher!({ forceRefreshToken: true });
    expect(getAuthState(client)).toEqual({
      status: "reauthRequired",
      identity,
      identityKey: identity.tokenIdentifier,
    });
  });

  it("transitions to identityMismatch when identity changes with pending replay work", async ({
    track,
  }) => {
    let currentIdentity = createTestIdentity({ subject: "alice" });
    const fetchToken = vi.fn(async () => "token");

    const client = track(
      createConvexClient({
        convex: { modules: createSyncModules() },
        remote: { url: REMOTE_URL },
        auth: { fetchToken, getUserIdentity: async () => currentIdentity },
      }),
    );
    installDefaultIdentityStub(client);

    const embeddedClient = (await mockBrowserModule()).__mock.instances()[0]!;

    await embeddedClient.authFetcher!({ forceRefreshToken: false });
    expect(getAuthState(client)).toEqual({
      status: "authenticated",
      identity: currentIdentity,
      identityKey: currentIdentity.tokenIdentifier,
    });

    mockIdentityQueries(client, (path) => {
      if (path === "_system:authStateGetActive") {
        return null;
      }
      if (path === "_system:pendingListIdentityKeys") {
        return ["issuer|alice", "issuer|bob"];
      }
      return null;
    });

    currentIdentity = createTestIdentity({ subject: "bob" });
    await embeddedClient.authFetcher!({ forceRefreshToken: true });

    expect(getAuthState(client)).toEqual({
      status: "identityMismatch",
      identity: currentIdentity,
      identityKey: currentIdentity.tokenIdentifier,
    });
  });

  it("switchIdentity preserves data but surfaces identityMismatch when pending work exists", async ({
    track,
  }) => {
    const alice = createTestIdentity({ subject: "alice" });
    const bob = createTestIdentity({ subject: "bob" });

    const client = track(
      createConvexClient({
        convex: { modules: createSyncModules() },
        remote: { url: REMOTE_URL },
        auth: { getUserIdentity: async () => alice },
      }),
    );
    installDefaultIdentityStub(client);

    await vi.waitFor(() => {
      expect(getAuthState(client).status).toBe("authenticated");
    });
    mockIdentityQueries(client, (path) => {
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

  it("switching back resumes the previous identity namespace", async ({
    track,
  }) => {
    const alice = createTestIdentity({ subject: "alice" });
    const bob = createTestIdentity({ subject: "bob" });

    const client = track(
      createConvexClient({
        convex: { modules: createSyncModules() },
        remote: { url: REMOTE_URL },
        auth: { getUserIdentity: async () => alice },
      }),
    );
    installDefaultIdentityStub(client);

    await vi.waitFor(() => {
      expect(getAuthState(client).status).toBe("authenticated");
    });

    const executeLocalSpy = mockIdentityQueries(client, (path) => {
      if (path === "_system:authStateGetActive") {
        return null;
      }
      if (path === "_system:pendingListIdentityKeys") {
        return ["issuer|alice"];
      }
      return null;
    });

    await switchIdentity(client, bob);
    executeLocalSpy.mockImplementation(
      async (request: LocalExecutionRequest) => {
        if (request.kind === "query") {
          if (request.path === "_system:authStateGetActive") {
            return null;
          }
          if (request.path === "_system:pendingListIdentityKeys") {
            return ["issuer|alice", "issuer|bob"];
          }
        }
        return null;
      },
    );

    await switchIdentity(client, alice);

    expect(getAuthState(client)).toEqual({
      status: "identityMismatch",
      identity: alice,
      identityKey: alice.tokenIdentifier,
    });
    expect(engineInstances[0]!.reloadIdentity).toHaveBeenCalledTimes(2);
  });
});
