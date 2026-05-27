import { createTestIdentity } from "@embedded/test";
import {
  createConvexClient,
  getAuthState,
  getAuthIdentity,
  logout,
  reauthenticate,
  subscribeAuthState,
  switchIdentity,
} from "@resolve/browser/index";
import { afterEach, beforeEach, describe, expect, it } from "@tests/testkit";
import { ConvexClient } from "convex/browser";

type AuthFetcher = (args: {
  forceRefreshToken: boolean;
}) => Promise<string | null>;

interface MockConvexClientInstance {
  url: string;
  authFetcher: AuthFetcher | null;
  clearAuth: ReturnType<typeof vi.fn>;
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
    close = vi.fn(() => undefined);
    setAuth = vi.fn((fetchToken: AuthFetcher | null) => {
      this.authFetcher = fetchToken;
    });
    clearAuth = vi.fn(() => undefined);
    setAdminAuth = vi.fn(() => undefined);

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

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  name: string;
  private _closed = false;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    if (this._closed) return;
    for (const instance of MockBroadcastChannel.instances.filter(
      (current) =>
        current !== this && current.name === this.name && !current._closed,
    )) {
      instance.onmessage?.({ data } as MessageEvent);
    }
  }

  close(): void {
    this._closed = true;
  }

  static reset(): void {
    MockBroadcastChannel.instances = [];
  }
}

function createModules() {
  return {
    "_generated/api": async () => ({}),
    tasks: async () => ({
      list: () => [],
    }),
  };
}

async function mockBrowserModule(): Promise<MockBrowserModule> {
  return (await vi.importMock("convex/browser")) as MockBrowserModule;
}

describe("auth state accessors", () => {
  beforeEach(async () => {
    (await mockBrowserModule()).__mock.reset();
    MockBroadcastChannel.reset();
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns idle and a no-op unsubscribe for non-embedded clients", () => {
    const client = new ConvexClient("https://example.com");
    const callback = vi.fn();
    const unsubscribe = subscribeAuthState(client, callback);

    expect(getAuthState(client)).toEqual({ status: "idle" });
    expect(typeof unsubscribe).toBe("function");

    unsubscribe();
    expect(callback).not.toHaveBeenCalled();
  });

  it("hydrates local auth state from getUserIdentity on create", async ({
    track,
  }) => {
    const identity = createTestIdentity({ subject: "alice" });

    const client = track(
      createConvexClient({
        convex: { modules: createModules() },
        auth: { getUserIdentity: vi.fn(async () => identity) },
      }),
    );

    await vi.waitFor(() => {
      expect(getAuthState(client)).toEqual({
        status: "authenticated",
        identity,
        identityKey: identity.tokenIdentifier,
      });
    });
  });

  it("wraps fetchToken and updates local identity when auth succeeds", async ({
    track,
  }) => {
    const identity = createTestIdentity({ subject: "bob" });
    const fetchToken = vi.fn(async () => "token");

    const client = track(
      createConvexClient({
        convex: { modules: createModules() },
        auth: { fetchToken, getUserIdentity: vi.fn(async () => identity) },
      }),
    );

    const embeddedClient = (await mockBrowserModule()).__mock.instances()[0]!;

    expect(getAuthState(client)).toEqual({ status: "idle" });

    const token = await embeddedClient.authFetcher!({
      forceRefreshToken: false,
    });

    expect(token).toBe("token");
    expect(fetchToken).toHaveBeenCalledWith({ forceRefreshToken: false });
    expect(getAuthState(client)).toEqual({
      status: "authenticated",
      identity,
      identityKey: identity.tokenIdentifier,
    });
  });

  it("clears local identity when fetchToken returns null", async ({
    track,
  }) => {
    const client = track(
      createConvexClient({
        convex: { modules: createModules() },
        auth: {
          fetchToken: vi.fn(async () => null),
          getUserIdentity: vi.fn(async () => createTestIdentity()),
        },
      }),
    );

    const embeddedClient = (await mockBrowserModule()).__mock.instances()[0]!;

    const token = await embeddedClient.authFetcher!({
      forceRefreshToken: true,
    });

    expect(token).toBeNull();
    expect(getAuthState(client)).toEqual({ status: "unauthenticated" });
  });

  it("supports custom identity keys", async ({ track }) => {
    const identity = createTestIdentity({ subject: "carol" });

    const client = track(
      createConvexClient({
        convex: { modules: createModules() },
        auth: {
          getUserIdentity: vi.fn(async () => identity),
          getIdentityKey: (current) =>
            current ? `workspace:${current.subject}` : null,
        },
      }),
    );

    await vi.waitFor(() => {
      expect(getAuthState(client)).toEqual({
        status: "authenticated",
        identity,
        identityKey: "workspace:carol",
      });
    });
  });

  it("exposes the active embedded identity", async ({ track }) => {
    const identity = createTestIdentity({ subject: "dana" });

    const client = track(
      createConvexClient({
        convex: { modules: createModules() },
        auth: { getUserIdentity: vi.fn(async () => identity) },
      }),
    );

    await vi.waitFor(() => {
      expect(getAuthIdentity(client)).toEqual(identity);
    });
  });

  it("logout clears embedded identity without deleting local state", async ({
    track,
  }) => {
    const identity = createTestIdentity({ subject: "erin" });

    const client = track(
      createConvexClient({
        convex: { modules: createModules() },
        auth: { getUserIdentity: vi.fn(async () => identity) },
      }),
    );

    await vi.waitFor(() => {
      expect(getAuthIdentity(client)).toEqual(identity);
    });
    await logout(client);

    expect(getAuthIdentity(client)).toBeNull();
    expect(getAuthState(client)).toEqual({ status: "unauthenticated" });
  });

  it("switchIdentity updates the active embedded identity", async ({
    track,
  }) => {
    const alice = createTestIdentity({ subject: "alice" });
    const bob = createTestIdentity({ subject: "bob" });

    const client = track(
      createConvexClient({
        convex: { modules: createModules() },
        auth: { getUserIdentity: vi.fn(async () => alice) },
      }),
    );

    await vi.waitFor(() => {
      expect(getAuthIdentity(client)).toEqual(alice);
    });
    await switchIdentity(client, bob);

    expect(getAuthIdentity(client)).toEqual(bob);
    expect(getAuthState(client)).toEqual({
      status: "authenticated",
      identity: bob,
      identityKey: bob.tokenIdentifier,
    });
  });

  it("reauthenticate forces a token refresh", async ({ track }) => {
    const identity = createTestIdentity({ subject: "frank" });
    const fetchToken = vi.fn(async () => "token");

    const client = track(
      createConvexClient({
        convex: { modules: createModules() },
        auth: { fetchToken, getUserIdentity: async () => identity },
      }),
    );

    await reauthenticate(client);

    expect(fetchToken).toHaveBeenCalledWith({ forceRefreshToken: true });
  });

  it("clearAuth resets local auth state and forwards to the remote client", async ({
    track,
  }) => {
    const identity = createTestIdentity({ subject: "grace" });

    const client = track(
      createConvexClient({
        convex: { modules: createModules() },
        remote: { url: "https://remote.example.convex.cloud" },
        auth: { getUserIdentity: vi.fn(async () => identity) },
      }),
    );

    await vi.waitFor(() => {
      expect(getAuthIdentity(client)).toEqual(identity);
    });

    const [, remoteClient] = (await mockBrowserModule()).__mock.instances();

    (client as ConvexClient & { clearAuth: () => void }).clearAuth();
    await vi.waitFor(() => {
      expect(getAuthState(client)).toEqual({ status: "unauthenticated" });
    });

    expect(remoteClient!.clearAuth).toHaveBeenCalledOnce();
    expect(getAuthIdentity(client)).toBeNull();
  });

  it("propagates auth changes across tabs when getUserIdentity is configured", async ({
    track,
  }) => {
    let currentIdentity = createTestIdentity({ subject: "alice" });

    const clientA = track(
      createConvexClient({
        convex: { modules: createModules() },
        name: "shared-app",
        auth: { getUserIdentity: async () => currentIdentity },
      }),
    );
    const clientB = track(
      createConvexClient({
        convex: { modules: createModules() },
        name: "shared-app",
        auth: { getUserIdentity: async () => currentIdentity },
      }),
    );

    await vi.waitFor(() => {
      expect(getAuthState(clientA).status).toBe("authenticated");
    });
    currentIdentity = createTestIdentity({ subject: "bob" });
    await switchIdentity(clientA, currentIdentity);

    await vi.waitFor(() => {
      expect(getAuthState(clientB)).toEqual({
        status: "authenticated",
        identity: currentIdentity,
        identityKey: currentIdentity.tokenIdentifier,
      });
    });
  });

  it("delivers auth updates in order and isolates listener exceptions", async ({
    track,
  }) => {
    const alice = createTestIdentity({ subject: "alice" });
    const bob = createTestIdentity({ subject: "bob" });

    const client = track(
      createConvexClient({
        convex: { modules: createModules() },
        auth: { getUserIdentity: vi.fn(async () => alice) },
      }),
    );

    await vi.waitFor(() => {
      expect(getAuthState(client).status).toBe("authenticated");
    });

    const noisyListener = vi.fn(() => {
      throw new Error("listener boom");
    });
    const observedStates: string[] = [];
    const unsubscribeNoisy = subscribeAuthState(client, noisyListener);
    const unsubscribeObserved = subscribeAuthState(client, (state) => {
      observedStates.push(state.status);
    });

    await switchIdentity(client, bob);
    await logout(client);

    unsubscribeNoisy();
    unsubscribeObserved();

    expect(noisyListener).toHaveBeenCalledTimes(2);
    expect(observedStates).toEqual(["authenticated", "unauthenticated"]);
  });

  it("stops delivering auth updates after unsubscribe", async ({ track }) => {
    const alice = createTestIdentity({ subject: "alice" });
    const bob = createTestIdentity({ subject: "bob" });

    const client = track(
      createConvexClient({
        convex: { modules: createModules() },
        auth: { getUserIdentity: vi.fn(async () => alice) },
      }),
    );

    await vi.waitFor(() => {
      expect(getAuthState(client).status).toBe("authenticated");
    });

    const callback = vi.fn();
    const unsubscribe = subscribeAuthState(client, callback);

    await switchIdentity(client, bob);
    unsubscribe();

    await logout(client);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenLastCalledWith({
      status: "authenticated",
      identity: bob,
      identityKey: bob.tokenIdentifier,
    });
  });
});
