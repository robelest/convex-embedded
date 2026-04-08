import { engine } from "@resolve/client/engine";
import type { Definition } from "@resolve/server/schema";
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vite-plus/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal mock schema Definition for testing.
 * Uses plain (LWW) fields for title and body — no CRDT types,
 * no omitted fields.
 */
function createMockSchema(overrides?: Partial<Definition>): Definition {
  return {
    version: 1,
    shape: { title: "string", body: "string" },
    defaults: {},
    getShape: () => ({ title: "string", body: "string" }),
    getCrdtFields: () => new Map(),
    getOmittedFields: () => [],
    ...overrides,
  } as Definition;
}

function createMockLocalClient(): any {
  let pendingEntries: Array<Record<string, unknown>> = [];
  let nextPendingId = 1;

  return {
    query: vi.fn().mockImplementation((path: string) => {
      const routes: Record<string, unknown> = {
        "_system:idMapGetAll": [],
      };
      if (path === "_system:pendingGetAll") {
        return Promise.resolve([...pendingEntries]);
      }
      return Promise.resolve(routes[path] ?? null);
    }),
    mutation: vi.fn().mockImplementation((path: string, args: any) => {
      if (path === "_system:pendingPush") {
        const entry = {
          _id: `pending-doc-${nextPendingId++}`,
          ...args,
        };
        pendingEntries.push(entry);
        return Promise.resolve(entry._id);
      }
      if (path === "_system:pendingClaimNext") {
        const entry = pendingEntries.find(
          (current) =>
            (current.identityKey ?? null) === (args.identityKey ?? null) &&
            (((current.state as string | undefined) ?? "pending") ===
              "pending" ||
              (((current.state as string | undefined) ?? "pending") ===
                "processing" &&
                typeof current.leaseExpiresAt === "number" &&
                current.leaseExpiresAt <= Date.now())),
        );
        if (!entry) {
          return Promise.resolve(null);
        }
        entry.state = "processing";
        entry.owner = args.owner;
        entry.processingStartedAt = Date.now();
        entry.leaseExpiresAt = Date.now() + (args.leaseMs ?? 30_000);
        return Promise.resolve({ ...entry });
      }
      if (path === "_system:pendingRenewLease") {
        const entry = pendingEntries.find((current) => current._id === args.id);
        if (entry && entry.owner === args.owner) {
          entry.leaseExpiresAt = Date.now() + (args.leaseMs ?? 30_000);
          return Promise.resolve(true);
        }
        return Promise.resolve(false);
      }
      if (path === "_system:pendingRemove") {
        pendingEntries = pendingEntries.filter(
          (entry) => entry._id !== args.id,
        );
        return Promise.resolve(null);
      }
      if (path === "_system:pendingRelease") {
        const entry = pendingEntries.find((current) => current._id === args.id);
        if (entry) {
          entry.state = "pending";
          delete entry.owner;
          delete entry.processingStartedAt;
          delete entry.leaseExpiresAt;
          delete entry.blockedReason;
        }
        return Promise.resolve(null);
      }
      if (path === "_system:pendingBlock") {
        const entry = pendingEntries.find((current) => current._id === args.id);
        if (entry) {
          entry.state = "blocked";
          entry.blockedReason = args.reason;
          delete entry.owner;
          delete entry.processingStartedAt;
          delete entry.leaseExpiresAt;
        }
        return Promise.resolve(null);
      }
      if (path === "_system:pendingUnblockAll") {
        pendingEntries = pendingEntries.map((entry) => ({
          ...entry,
          state: "pending",
          blockedReason: undefined,
          owner: undefined,
          processingStartedAt: undefined,
          leaseExpiresAt: undefined,
        }));
        return Promise.resolve(null);
      }
      if (path === "_system:pendingClear") {
        pendingEntries = [];
        return Promise.resolve(null);
      }
      if (path === "_system:idMapSet") {
        return Promise.resolve(null);
      }
      if (path === "_system:idMapDelete") {
        return Promise.resolve(null);
      }
      if (path === "_system:authStateSetActive") {
        return Promise.resolve(null);
      }
      if (path === "_system:pendingListIdentityKeys") {
        return Promise.resolve([]);
      }

      const routes: Record<string, unknown> = {};
      return Promise.resolve(routes[path] ?? null);
    }),
  };
}

function createMockEmbedded(): any {
  const localClient = createMockLocalClient();
  const storageMetadata = new Map<string, Record<string, unknown>>();
  const storageBlobs = new Map<string, Blob>();
  const uploadUrlSources = new Map<string, string>();
  return {
    embedded: {
      client: localClient as any,
      ingestDocuments: vi.fn().mockResolvedValue(undefined),
      getDocumentsForTable: vi.fn().mockResolvedValue([]),
      getStorageMetadata: vi
        .fn()
        .mockImplementation(async (storageId: string) => {
          return storageMetadata.get(storageId) ?? null;
        }),
      getStorageBlob: vi.fn().mockImplementation(async (storageId: string) => {
        return storageBlobs.get(storageId) ?? null;
      }),
      registerUploadUrlSource: vi.fn((uploadUrl: string, refName: string) => {
        uploadUrlSources.set(uploadUrl, refName);
      }),
    } as any,
    localClient, // keep reference for assertions
    storageMetadata,
    storageBlobs,
    uploadUrlSources,
  };
}

function createStatefulEmbedded(
  initialDocs: Array<Record<string, unknown>>,
): any {
  let docs = [...initialDocs];
  const localClient = {
    query: vi.fn().mockImplementation((path: string) => {
      const routes: Record<string, unknown> = {
        "_system:idMapGetAll": [],
        "_system:pendingGetAll": [],
      };
      return Promise.resolve(routes[path] ?? null);
    }),
    mutation: vi
      .fn()
      .mockImplementation((path: string, args: Record<string, unknown>) => {
        if (path === "_system:pendingPush") {
          return Promise.resolve(`pending-${Math.random()}`);
        }
        if (path === "tasks:remove") {
          docs = docs.filter((doc) => doc._id !== args.id);
          return Promise.resolve(args.id);
        }
        if (path === "tasks:create") {
          const created = {
            _id: "local-created",
            _creationTime: 2,
            title: args.title,
            body: args.body ?? "",
          };
          docs = [...docs, created];
          return Promise.resolve(created._id);
        }
        return Promise.resolve(null);
      }),
  };

  const embedded: any = {
    client: localClient as any,
    ingestDocuments: vi
      .fn()
      .mockImplementation(
        async (_table: string, nextDocs: Array<Record<string, unknown>>) => {
          docs = [...nextDocs];
        },
      ),
    getDocumentsForTable: vi.fn().mockImplementation(async () => [...docs]),
  };

  return {
    embedded,
    localClient,
    getDocs: () => docs,
  };
}

function createMockRemoteClient(): any {
  return {
    query: vi.fn().mockResolvedValue([]),
    mutation: vi.fn().mockResolvedValue(null),
    onUpdate: vi.fn().mockReturnValue(vi.fn()), // returns unsubscribe fn
  };
}

function createSharedPendingEmbeddedPair(): any {
  let pendingEntries: Array<Record<string, unknown>> = [];
  let nextPendingId = 1;

  function createLocalClient() {
    return {
      query: vi.fn().mockImplementation((path: string, args?: any) => {
        if (path === "_system:idMapGetAll") {
          return Promise.resolve([]);
        }
        if (path === "_system:pendingGetAll") {
          return Promise.resolve(
            pendingEntries.filter(
              (entry) =>
                (entry.identityKey ?? null) === (args?.identityKey ?? null),
            ),
          );
        }
        return Promise.resolve(null);
      }),
      mutation: vi.fn().mockImplementation((path: string, args: any) => {
        if (path === "_system:pendingPush") {
          const entry = {
            _id: `shared-pending-${nextPendingId++}`,
            ...args,
          };
          pendingEntries.push(entry);
          return Promise.resolve(entry._id);
        }
        if (path === "_system:pendingClaimNext") {
          const entry = pendingEntries.find(
            (current) =>
              (current.identityKey ?? null) === (args.identityKey ?? null) &&
              (((current.state as string | undefined) ?? "pending") ===
                "pending" ||
                (((current.state as string | undefined) ?? "pending") ===
                  "processing" &&
                  typeof current.leaseExpiresAt === "number" &&
                  current.leaseExpiresAt <= Date.now())),
          );
          if (!entry) {
            return Promise.resolve(null);
          }
          entry.state = "processing";
          entry.owner = args.owner;
          entry.processingStartedAt = Date.now();
          entry.leaseExpiresAt = Date.now() + (args.leaseMs ?? 30_000);
          return Promise.resolve({ ...entry });
        }
        if (path === "_system:pendingRenewLease") {
          const entry = pendingEntries.find(
            (current) => current._id === args.id,
          );
          if (entry && entry.owner === args.owner) {
            entry.leaseExpiresAt = Date.now() + (args.leaseMs ?? 30_000);
            return Promise.resolve(true);
          }
          return Promise.resolve(false);
        }
        if (path === "_system:pendingRemove") {
          pendingEntries = pendingEntries.filter(
            (entry) =>
              entry._id !== args.id ||
              (args.owner !== undefined && entry.owner !== args.owner),
          );
          return Promise.resolve(null);
        }
        if (path === "_system:pendingRelease") {
          const entry = pendingEntries.find(
            (current) => current._id === args.id,
          );
          if (entry && (!args.owner || entry.owner === args.owner)) {
            entry.state = "pending";
            delete entry.owner;
            delete entry.processingStartedAt;
            delete entry.leaseExpiresAt;
            delete entry.blockedReason;
          }
          return Promise.resolve(null);
        }
        if (path === "_system:pendingBlock") {
          const entry = pendingEntries.find(
            (current) => current._id === args.id,
          );
          if (entry) {
            entry.state = "blocked";
            entry.blockedReason = args.reason;
            delete entry.owner;
            delete entry.processingStartedAt;
            delete entry.leaseExpiresAt;
          }
          return Promise.resolve(null);
        }
        if (path === "_system:pendingUnblockAll") {
          pendingEntries = pendingEntries.map((entry) => ({
            ...entry,
            state: "pending",
            blockedReason: undefined,
            owner: undefined,
            processingStartedAt: undefined,
            leaseExpiresAt: undefined,
          }));
          return Promise.resolve(null);
        }
        return Promise.resolve(null);
      }),
    };
  }

  const localClientA = createLocalClient();
  const localClientB = createLocalClient();

  return {
    embeddedA: {
      client: localClientA,
      ingestDocuments: vi.fn().mockResolvedValue(undefined),
      getDocumentsForTable: vi.fn().mockResolvedValue([]),
      getStorageMetadata: vi.fn().mockResolvedValue(null),
      getStorageBlob: vi.fn().mockResolvedValue(null),
      registerUploadUrlSource: vi.fn(),
    },
    embeddedB: {
      client: localClientB,
      ingestDocuments: vi.fn().mockResolvedValue(undefined),
      getDocumentsForTable: vi.fn().mockResolvedValue([]),
      getStorageMetadata: vi.fn().mockResolvedValue(null),
      getStorageBlob: vi.fn().mockResolvedValue(null),
      registerUploadUrlSource: vi.fn(),
    },
    localClientA,
    localClientB,
    getPendingEntries: () => pendingEntries,
  };
}

function settle(ms = 50) {
  return new Promise((r) => setTimeout(r, ms));
}

function getRegisteredHandler(eventName: string): () => void {
  const addCalls = (globalThis.addEventListener as ReturnType<typeof vi.fn>)
    .mock.calls;
  const entry = addCalls.find((call: unknown[]) => call[0] === eventName);
  expect(entry).toBeDefined();
  return entry![1] as () => void;
}

function getRegisteredHandlers(eventName: string): Array<() => void> {
  const addCalls = (globalThis.addEventListener as ReturnType<typeof vi.fn>)
    .mock.calls;
  return addCalls
    .filter((call: unknown[]) => call[0] === eventName)
    .map((call: unknown[]) => call[1] as () => void);
}

/** Shorthand for a table config with both resolve and query refs. */
function tableConfig(
  resolve: string,
  query: string = `${resolve.split(".")[0]}_list`,
  schema: Definition = createMockSchema(),
) {
  return { resolve, query, schema };
}

function createEngine(config: any) {
  return engine.create(config as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("engine.create()", () => {
  let originalAddEventListener: typeof globalThis.addEventListener | undefined;
  let originalRemoveEventListener:
    | typeof globalThis.removeEventListener
    | undefined;
  let originalNavigator: any;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalAddEventListener = globalThis.addEventListener;
    originalRemoveEventListener = globalThis.removeEventListener;
    originalNavigator = globalThis.navigator;
    originalFetch = globalThis.fetch;

    globalThis.addEventListener = vi.fn();
    globalThis.removeEventListener = vi.fn();

    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: true },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    originalAddEventListener &&
      (globalThis.addEventListener = originalAddEventListener);
    originalRemoveEventListener &&
      (globalThis.removeEventListener = originalRemoveEventListener);
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
  });

  // -------------------------------------------------------------------------
  // Basic structure
  // -------------------------------------------------------------------------

  it("returns an EngineInstance with expected methods", () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    expect(m).toHaveProperty("start");
    expect(m).toHaveProperty("stop");
    expect(m).toHaveProperty("on");
    expect(m).toHaveProperty("getStatus");
    expect(m).toHaveProperty("resolveNow");
    expect(m).toHaveProperty("mutation");
    expect(m).toHaveProperty("pendingCount");
    expect(m).toHaveProperty("idMap");
    expect(m).toHaveProperty("pendingQueue");
  });

  it("starts with idle status before start()", () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    expect(m.getStatus()).toEqual({ status: "idle" });
  });

  // -------------------------------------------------------------------------
  // Start / Stop lifecycle
  // -------------------------------------------------------------------------

  it("transitions through resolving to resolved on start() when online", async () => {
    const { embedded, localClient } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    const statuses: string[] = [];
    m.on("change", (status) => statuses.push(status.status));

    m.start();
    await settle();

    expect(statuses).toContain("resolving");
    expect(statuses).toContain("resolved");

    // Hydration queries were issued on localClient
    expect(localClient.query).toHaveBeenCalledWith("_system:idMapGetAll", {
      identityKey: null,
    });
    expect(localClient.query).toHaveBeenCalledWith("_system:pendingGetAll", {
      identityKey: null,
    });

    m.stop();
  });

  it("transitions to offline on start() when navigator.onLine is false", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    const statuses: string[] = [];
    m.on("change", (status) => statuses.push(status.status));

    m.start();

    expect(statuses).toContain("offline");
    expect(remoteClient.query).not.toHaveBeenCalled();

    m.stop();
  });

  it("start() is idempotent", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    m.start();
    m.start();
    m.start();

    await settle();

    // Resolve query called once per table (1 table), not tripled
    expect(remoteClient.query).toHaveBeenCalledTimes(1);

    m.stop();
  });

  it("uses resolveArgs for remote subscriptions when provided", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: {
        tasks: {
          ...tableConfig("resolve_ref"),
          resolveArgs: () => ({ owner: "alice" }),
        },
      },
    });

    m.start();
    await settle();

    expect(remoteClient.onUpdate).toHaveBeenCalledWith(
      "resolve_ref_list",
      { owner: "alice" },
      expect.any(Function),
      expect.any(Function),
    );

    m.stop();
  });

  it("stop() cleans up and sets status to idle", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    m.start();
    await settle();
    m.stop();

    expect(m.getStatus()).toEqual({ status: "idle" });
  });

  it("stop() removes event listeners", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    m.start();
    await settle();

    const addCalls = (globalThis.addEventListener as ReturnType<typeof vi.fn>)
      .mock.calls.length;
    expect(addCalls).toBeGreaterThan(0);

    m.stop();

    const removeCalls = (
      globalThis.removeEventListener as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    expect(removeCalls).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Resolve
  // -------------------------------------------------------------------------

  it("calls resolve query for each registered table", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: {
        tasks: tableConfig("tasks.resolve"),
        comments: tableConfig("comments.resolve"),
      },
    });

    m.start();
    await settle();

    expect(remoteClient.query).toHaveBeenCalledTimes(2);
    expect(remoteClient.query).toHaveBeenCalledWith("tasks.resolve", {
      documents: [],
    });
    expect(remoteClient.query).toHaveBeenCalledWith("comments.resolve", {
      documents: [],
    });

    m.stop();
  });

  it("transitions to error when resolve fails after retries", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient: any = {
      query: vi.fn().mockRejectedValue(new Error("network error")),
      mutation: vi.fn().mockResolvedValue(null),
      onUpdate: vi.fn().mockReturnValue(vi.fn()),
    };

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
      maxRetries: 2,
      retryDelayMs: 10,
    });

    const statuses: string[] = [];
    m.on("change", (status) => statuses.push(status.status));

    m.start();
    await settle(200);

    expect(statuses).toContain("error");

    m.stop();
  });

  // -------------------------------------------------------------------------
  // Remote subscriptions
  // -------------------------------------------------------------------------

  it("starts remote subscriptions after resolve completes", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref", "tasks_list") },
    });

    m.start();
    await settle();

    // onUpdate should have been called for each table
    expect(remoteClient.onUpdate).toHaveBeenCalledTimes(1);
    expect(remoteClient.onUpdate).toHaveBeenCalledWith(
      "tasks_list",
      {},
      expect.any(Function),
      expect.any(Function),
    );

    m.stop();
  });

  it("stop() unsubscribes from remote subscriptions", async () => {
    const unsubscribe = vi.fn();
    const { embedded } = createMockEmbedded();
    const remoteClient: any = {
      ...createMockRemoteClient(),
      onUpdate: vi.fn().mockReturnValue(unsubscribe),
    };

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref", "tasks_list") },
    });

    m.start();
    await settle();
    m.stop();

    expect(unsubscribe).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Event subscription
  // -------------------------------------------------------------------------

  it("on('change', ...) returns an unsubscribe function", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    const listener = vi.fn();
    const unsub = m.on("change", listener);

    expect(typeof unsub).toBe("function");

    m.start();
    await settle();

    expect(listener).toHaveBeenCalled();

    m.stop();
  });

  it("listener receives status changes", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    const statuses: string[] = [];
    m.on("change", (status) => statuses.push(status.status));

    m.start();
    await settle();
    m.stop();

    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses).toContain("resolving");
    expect(statuses).toContain("resolved");
    // stop() clears listeners before emitting idle, so the listener
    // does not observe the final idle transition — verify via getStatus
    expect(m.getStatus()).toEqual({ status: "idle" });
  });

  it("after unsubscribe, listener receives no more calls", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    const listener = vi.fn();
    const unsub = m.on("change", listener);

    m.start();
    await settle();

    const callCount = listener.mock.calls.length;
    expect(callCount).toBeGreaterThan(0);

    unsub();

    // Trigger further status changes — listener should not be called again
    m.stop();
    expect(listener.mock.calls.length).toBe(callCount);
  });

  // -------------------------------------------------------------------------
  // Mutation proxying
  // -------------------------------------------------------------------------

  it("mutation() writes to localClient first", async () => {
    const { embedded, localClient } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    await m.mutation("tasks:create", { title: "Buy milk" });

    expect(localClient.mutation).toHaveBeenCalledWith("tasks:create", {
      title: "Buy milk",
    });
  });

  it("mutation() returns the local result", async () => {
    const { embedded, localClient } = createMockEmbedded();
    localClient.mutation.mockImplementation((path: string) => {
      const routes: Record<string, unknown> = {
        "_system:pendingPush": "pending-doc-1",
      };
      return Promise.resolve(routes[path] ?? { _id: "local-123" });
    });
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    const result = await m.mutation("tasks:create", { title: "Buy milk" });

    expect(result).toEqual({ _id: "local-123" });
  });

  it("mutation() persists to pending queue via localClient", async () => {
    const { embedded, localClient } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    await m.mutation("tasks:create", { title: "Buy milk" });
    await settle();

    // The pendingPush system mutation should have been called
    expect(localClient.mutation).toHaveBeenCalledWith(
      "_system:pendingPush",
      expect.objectContaining({
        ref: expect.any(String),
        args: expect.any(String),
        localResult: expect.any(String),
        table: expect.any(String),
      }),
    );
  });

  it("mutation() does not restart remote subscriptions while replaying online", async () => {
    const unsubscribe = vi.fn();
    const { embedded } = createMockEmbedded();
    const remoteClient: any = {
      ...createMockRemoteClient(),
      onUpdate: vi.fn().mockReturnValue(unsubscribe),
    };

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref", "tasks_list") },
    });

    m.start();
    await settle();

    expect(remoteClient.query).toHaveBeenCalledTimes(1);
    expect(remoteClient.onUpdate).toHaveBeenCalledTimes(1);

    await m.mutation("tasks:create", { title: "Buy milk" });
    await settle(100);

    expect(unsubscribe).not.toHaveBeenCalled();
    expect(remoteClient.query).toHaveBeenCalledTimes(1);
    expect(remoteClient.onUpdate).toHaveBeenCalledTimes(1);
    expect(remoteClient.mutation).toHaveBeenCalledTimes(1);

    m.stop();
  });

  it("projects pending deletes over stale remote snapshots", async () => {
    const { embedded, getDocs } = createStatefulEmbedded([
      { _id: "task-1", _creationTime: 1, title: "Keep", body: "" },
      { _id: "task-2", _creationTime: 2, title: "Delete me", body: "" },
    ]);
    let onUpdateHandler:
      | ((docs: Array<Record<string, unknown>>) => void)
      | null = null;
    const remoteClient: any = {
      ...createMockRemoteClient(),
      mutation: vi
        .fn()
        .mockImplementation(
          () =>
            new Promise((resolve) => setTimeout(() => resolve("task-2"), 50)),
        ),
      onUpdate: vi
        .fn()
        .mockImplementation(
          (
            _query: unknown,
            _args: unknown,
            onUpdate: (docs: Array<Record<string, unknown>>) => void,
          ) => {
            onUpdateHandler = onUpdate;
            return vi.fn();
          },
        ),
    };

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("tasks:resolve", "tasks:list") },
    });

    m.start();
    await settle();

    await m.mutation("tasks:remove", { id: "task-2" });
    expect(
      getDocs().some((doc: Record<string, unknown>) => doc._id === "task-2"),
    ).toBe(false);

    if (onUpdateHandler) {
      const handler = onUpdateHandler as (
        docs: Array<Record<string, unknown>>,
      ) => void;
      handler([
        { _id: "task-1", _creationTime: 1, title: "Keep", body: "" },
        { _id: "task-2", _creationTime: 2, title: "Delete me", body: "" },
      ]);
    }
    await settle(20);

    expect(
      getDocs().some((doc: Record<string, unknown>) => doc._id === "task-2"),
    ).toBe(false);

    if (onUpdateHandler) {
      const handler = onUpdateHandler as (
        docs: Array<Record<string, unknown>>,
      ) => void;
      handler([{ _id: "task-1", _creationTime: 1, title: "Keep", body: "" }]);
    }
    await settle(80);

    expect(getDocs().map((doc: Record<string, unknown>) => doc._id)).toEqual([
      "task-1",
    ]);
    m.stop();
  });

  it("mutation() coalesces duplicate queued removes for the same document", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    const { embedded, localClient } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    m.start();
    await settle();

    await m.mutation("tasks:remove", { id: "task-1" });
    await m.mutation("tasks:remove", { id: "task-1" });

    const pendingPushCalls = localClient.mutation.mock.calls.filter(
      ([path]: [string]) => path === "_system:pendingPush",
    );

    expect(pendingPushCalls).toHaveLength(1);
    expect(m.pendingCount()).toBe(1);
  });

  it("mutation() rejects when pending persistence degrades to ephemeral queueing", async () => {
    const { embedded, localClient } = createMockEmbedded();
    localClient.mutation.mockImplementation((path: string) => {
      if (path === "_system:pendingPush") {
        return Promise.reject(new Error("write failed"));
      }
      return Promise.resolve({ _id: "local-123" });
    });
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    await expect(
      m.mutation("tasks:create", { title: "Buy milk" }),
    ).rejects.toThrow(/queued entry is ephemeral/);
    expect(m.pendingCount()).toBe(1);
    expect(m.pendingQueue.peek()?._id).toMatch(/^ephemeral_/);
  });

  // -------------------------------------------------------------------------
  // resolveNow
  // -------------------------------------------------------------------------

  it("resolveNow() triggers a resolve cycle", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    await m.resolveNow();

    expect(remoteClient.query).toHaveBeenCalledTimes(1);
    expect(m.getStatus()).toEqual({ status: "resolved" });
  });

  it("resolveNow() ingests remote-only documents returned by resolve", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();
    remoteClient.query.mockResolvedValue([
      {
        docId: "remote-task-1",
        document: {
          _id: "remote-task-1",
          _creationTime: 1,
          title: "Remote task",
          body: "from remote",
        },
      },
    ]);

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    await m.resolveNow();

    expect(embedded.ingestDocuments).toHaveBeenCalledWith("tasks", [
      {
        _id: "remote-task-1",
        _creationTime: 1,
        title: "Remote task",
        body: "from remote",
      },
    ]);
  });

  it("resolveNow() strips omitted fields from remote-only documents", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();
    const schemaWithOmit = createMockSchema({
      getOmittedFields: () => ["secretField"],
    });
    remoteClient.query.mockResolvedValue([
      {
        docId: "remote-task-1",
        document: {
          _id: "remote-task-1",
          _creationTime: 1,
          title: "Remote task",
          body: "from remote",
          secretField: "nope",
        },
      },
    ]);

    const m = createEngine({
      embedded,
      remoteClient,
      tables: {
        tasks: tableConfig("resolve_ref", "tasks_list", schemaWithOmit),
      },
    });

    await m.resolveNow();

    expect(embedded.ingestDocuments).toHaveBeenCalledWith("tasks", [
      {
        _id: "remote-task-1",
        _creationTime: 1,
        title: "Remote task",
        body: "from remote",
      },
    ]);
  });

  it("passes scoped resolve args to the resolve query", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: {
        tasks: {
          ...tableConfig("resolve_ref", "tasks_list"),
          resolveArgs: () => ({ owner: "alice" }),
        },
      },
    });

    await m.resolveNow();

    expect(remoteClient.query).toHaveBeenCalledWith("resolve_ref", {
      documents: [],
      scopeArgs: { owner: "alice" },
    });
  });

  it("reloadIdentity() rehydrates scoped state before resolving", async () => {
    let activeIdentityKey: string | null = "user:a";
    const localClient = {
      query: vi
        .fn()
        .mockImplementation(
          (path: string, args?: { identityKey?: string | null }) => {
            if (path === "_system:idMapGetAll") {
              return Promise.resolve(
                args?.identityKey === "user:b"
                  ? [
                      {
                        localId: "local-b",
                        remoteId: "remote-b",
                        table: "tasks",
                      },
                    ]
                  : [
                      {
                        localId: "local-a",
                        remoteId: "remote-a",
                        table: "tasks",
                      },
                    ],
              );
            }

            if (path === "_system:pendingGetAll") {
              return Promise.resolve(
                args?.identityKey === "user:b"
                  ? [
                      {
                        _id: "pending-b",
                        ref: "tasks:create",
                        args: JSON.stringify({ id: "local-b" }),
                        localResult: JSON.stringify({ _id: "local-b" }),
                        table: "tasks",
                      },
                    ]
                  : [],
              );
            }

            return Promise.resolve(null);
          },
        ),
      mutation: vi.fn().mockResolvedValue("pending-doc-1"),
    };

    const embedded: any = {
      client: localClient,
      ingestDocuments: vi.fn().mockResolvedValue(undefined),
      getDocumentsForTable: vi.fn().mockResolvedValue([]),
    };
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
      getIdentityKey: () => activeIdentityKey,
    });

    m.start();
    await settle();

    activeIdentityKey = "user:b";
    await m.reloadIdentity();

    expect(localClient.query).toHaveBeenCalledWith("_system:idMapGetAll", {
      identityKey: "user:b",
    });
    expect(localClient.query).toHaveBeenCalledWith("_system:pendingGetAll", {
      identityKey: "user:b",
    });
    expect(remoteClient.mutation).toHaveBeenCalledWith(expect.anything(), {
      id: "remote-b",
    });
    expect(m.pendingCount()).toBe(0);
    m.stop();
  });

  // -------------------------------------------------------------------------
  // pendingCount
  // -------------------------------------------------------------------------

  it("pendingCount() reflects queue size", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    expect(m.pendingCount()).toBe(0);

    // Mutation goes through local write then queues — go offline so queue stays
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    m.start();
    await settle();

    await m.mutation("tasks:create", { title: "Task 1" });
    await settle();

    expect(m.pendingCount()).toBeGreaterThanOrEqual(1);

    m.stop();
  });

  // -------------------------------------------------------------------------
  // Resolve — local docs gathered
  // -------------------------------------------------------------------------

  it("resolve reads local docs via getDocumentsForTable", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    m.start();
    await settle();

    expect(embedded.getDocumentsForTable).toHaveBeenCalledWith("tasks");

    m.stop();
  });

  it("resolve sends state vectors for local docs to remote query", async () => {
    const { embedded } = createMockEmbedded();
    // Return a local doc so the resolve encodes its state vector.
    embedded.getDocumentsForTable.mockResolvedValue([
      { _id: "doc-1", _creationTime: 100, title: "Hello", body: "World" },
    ]);

    const remoteClient = createMockRemoteClient();
    // The resolve query should return results per-document.
    remoteClient.query.mockResolvedValue([
      { docId: "doc-1" }, // no diff — client is up-to-date
    ]);

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    m.start();
    await settle();

    // The resolve query should have been called with documents
    // containing state vectors (ArrayBuffer).
    expect(remoteClient.query).toHaveBeenCalledTimes(1);
    const [, resolveArgs] = remoteClient.query.mock.calls[0]!;
    expect(resolveArgs.documents).toHaveLength(1);
    expect(resolveArgs.documents[0].docId).toBe("doc-1");
    expect(resolveArgs.documents[0].vector).toBeInstanceOf(ArrayBuffer);

    m.stop();
  });

  // -------------------------------------------------------------------------
  // Resolve — diff application + ingest
  // -------------------------------------------------------------------------

  it("resolve ingests materialized docs after applying diffs", async () => {
    const { embedded } = createMockEmbedded();
    embedded.getDocumentsForTable.mockResolvedValue([
      { _id: "doc-1", _creationTime: 100, title: "Old", body: "Text" },
    ]);

    const remoteClient = createMockRemoteClient();
    // Return no diff — client is up-to-date.
    remoteClient.query.mockResolvedValue([
      { docId: "doc-1" }, // no diff field
    ]);

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    m.start();
    await settle();

    // ingestDocuments should have been called with the materialized doc.
    expect(embedded.ingestDocuments).toHaveBeenCalledWith(
      "tasks",
      expect.arrayContaining([
        expect.objectContaining({ _id: "doc-1", _creationTime: 100 }),
      ]),
    );

    m.stop();
  });

  // -------------------------------------------------------------------------
  // schema.omit() stripping in reactive subscriptions
  // -------------------------------------------------------------------------

  it("strips omitted fields from remote subscription data before ingesting", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const schemaWithOmit = createMockSchema({
      getOmittedFields: () => ["secretField", "internalData"],
    });

    const m = createEngine({
      embedded,
      remoteClient,
      tables: {
        tasks: tableConfig("resolve_ref", "tasks_list", schemaWithOmit),
      },
    });

    m.start();
    await settle();

    // Get the onUpdate callback that was registered.
    expect(remoteClient.onUpdate).toHaveBeenCalledTimes(1);
    const onUpdateCallback = remoteClient.onUpdate.mock.calls[0]![2];

    // Simulate a remote update with omitted fields.
    onUpdateCallback([
      {
        _id: "doc-1",
        _creationTime: 100,
        title: "Task",
        body: "Body",
        secretField: "should-be-stripped",
        internalData: { nested: true },
      },
    ]);

    await settle();

    // ingestDocuments should have been called with the omitted fields removed.
    expect(embedded.ingestDocuments).toHaveBeenCalledWith("tasks", [
      expect.objectContaining({
        _id: "doc-1",
        _creationTime: 100,
        title: "Task",
        body: "Body",
      }),
    ]);

    // Verify the omitted fields are NOT present.
    const ingestCall = embedded.ingestDocuments.mock.calls.find(
      (call: any[]) => call[0] === "tasks",
    );
    expect(ingestCall).toBeDefined();
    const ingestedDoc = ingestCall![1][0];
    expect(ingestedDoc).not.toHaveProperty("secretField");
    expect(ingestedDoc).not.toHaveProperty("internalData");

    m.stop();
  });

  it("stops retrying buffered snapshot ingests after the retry budget is exhausted", async () => {
    vi.useFakeTimers();
    try {
      const { embedded } = createMockEmbedded();
      embedded.ingestDocuments.mockRejectedValue(new Error("broken snapshot"));

      const remoteClient = createMockRemoteClient();
      const unsubscribe = vi.fn();
      remoteClient.onUpdate = vi.fn().mockReturnValue(unsubscribe);

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref", "tasks_list") },
      });

      m.start();
      await vi.runAllTimersAsync();

      expect(remoteClient.onUpdate).toHaveBeenCalledTimes(1);
      const onUpdateCallback = remoteClient.onUpdate.mock.calls[0]![2];
      onUpdateCallback([
        {
          _id: "doc-1",
          _creationTime: 1,
          title: "Task",
          body: "Body",
        },
      ]);

      await vi.runAllTimersAsync();
      const callCountAfterRetries = embedded.ingestDocuments.mock.calls.length;

      await vi.advanceTimersByTimeAsync(30_000);

      expect(callCountAfterRetries).toBeGreaterThan(1);
      expect(embedded.ingestDocuments).toHaveBeenCalledTimes(
        callCountAfterRetries,
      );
      m.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // -------------------------------------------------------------------------
  // processQueue()
  // -------------------------------------------------------------------------

  describe("processQueue()", () => {
    it("forwards a queued mutation to remoteClient.mutation", async () => {
      const { embedded, localClient } = createMockEmbedded();
      localClient.mutation.mockImplementation((path: string) => {
        const routes: Record<string, unknown> = {
          "_system:pendingPush": "pending-doc-1",
          "_system:pendingRemove": null,
        };
        return Promise.resolve(routes[path] ?? { _id: "local-1" });
      });

      const remoteClient = createMockRemoteClient();
      remoteClient.mutation.mockResolvedValue("remote-1");

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      m.start();
      await settle();

      await m.mutation("tasks:create", { title: "Buy milk" });
      await settle();

      expect(remoteClient.mutation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ title: "Buy milk" }),
      );
      m.stop();
    });

    it("records local→remote ID mapping when results differ", async () => {
      const { embedded, localClient } = createMockEmbedded();
      localClient.mutation.mockImplementation((path: string) => {
        const routes: Record<string, unknown> = {
          "_system:pendingPush": "pending-doc-1",
          "_system:pendingRemove": null,
          "_system:idMapSet": null,
        };
        return Promise.resolve(routes[path] ?? "local-uuid-1");
      });

      const remoteClient = createMockRemoteClient();
      remoteClient.mutation.mockResolvedValue("remote-id-99");

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      m.start();
      await settle();

      const result = await m.mutation("tasks:create", { title: "Test" });

      expect(result).toBe("remote-id-99");
      expect(m.idMap.getRemoteId("local-uuid-1")).toBe("remote-id-99");
      m.stop();
    });

    it("canonicalizes nested id fields in later union members after create replay", async () => {
      const { embedded, localClient } = createMockEmbedded();
      let docs: Array<Record<string, unknown>> = [
        {
          _id: "local-uuid-1",
          _creationTime: 1,
          title: "Task",
          relation: {
            kind: "linked",
            issueId: "local-uuid-1",
          },
        },
      ];
      embedded.getDocumentsForTable.mockImplementation(async () => [...docs]);
      embedded.ingestDocuments.mockImplementation(
        async (_table: string, nextDocs: Array<Record<string, unknown>>) => {
          docs = [...nextDocs];
        },
      );

      const baseMutation = localClient.mutation.getMockImplementation();
      localClient.mutation.mockImplementation((path: string, args: any) => {
        if (path === "tasks:create") {
          return Promise.resolve("local-uuid-1");
        }
        return baseMutation ? baseMutation(path, args) : Promise.resolve(null);
      });

      const relationField = {
        kind: "union",
        members: [
          {
            kind: "object",
            fields: {
              kind: { kind: "literal", value: "plain" },
              note: { kind: "string" },
            },
          },
          {
            kind: "object",
            fields: {
              kind: { kind: "literal", value: "linked" },
              issueId: { kind: "id", tableName: "tasks" },
            },
          },
        ],
      };
      const unionSchema = createMockSchema({
        shape: {
          title: "string",
          relation: relationField,
        },
        getShape: () => ({
          title: "string",
          relation: relationField,
        }),
      });

      const remoteClient = createMockRemoteClient();
      remoteClient.mutation.mockResolvedValue("remote-id-99");

      const m = createEngine({
        embedded,
        remoteClient,
        tables: {
          tasks: tableConfig("resolve_ref", "tasks_list", unionSchema),
        },
      });

      m.start();
      await settle();

      await m.mutation("tasks:create", { title: "Task" });
      await settle();

      expect(docs).toEqual([
        expect.objectContaining({
          _id: "remote-id-99",
          relation: {
            kind: "linked",
            issueId: "remote-id-99",
          },
        }),
      ]);
      m.stop();
    });

    it("dequeues entries after successful remote push", async () => {
      const { embedded, localClient } = createMockEmbedded();
      localClient.mutation.mockImplementation((path: string) => {
        const routes: Record<string, unknown> = {
          "_system:pendingPush": "pending-doc-1",
          "_system:pendingRemove": null,
        };
        return Promise.resolve(routes[path] ?? { _id: "local-1" });
      });

      const remoteClient = createMockRemoteClient();
      remoteClient.mutation.mockResolvedValue({ _id: "local-1" });

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      m.start();
      await settle();

      await m.mutation("tasks:create", { title: "A" });
      await settle(100);

      expect(m.pendingCount()).toBe(0);
      m.stop();
    });

    it("continues draining when creates enqueue during an active queue pass", async () => {
      const { embedded, localClient } = createMockEmbedded();
      let pendingId = 0;
      localClient.mutation.mockImplementation((path: string) => {
        if (path === "_system:pendingPush") {
          pendingId += 1;
          return Promise.resolve(`pending-doc-${pendingId}`);
        }
        if (path === "_system:pendingRemove") {
          return Promise.resolve(null);
        }
        if (path === "_system:idMapSet") {
          return Promise.resolve(null);
        }
        return Promise.resolve(`local-uuid-${pendingId + 1}`);
      });

      let releaseFirst!: () => void;
      const firstRemoteMutation = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let remoteCalls = 0;
      const remoteClient = createMockRemoteClient();
      remoteClient.mutation.mockImplementation(async () => {
        remoteCalls += 1;
        if (remoteCalls === 1) {
          await firstRemoteMutation;
          return "remote-id-1";
        }
        return `remote-id-${remoteCalls}`;
      });

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      m.start();
      await settle();

      const firstCreate = m.mutation("tasks:create", { title: "First" });
      await settle();
      const secondCreate = m.mutation("tasks:create", { title: "Second" });
      releaseFirst();

      await Promise.all([firstCreate, secondCreate]);
      await settle(50);

      expect(remoteClient.mutation).toHaveBeenCalledTimes(2);
      expect(m.pendingCount()).toBe(0);
      expect(m.idMap.getRemoteId("local-uuid-1")).toBe("remote-id-1");
      expect(m.idMap.getRemoteId("local-uuid-2")).toBe("remote-id-2");
      m.stop();
    });

    it("does not send a remote mutation when a hydrated entry loses its lease before push", async () => {
      const { embedded, localClient } = createMockEmbedded();
      let pendingReads = 0;
      localClient.query.mockImplementation((path: string) => {
        if (path === "_system:pendingGetAll") {
          pendingReads += 1;
          return Promise.resolve(
            pendingReads === 1
              ? [
                  {
                    _id: "pending-doc-1",
                    ref: "tasks:update",
                    args: JSON.stringify({
                      id: "remote-1",
                      title: "Lease lost",
                    }),
                    localResult: JSON.stringify(null),
                    table: "tasks",
                    state: "pending",
                  },
                ]
              : [],
          );
        }
        const routes: Record<string, unknown> = {
          "_system:idMapGetAll": [],
        };
        return Promise.resolve(routes[path] ?? null);
      });
      localClient.mutation.mockImplementation((path: string, args: any) => {
        if (path === "_system:pendingClaimNext") {
          if (args.owner === "processor_lease_loss") {
            return Promise.resolve(null);
          }
          return Promise.resolve({
            _id: "pending-doc-1",
            ref: "tasks:update",
            args: JSON.stringify({ id: "remote-1", title: "Lease lost" }),
            localResult: JSON.stringify(null),
            table: "tasks",
            state: "processing",
            owner: args.owner,
            leaseExpiresAt: Date.now() + (args.leaseMs ?? 30_000),
          });
        }
        if (path === "_system:pendingRenewLease") {
          return Promise.resolve(false);
        }
        return Promise.resolve(null);
      });

      const remoteClient = createMockRemoteClient();

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
        processorId: "processor_lease_loss",
      });

      m.start();
      await settle(150);

      expect(remoteClient.mutation).not.toHaveBeenCalled();
      expect(m.pendingCount()).toBe(0);
      m.stop();
    });

    it("keeps renewing the lease while a remote mutation is in flight", async () => {
      vi.useFakeTimers();
      try {
        const { embedded, localClient } = createMockEmbedded();
        localClient.mutation.mockImplementation((path: string, _args: any) => {
          if (path === "_system:pendingPush") {
            return Promise.resolve("pending-doc-1");
          }
          if (path === "_system:pendingRenewLease") {
            return Promise.resolve(true);
          }
          if (path === "_system:pendingRemove") {
            return Promise.resolve(null);
          }
          if (path === "_system:idMapSet") {
            return Promise.resolve(null);
          }
          if (path === "tasks:create") {
            return Promise.resolve("local-uuid-1");
          }
          return Promise.resolve(null);
        });

        const remoteClient = createMockRemoteClient();
        remoteClient.mutation.mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve("remote-id-1"), 2_200);
            }),
        );

        const m = createEngine({
          embedded,
          remoteClient,
          tables: { tasks: tableConfig("resolve_ref") },
          leaseMs: 3_000,
        });

        m.start();
        await vi.runOnlyPendingTimersAsync();

        const mutationPromise = m.mutation("tasks:create", {
          title: "Slow push",
        });
        await vi.advanceTimersByTimeAsync(2_500);
        await mutationPromise;

        const renewCalls = localClient.mutation.mock.calls.filter(
          (call: unknown[]) => call[0] === "_system:pendingRenewLease",
        );
        expect(renewCalls.length).toBeGreaterThanOrEqual(2);
        m.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops a hydrated create entry when its local id is already mapped", async () => {
      const { embedded, localClient } = createMockEmbedded();
      localClient.query.mockImplementation((path: string) => {
        const routes: Record<string, unknown> = {
          "_system:idMapGetAll": [
            {
              localId: "local-uuid-1",
              remoteId: "remote-id-99",
              table: "tasks",
            },
          ],
          "_system:pendingGetAll": [
            {
              _id: "pending-doc-1",
              ref: "tasks:create",
              args: JSON.stringify({ title: "Buy milk" }),
              localResult: JSON.stringify("local-uuid-1"),
              table: "tasks",
            },
          ],
        };
        return Promise.resolve(routes[path] ?? null);
      });
      localClient.mutation.mockImplementation((path: string) => {
        const routes: Record<string, unknown> = {
          "_system:pendingRemove": null,
        };
        return Promise.resolve(routes[path] ?? null);
      });

      const remoteClient = createMockRemoteClient();

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      m.start();
      await settle(100);

      expect(remoteClient.mutation).not.toHaveBeenCalled();
      expect(m.pendingCount()).toBe(0);
      expect(localClient.mutation).toHaveBeenCalledWith(
        "_system:pendingRemove",
        expect.objectContaining({
          id: "pending-doc-1",
        }),
      );

      m.stop();
    });

    it("retains entry in queue on remote push failure", async () => {
      const { embedded, localClient } = createMockEmbedded();
      localClient.mutation.mockImplementation((path: string) => {
        const routes: Record<string, unknown> = {
          "_system:pendingPush": "pending-doc-1",
        };
        return Promise.resolve(routes[path] ?? { _id: "local-1" });
      });

      const remoteClient = createMockRemoteClient();
      remoteClient.mutation.mockRejectedValue(new Error("network failure"));

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      m.start();
      await settle();

      await m.mutation("tasks:create", { title: "Fail" });
      await settle(100);

      expect(m.pendingCount()).toBeGreaterThanOrEqual(1);
      m.stop();
    });

    it("blocks a queued entry on authorization failure", async () => {
      const { embedded, localClient } = createMockEmbedded();
      localClient.mutation.mockImplementation((path: string) => {
        const routes: Record<string, unknown> = {
          "_system:pendingPush": "pending-doc-1",
          "_system:pendingBlock": null,
        };
        return Promise.resolve(routes[path] ?? { _id: "local-1" });
      });

      const remoteClient = createMockRemoteClient();
      remoteClient.mutation.mockRejectedValue(new Error("forbidden"));

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      m.start();
      await settle();

      await m.mutation("tasks:create", { title: "Denied" });
      await settle(100);

      expect(localClient.mutation).toHaveBeenCalledWith(
        "_system:pendingBlock",
        {
          id: "pending-doc-1",
          reason: "authorizationDenied",
        },
      );
      expect(m.pendingCount()).toBeGreaterThanOrEqual(1);
      m.stop();
    });
  });

  // -------------------------------------------------------------------------
  // offline → online cycle
  // -------------------------------------------------------------------------

  describe("offline → online cycle", () => {
    it("queues mutations while offline and flushes when online event fires", async () => {
      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: false },
        writable: true,
        configurable: true,
      });

      const { embedded, localClient } = createMockEmbedded();
      localClient.mutation.mockImplementation((path: string) => {
        const routes: Record<string, unknown> = {
          "_system:pendingPush": "pending-doc-1",
          "_system:pendingRemove": null,
        };
        return Promise.resolve(routes[path] ?? { _id: "local-1" });
      });

      const remoteClient = createMockRemoteClient();
      remoteClient.mutation.mockResolvedValue({ _id: "local-1" });

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      m.start();
      await settle();

      await m.mutation("tasks:create", { title: "Offline 1" });
      await m.mutation("tasks:create", { title: "Offline 2" });
      await settle();

      expect(remoteClient.mutation).not.toHaveBeenCalled();
      expect(m.pendingCount()).toBe(2);

      // Find the registered "online" handler from mocked addEventListener
      const onlineHandler = getRegisteredHandler("online");

      // Go online
      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: true },
        writable: true,
        configurable: true,
      });
      onlineHandler();
      await settle(200);

      expect(remoteClient.mutation).toHaveBeenCalledTimes(2);
      m.stop();
    });

    it("uploads local storage blobs before replaying queued mutations", async () => {
      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: false },
        writable: true,
        configurable: true,
      });

      const { embedded, storageMetadata, storageBlobs } = createMockEmbedded();
      const localStorageId = "11111111-1111-4111-8111-111111111111";
      storageMetadata.set(localStorageId, {
        size: 11,
        contentType: "text/plain",
      });
      storageBlobs.set(
        localStorageId,
        new Blob(["hello world"], { type: "text/plain" }),
      );

      const remoteClient = createMockRemoteClient();
      remoteClient.mutation.mockImplementation((ref: any, args: any) => {
        const name =
          typeof ref === "string" ? ref : ref[Symbol.for("functionName")];
        if (name === "files:generateUploadUrl") {
          return Promise.resolve("https://uploads.example/upload");
        }
        return Promise.resolve({ ...args, _id: "remote-doc-1" });
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ storageId: "remote-storage-1" }),
      } as Response);

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
        uploadUrlRef: "files:generateUploadUrl",
      });

      m.start();
      await settle();

      await m.mutation("tasks:create", {
        title: "Offline with file",
        attachmentId: localStorageId,
      });
      await settle();

      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: true },
        writable: true,
        configurable: true,
      });
      getRegisteredHandler("online")();
      await settle(200);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://uploads.example/upload",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "text/plain" },
        }),
      );
      expect(remoteClient.mutation).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          [Symbol.for("functionName")]: "files:generateUploadUrl",
        }),
        {},
      );
      expect(remoteClient.mutation).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          [Symbol.for("functionName")]: "tasks:create",
        }),
        expect.objectContaining({
          title: "Offline with file",
          attachmentId: "remote-storage-1",
        }),
      );
      m.stop();
    });

    it("treats local upload URL mutations as invisible replay dependencies", async () => {
      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: false },
        writable: true,
        configurable: true,
      });

      const { embedded, localClient, storageMetadata, storageBlobs } =
        createMockEmbedded();
      const originalMutation = localClient.mutation.getMockImplementation();
      localClient.mutation.mockImplementation((path: string, args: any) => {
        if (path === "files:generateUploadUrl") {
          return Promise.resolve(
            "http://convex-embedded.local/__convex_embedded/upload/token-1",
          );
        }
        if (path === "tasks:create") {
          return Promise.resolve({ ...args, _id: "local-doc-1" });
        }
        return originalMutation
          ? originalMutation(path, args)
          : Promise.resolve(null);
      });

      const localStorageId = "22222222-2222-4222-8222-222222222222";
      storageMetadata.set(localStorageId, {
        size: 11,
        contentType: "text/plain",
        uploadSourceRef: "files:generateUploadUrl",
      });
      storageBlobs.set(
        localStorageId,
        new Blob(["hello world"], { type: "text/plain" }),
      );

      const remoteClient = createMockRemoteClient();
      remoteClient.mutation.mockImplementation((ref: any, args: any) => {
        const name =
          typeof ref === "string" ? ref : ref[Symbol.for("functionName")];
        if (name === "files:generateUploadUrl") {
          return Promise.resolve("https://uploads.example/upload");
        }
        return Promise.resolve({ ...args, _id: "remote-doc-2" });
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ storageId: "remote-storage-2" }),
      } as Response);

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      m.start();
      await settle();

      const localUploadUrl = await m.mutation("files:generateUploadUrl", {});
      expect(localUploadUrl).toBe(
        "http://convex-embedded.local/__convex_embedded/upload/token-1",
      );
      expect(embedded.registerUploadUrlSource).toHaveBeenCalledWith(
        localUploadUrl,
        "files:generateUploadUrl",
      );

      await m.mutation("tasks:create", {
        title: "Offline with invisible file sync",
        attachmentId: localStorageId,
      });
      await settle();

      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: true },
        writable: true,
        configurable: true,
      });
      getRegisteredHandler("online")();
      await settle(200);

      expect(remoteClient.mutation).toHaveBeenCalledTimes(2);
      expect(remoteClient.mutation).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          [Symbol.for("functionName")]: "files:generateUploadUrl",
        }),
        {},
      );
      expect(remoteClient.mutation).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          [Symbol.for("functionName")]: "tasks:create",
        }),
        expect.objectContaining({ attachmentId: "remote-storage-2" }),
      );
      m.stop();
    });

    it("two engines sharing pending storage do not replay the same entry twice", async () => {
      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: false },
        writable: true,
        configurable: true,
      });

      const { embeddedA, embeddedB, getPendingEntries } =
        createSharedPendingEmbeddedPair();
      const remoteClientA = createMockRemoteClient();
      const remoteClientB = createMockRemoteClient();

      const engineA = createEngine({
        embedded: embeddedA,
        remoteClient: remoteClientA,
        tables: { tasks: tableConfig("resolve_ref") },
      });
      const engineB = createEngine({
        embedded: embeddedB,
        remoteClient: remoteClientB,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      engineA.start();
      engineB.start();
      await settle();

      await engineA.mutation("tasks:create", { title: "Offline once" });
      await settle();

      expect(getPendingEntries()).toHaveLength(1);

      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: true },
        writable: true,
        configurable: true,
      });

      for (const handler of getRegisteredHandlers("online")) {
        handler();
      }
      await settle(200);

      expect(
        remoteClientA.mutation.mock.calls.length +
          remoteClientB.mutation.mock.calls.length,
      ).toBe(1);
      expect(getPendingEntries()).toHaveLength(0);

      engineA.stop();
      engineB.stop();
    });

    it("releases a claimed entry back to pending when replay fails with an unknown error", async () => {
      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: false },
        writable: true,
        configurable: true,
      });

      const { embeddedA, getPendingEntries } =
        createSharedPendingEmbeddedPair();
      const remoteClientA: any = {
        ...createMockRemoteClient(),
        mutation: vi.fn().mockRejectedValue(new Error("boom")),
      };

      const engineA = createEngine({
        embedded: embeddedA,
        remoteClient: remoteClientA,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      engineA.start();
      await settle();

      await engineA.mutation("tasks:create", { title: "Offline once" });
      await settle();

      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: true },
        writable: true,
        configurable: true,
      });

      for (const handler of getRegisteredHandlers("online")) {
        handler();
      }
      await settle(150);

      expect(remoteClientA.mutation).toHaveBeenCalledTimes(1);
      expect(getPendingEntries()).toHaveLength(1);
      expect(getPendingEntries()[0]?.state).toBe("pending");
      expect(getPendingEntries()[0]?.owner).toBeUndefined();

      engineA.stop();
    });

    it("reclaims an expired replay lease after another engine stalls", async () => {
      const originalNow = Date.now;
      let now = 1_000;
      Date.now = () => now;
      try {
        Object.defineProperty(globalThis, "navigator", {
          value: { onLine: false },
          writable: true,
          configurable: true,
        });

        const { embeddedA, embeddedB, getPendingEntries } =
          createSharedPendingEmbeddedPair();
        const remoteClientA: any = {
          ...createMockRemoteClient(),
          mutation: vi.fn(() => new Promise(() => {})),
        };
        const remoteClientB = createMockRemoteClient();

        const engineA = createEngine({
          embedded: embeddedA,
          remoteClient: remoteClientA,
          tables: { tasks: tableConfig("resolve_ref") },
          leaseMs: 100,
        });
        const engineB = createEngine({
          embedded: embeddedB,
          remoteClient: remoteClientB,
          tables: { tasks: tableConfig("resolve_ref") },
          leaseMs: 100,
        });

        engineA.start();
        engineB.start();
        await settle();

        await engineA.mutation("tasks:create", { title: "Offline once" });
        await settle();

        Object.defineProperty(globalThis, "navigator", {
          value: { onLine: true },
          writable: true,
          configurable: true,
        });

        for (const handler of getRegisteredHandlers("online")) {
          handler();
        }
        await settle(80);

        expect(remoteClientA.mutation).toHaveBeenCalledTimes(1);
        expect(remoteClientB.mutation).toHaveBeenCalledTimes(0);
        expect(getPendingEntries()[0]?.state).toBe("processing");

        now += 200;
        await engineB.resolveNow();
        await settle(120);

        expect(remoteClientB.mutation).toHaveBeenCalledTimes(1);
        expect(getPendingEntries()).toHaveLength(0);

        engineA.stop();
        engineB.stop();
      } finally {
        Date.now = originalNow;
      }
    });

    it("coalesces duplicate online events into a single active remote cycle", async () => {
      let resolveQuery!: (value: unknown[]) => void;
      const { embedded } = createMockEmbedded();
      const remoteClient: any = {
        ...createMockRemoteClient(),
        query: vi.fn(
          () =>
            new Promise<unknown[]>((resolve) => {
              resolveQuery = resolve;
            }),
        ),
      };

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      m.start();
      await settle();

      const onlineHandler = getRegisteredHandler("online");
      onlineHandler();
      await settle();

      expect(remoteClient.query).toHaveBeenCalledTimes(1);

      resolveQuery([]);
      await settle(100);

      expect(remoteClient.onUpdate).toHaveBeenCalledTimes(1);
      m.stop();
    });

    it("does not start remote subscriptions while queued mutations remain pending", async () => {
      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: false },
        writable: true,
        configurable: true,
      });

      const { embedded, localClient } = createMockEmbedded();
      localClient.mutation.mockImplementation((path: string) => {
        const routes: Record<string, unknown> = {
          "_system:pendingPush": "pending-doc-1",
        };
        return Promise.resolve(routes[path] ?? { _id: "local-1" });
      });

      const remoteClient: any = {
        ...createMockRemoteClient(),
        mutation: vi.fn().mockRejectedValue(new Error("network failure")),
      };

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref", "tasks_list") },
      });

      m.start();
      await settle();
      await m.mutation("tasks:create", { title: "Offline 1" });
      await settle();

      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: true },
        writable: true,
        configurable: true,
      });

      getRegisteredHandler("online")();
      await settle(150);

      expect(remoteClient.mutation).toHaveBeenCalledTimes(1);
      expect(remoteClient.onUpdate).not.toHaveBeenCalled();
      expect(m.pendingCount()).toBe(1);

      m.stop();
    });

    it("drops remove replays that were already applied remotely", async () => {
      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: false },
        writable: true,
        configurable: true,
      });

      const { embedded } = createMockEmbedded();
      const remoteClient: any = {
        ...createMockRemoteClient(),
        mutation: vi
          .fn()
          .mockRejectedValue(
            new Error("Delete on nonexistent document ID task-1"),
          ),
      };

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref", "tasks_list") },
      });

      m.start();
      await settle();
      await m.mutation("tasks:remove", { id: "task-1" });
      await settle();

      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: true },
        writable: true,
        configurable: true,
      });

      getRegisteredHandler("online")();
      await settle(150);

      expect(remoteClient.mutation).toHaveBeenCalledTimes(1);
      expect(m.pendingCount()).toBe(0);
      expect(remoteClient.query).toHaveBeenCalledTimes(1);
      expect(remoteClient.onUpdate).toHaveBeenCalledTimes(1);

      m.stop();
    });

    it("stops replay after stop() while leaving later entries queued", async () => {
      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: false },
        writable: true,
        configurable: true,
      });

      let releaseFirstPush!: (value: unknown) => void;
      const { embedded, localClient } = createMockEmbedded();
      localClient.mutation.mockImplementation((path: string) => {
        const routes: Record<string, unknown> = {
          "_system:pendingPush": `pending-doc-${localClient.mutation.mock.calls.length}`,
          "_system:pendingRemove": null,
        };
        return Promise.resolve(routes[path] ?? { _id: `local-${Date.now()}` });
      });

      const remoteClient: any = {
        ...createMockRemoteClient(),
        mutation: vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                releaseFirstPush = resolve;
              }),
          )
          .mockResolvedValue({ _id: "remote-2" }),
      };

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      m.start();
      await settle();
      await m.mutation("tasks:create", { title: "Offline 1" });
      await m.mutation("tasks:create", { title: "Offline 2" });
      await settle();

      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: true },
        writable: true,
        configurable: true,
      });

      getRegisteredHandler("online")();
      await settle(50);

      expect(remoteClient.mutation).toHaveBeenCalledTimes(1);

      m.stop();
      releaseFirstPush({ _id: "remote-1" });
      await settle(150);

      expect(remoteClient.mutation).toHaveBeenCalledTimes(1);
      expect(m.pendingCount()).toBeGreaterThanOrEqual(1);
    });

    it("emits offline status on offline event", async () => {
      const { embedded } = createMockEmbedded();
      const remoteClient = createMockRemoteClient();

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      const statuses: string[] = [];
      m.on("change", (s) => statuses.push(s.status));

      m.start();
      await settle();

      // Find the registered "offline" handler
      const offlineHandler = getRegisteredHandler("offline");

      offlineHandler();
      await settle();

      expect(statuses).toContain("offline");
      m.stop();
    });

    it("stops remote subscriptions on offline event", async () => {
      const unsubscribe = vi.fn();
      const { embedded } = createMockEmbedded();
      const remoteClient: any = {
        ...createMockRemoteClient(),
        onUpdate: vi.fn().mockReturnValue(unsubscribe),
      };

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref", "tasks_list") },
      });

      m.start();
      await settle();

      // Subscriptions should be active
      expect(remoteClient.onUpdate).toHaveBeenCalledTimes(1);

      // Find the registered "offline" handler
      const offlineHandler = getRegisteredHandler("offline");

      offlineHandler();
      await settle();

      expect(unsubscribe).toHaveBeenCalled();
      m.stop();
    });
  });
});
