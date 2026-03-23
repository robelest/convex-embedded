import { createTestIdentity } from "@embedded/auth/resolver";
import { EmbeddedRuntime } from "@embedded/runtime/embedded";
import {
  createConvexClient,
  getAuthState,
  getAuthIdentity,
  logout,
  reauthenticate,
  subscribeAuthState,
  switchIdentity,
} from "@resolve/browser/index";
import { ConvexClient } from "convex/browser";
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
      | ((args: { forceRefreshToken: boolean }) => Promise<any>)
      | null = null;

    mutation = vi.fn(async () => undefined);
    query = vi.fn(async () => undefined);
    action = vi.fn(async () => undefined);
    onUpdate = vi.fn(() => (() => {}) as any);
    close = vi.fn(() => undefined);
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
    "./convex/_generated/api.ts": async () => ({}),
    "./convex/tasks.ts": async () => ({
      list: () => [],
    }),
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("auth state accessors", () => {
  const clientsToClose: Array<{ close: () => Promise<void> | void }> = [];

  beforeEach(async () => {
    const convexBrowser = (await vi.importMock("convex/browser")) as {
      __mock: { reset: () => void };
    };
    convexBrowser.__mock.reset();
    MockBroadcastChannel.reset();
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const client of clientsToClose.splice(0)) {
      await client.close();
    }
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

  it("hydrates local auth state from getUserIdentity on create", async () => {
    const identity = createTestIdentity({ subject: "alice" });
    const setIdentitySpy = vi.spyOn(EmbeddedRuntime.prototype, "setIdentity");

    const client = createConvexClient({
      modules: createModules(),
      auth: {
        getUserIdentity: vi.fn(async () => identity),
      },
    });
    clientsToClose.push(client as any);

    await settle();

    expect(setIdentitySpy).toHaveBeenCalledWith(identity);
    expect(getAuthState(client)).toEqual({
      status: "authenticated",
      identity,
      identityKey: identity.tokenIdentifier,
    });
  });

  it("wraps fetchToken and updates local identity when auth succeeds", async () => {
    const identity = createTestIdentity({ subject: "bob" });
    const setIdentitySpy = vi.spyOn(EmbeddedRuntime.prototype, "setIdentity");
    const fetchToken = vi.fn(async () => "token");

    const client = createConvexClient({
      modules: createModules(),
      auth: {
        fetchToken,
        getUserIdentity: vi.fn(async () => identity),
      },
    });
    clientsToClose.push(client as any);

    const convexBrowser = (await vi.importMock("convex/browser")) as {
      __mock: { instances: () => Array<any> };
    };
    const embeddedClient = convexBrowser.__mock.instances()[0];

    expect(getAuthState(client)).toEqual({ status: "idle" });

    const token = await embeddedClient.authFetcher({
      forceRefreshToken: false,
    });

    expect(token).toBe("token");
    expect(fetchToken).toHaveBeenCalledWith({ forceRefreshToken: false });
    expect(setIdentitySpy).toHaveBeenLastCalledWith(identity);
    expect(getAuthState(client)).toEqual({
      status: "authenticated",
      identity,
      identityKey: identity.tokenIdentifier,
    });
  });

  it("clears local identity when fetchToken returns null", async () => {
    const setIdentitySpy = vi.spyOn(EmbeddedRuntime.prototype, "setIdentity");

    const client = createConvexClient({
      modules: createModules(),
      auth: {
        fetchToken: vi.fn(async () => null),
        getUserIdentity: vi.fn(async () => createTestIdentity()),
      },
    });
    clientsToClose.push(client as any);

    const convexBrowser = (await vi.importMock("convex/browser")) as {
      __mock: { instances: () => Array<any> };
    };
    const embeddedClient = convexBrowser.__mock.instances()[0];

    const token = await embeddedClient.authFetcher({ forceRefreshToken: true });

    expect(token).toBeNull();
    expect(setIdentitySpy).toHaveBeenLastCalledWith(null);
    expect(getAuthState(client)).toEqual({ status: "unauthenticated" });
  });

  it("supports custom identity keys", async () => {
    const identity = createTestIdentity({ subject: "carol" });
    const setActiveIdentityKeySpy = vi.spyOn(
      EmbeddedRuntime.prototype,
      "setActiveIdentityKey",
    );

    const client = createConvexClient({
      modules: createModules(),
      auth: {
        getUserIdentity: vi.fn(async () => identity),
        getIdentityKey: (current) =>
          current ? `workspace:${current.subject}` : null,
      },
    });
    clientsToClose.push(client as any);

    await settle();

    expect(getAuthState(client)).toEqual({
      status: "authenticated",
      identity,
      identityKey: "workspace:carol",
    });
    expect(setActiveIdentityKeySpy).toHaveBeenCalledWith("workspace:carol");
  });

  it("exposes the active embedded identity", async () => {
    const identity = createTestIdentity({ subject: "dana" });

    const client = createConvexClient({
      modules: createModules(),
      auth: {
        getUserIdentity: vi.fn(async () => identity),
      },
    });
    clientsToClose.push(client as any);

    await settle();

    expect(getAuthIdentity(client)).toEqual(identity);
  });

  it("logout clears embedded identity without deleting local state", async () => {
    const identity = createTestIdentity({ subject: "erin" });

    const client = createConvexClient({
      modules: createModules(),
      auth: {
        getUserIdentity: vi.fn(async () => identity),
      },
    });
    clientsToClose.push(client as any);

    await settle();
    await logout(client);

    expect(getAuthIdentity(client)).toBeNull();
    expect(getAuthState(client)).toEqual({ status: "unauthenticated" });
  });

  it("switchIdentity updates the active embedded identity", async () => {
    const alice = createTestIdentity({ subject: "alice" });
    const bob = createTestIdentity({ subject: "bob" });

    const client = createConvexClient({
      modules: createModules(),
      auth: {
        getUserIdentity: vi.fn(async () => alice),
      },
    });
    clientsToClose.push(client as any);

    await settle();
    await switchIdentity(client, bob);

    expect(getAuthIdentity(client)).toEqual(bob);
    expect(getAuthState(client)).toEqual({
      status: "authenticated",
      identity: bob,
      identityKey: bob.tokenIdentifier,
    });
  });

  it("reauthenticate forces a token refresh", async () => {
    const identity = createTestIdentity({ subject: "frank" });
    const fetchToken = vi.fn(async () => "token");

    const client = createConvexClient({
      modules: createModules(),
      auth: {
        fetchToken,
        getUserIdentity: async () => identity,
      },
    });
    clientsToClose.push(client as any);

    await reauthenticate(client);

    expect(fetchToken).toHaveBeenCalledWith({ forceRefreshToken: true });
  });

  it("propagates auth changes across tabs when getUserIdentity is configured", async () => {
    let currentIdentity = createTestIdentity({ subject: "alice" });

    const clientA = createConvexClient({
      modules: createModules(),
      name: "shared-app",
      auth: { getUserIdentity: async () => currentIdentity },
    });
    const clientB = createConvexClient({
      modules: createModules(),
      name: "shared-app",
      auth: { getUserIdentity: async () => currentIdentity },
    });
    clientsToClose.push(clientA as any, clientB as any);

    await settle();
    currentIdentity = createTestIdentity({ subject: "bob" });
    await switchIdentity(clientA, currentIdentity);
    await settle();

    expect(getAuthState(clientB)).toEqual({
      status: "authenticated",
      identity: currentIdentity,
      identityKey: currentIdentity.tokenIdentifier,
    });
  });
});
