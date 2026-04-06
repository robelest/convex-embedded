import { createTestIdentity } from "@embedded/auth/resolver";
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
  reloadIdentity: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("@/client/engine", () => ({
  engine: {
    create: vi.fn(() => {
      let onChange: ((status: unknown) => void) | null = null;
      const instance = {
        mutation: vi.fn(),
        on: vi.fn((event: string, cb: (status: unknown) => void) => {
          if (event === "change") {
            onChange = cb;
          }
        }),
        start: vi.fn(),
        stop: vi.fn(),
        pendingCount: vi.fn(() => 0),
        reloadIdentity: vi.fn(async () => {}),
      };

      engineInstances.push({
        emitChange: (status) => onChange?.(status),
        reloadIdentity: instance.reloadIdentity,
        stop: instance.stop,
      });

      return instance;
    }),
  },
}));

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

const whoamiRef = "auth:whoami";
const identityKeyRef = "auth:identityKey";

let createConvexClient: typeof import("@resolve/browser/index").createConvexClient;
let getAuthIdentity: typeof import("@resolve/browser/index").getAuthIdentity;
let getAuthState: typeof import("@resolve/browser/index").getAuthState;
let logout: typeof import("@resolve/browser/index").logout;
let switchIdentity: typeof import("@resolve/browser/index").switchIdentity;

function createModules() {
  return {
    "./convex/_generated/api.ts": async () => ({}),
    "./convex/auth.ts": async () => {
      const { query } = await import("../../convex/_generated/server");
      return {
        whoami: query({
          args: {},
          handler: async (ctx) => await ctx.auth.getUserIdentity(),
        }),
        identityKey: query({
          args: {},
          handler: async (ctx) =>
            (await ctx.auth.getUserIdentity())?.tokenIdentifier ?? null,
        }),
      };
    },
  };
}

function createRemoteModules() {
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
    ...createModules(),
    "./convex/tasks.ts": async () => ({
      resolve: resolveExport,
      list: () => [],
    }),
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("multi-client auth lifecycle", () => {
  const clientsToClose: Array<{ close: () => Promise<void> }> = [];

  beforeEach(async () => {
    const convexBrowser = (await vi.importMock("convex/browser")) as {
      __mock: { reset: () => void };
    };
    ({
      createConvexClient,
      getAuthIdentity,
      getAuthState,
      logout,
      switchIdentity,
    } = await import("@resolve/browser/index"));
    convexBrowser.__mock.reset();
    engineInstances.length = 0;
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

  it("keeps two clients aligned with shared native getUserIdentity state", async () => {
    let currentIdentity: ReturnType<typeof createTestIdentity> | null =
      createTestIdentity({ subject: "alice" });
    const getUserIdentity = vi.fn(async () => currentIdentity);

    const clientA = createConvexClient({
      modules: createModules(),
      name: "multiclient-auth",
      auth: { getUserIdentity },
    });
    const clientB = createConvexClient({
      modules: createModules(),
      name: "multiclient-auth",
      auth: { getUserIdentity },
    });
    clientsToClose.push(clientA as any, clientB as any);

    await settle();

    expect(getAuthState(clientA)).toEqual({
      status: "authenticated",
      identity: currentIdentity,
      identityKey: currentIdentity.tokenIdentifier,
    });
    expect(getAuthState(clientB)).toEqual({
      status: "authenticated",
      identity: currentIdentity,
      identityKey: currentIdentity.tokenIdentifier,
    });
    await expect(clientA.query(whoamiRef, {})).resolves.toEqual(
      currentIdentity,
    );
    await expect(clientB.query(identityKeyRef, {})).resolves.toBe(
      currentIdentity.tokenIdentifier,
    );

    const bob = createTestIdentity({ subject: "bob" });
    currentIdentity = bob;
    await switchIdentity(clientA, bob);
    await settle();

    expect(getAuthIdentity(clientA)).toEqual(bob);
    expect(getAuthIdentity(clientB)).toEqual(bob);
    expect(getAuthState(clientA)).toEqual({
      status: "authenticated",
      identity: bob,
      identityKey: bob.tokenIdentifier,
    });
    expect(getAuthState(clientB)).toEqual({
      status: "authenticated",
      identity: bob,
      identityKey: bob.tokenIdentifier,
    });
    await expect(clientA.query(whoamiRef, {})).resolves.toEqual(bob);
    await expect(clientB.query(whoamiRef, {})).resolves.toEqual(bob);

    currentIdentity = null;
    await logout(clientA);
    await settle();

    expect(getAuthState(clientA)).toEqual({ status: "unauthenticated" });
    expect(getAuthState(clientB)).toEqual({ status: "unauthenticated" });
    await expect(clientA.query(whoamiRef, {})).resolves.toBeNull();
    await expect(clientB.query(identityKeyRef, {})).resolves.toBeNull();
  });

  it("keeps identityMismatch scoped to the client that still owns pending work", async () => {
    let currentIdentity = createTestIdentity({ subject: "alice" });
    const clientA = createConvexClient({
      modules: createModules(),
      name: "multiclient-mismatch",
      auth: { getUserIdentity: async () => currentIdentity },
    });
    const clientB = createConvexClient({
      modules: createModules(),
      name: "multiclient-mismatch",
      auth: { getUserIdentity: async () => currentIdentity },
    });
    clientsToClose.push(clientA as any, clientB as any);

    await settle();

    const { getAuthEntry } = await import("@resolve/client/auth");
    const runtime = getAuthEntry(clientA)?.runtime;
    expect(runtime).toBeDefined();

    await runtime!.executeLocal({
      kind: "mutation",
      path: "_system:pendingPush",
      args: {
        ref: "tasks:create",
        args: JSON.stringify({ title: "offline" }),
        localResult: JSON.stringify("local-1"),
        table: "tasks",
        identityKey: currentIdentity.tokenIdentifier,
      },
      applyLocalEffects: false,
    });

    const bob = createTestIdentity({ subject: "bob" });
    currentIdentity = bob;
    await switchIdentity(clientA, bob);
    await settle();

    expect(getAuthState(clientA)).toEqual({
      status: "identityMismatch",
      identity: bob,
      identityKey: bob.tokenIdentifier,
    });
    expect(getAuthState(clientB)).toEqual({
      status: "authenticated",
      identity: bob,
      identityKey: bob.tokenIdentifier,
    });
    await expect(clientA.query(whoamiRef, {})).resolves.toEqual(bob);
    await expect(clientB.query(whoamiRef, {})).resolves.toEqual(bob);
  });

  it("closing one client does not break the surviving client's identity updates", async () => {
    let currentIdentity = createTestIdentity({ subject: "alice" });
    const clientA = createConvexClient({
      modules: createModules(),
      name: "multiclient-close",
      auth: { getUserIdentity: async () => currentIdentity },
    });
    const clientB = createConvexClient({
      modules: createModules(),
      name: "multiclient-close",
      auth: { getUserIdentity: async () => currentIdentity },
    });
    clientsToClose.push(clientA as any, clientB as any);

    await settle();
    await clientA.close();
    clientsToClose.shift();

    const bob = createTestIdentity({ subject: "bob" });
    currentIdentity = bob;
    await switchIdentity(clientB, bob);
    await settle();

    expect(getAuthState(clientB)).toEqual({
      status: "authenticated",
      identity: bob,
      identityKey: bob.tokenIdentifier,
    });
    await expect(clientB.query(whoamiRef, {})).resolves.toEqual(bob);
  });

  it("reconnect preserves the refreshed native identity across clients", async () => {
    let currentIdentity = createTestIdentity({ subject: "alice" });
    const clientA = createConvexClient({
      modules: createRemoteModules(),
      name: "multiclient-reconnect",
      remote: { url: "https://remote.example.convex.cloud" },
      auth: { getUserIdentity: async () => currentIdentity },
    });
    const clientB = createConvexClient({
      modules: createRemoteModules(),
      name: "multiclient-reconnect",
      remote: { url: "https://remote.example.convex.cloud" },
      auth: { getUserIdentity: async () => currentIdentity },
    });
    clientsToClose.push(clientA as any, clientB as any);

    await settle();

    engineInstances[0]?.emitChange({ status: "offline" });

    const bob = createTestIdentity({ subject: "bob" });
    currentIdentity = bob;
    await switchIdentity(clientA, bob);
    await settle();

    engineInstances[0]?.emitChange({ status: "resolving" });

    expect(getAuthState(clientA)).toEqual({
      status: "authenticated",
      identity: bob,
      identityKey: bob.tokenIdentifier,
    });
    expect(getAuthState(clientB)).toEqual({
      status: "authenticated",
      identity: bob,
      identityKey: bob.tokenIdentifier,
    });
    await expect(clientA.query(whoamiRef, {})).resolves.toEqual(bob);
    await expect(clientB.query(identityKeyRef, {})).resolves.toBe(
      bob.tokenIdentifier,
    );
  });

  it("closing one remote client does not break the surviving client's reconnect flow", async () => {
    let currentIdentity = createTestIdentity({ subject: "alice" });
    const clientA = createConvexClient({
      modules: createRemoteModules(),
      name: "multiclient-remote-close",
      remote: { url: "https://remote.example.convex.cloud" },
      auth: { getUserIdentity: async () => currentIdentity },
    });
    const clientB = createConvexClient({
      modules: createRemoteModules(),
      name: "multiclient-remote-close",
      remote: { url: "https://remote.example.convex.cloud" },
      auth: { getUserIdentity: async () => currentIdentity },
    });
    clientsToClose.push(clientA as any, clientB as any);

    await settle();
    await clientA.close();
    clientsToClose.shift();

    const bob = createTestIdentity({ subject: "bob" });
    currentIdentity = bob;
    await switchIdentity(clientB, bob);
    await settle();

    engineInstances.at(-1)?.emitChange({ status: "resolving" });

    expect(getAuthState(clientB)).toEqual({
      status: "authenticated",
      identity: bob,
      identityKey: bob.tokenIdentifier,
    });
  });
});
