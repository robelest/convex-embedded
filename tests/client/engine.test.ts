import { engine } from "@resolve/client/engine";
import type {
  EmbeddedClientLike,
  EngineConfig,
  EngineInstance,
  TableConfig,
} from "@resolve/client/engine";
import {
  define,
  prose,
  register as registerField,
} from "@resolve/server/schema";
import type { Definition } from "@resolve/server/schema";
import { canonicalizeMappedCreateTable } from "@resolve/shared/canonicalize";
import { flushMicrotasks, withFakeTimers } from "@tests/helpers/time";
import { describe, it, expect, beforeEach, afterEach } from "@tests/testkit";
import type { ConvexClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import { v } from "convex/values";

// ---------------------------------------------------------------------------
// Mock client / embedded types
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;
type Doc = Record<string, unknown>;
type PendingRow = Record<string, unknown>;

type QueryMock = ReturnType<
  typeof vi.fn<(path: string, args?: Args) => Promise<unknown>>
>;
type MutationMock = ReturnType<
  typeof vi.fn<(path: string, args: Args) => Promise<unknown>>
>;

interface MockSystemClient {
  query: QueryMock;
  mutation: MutationMock;
}

interface MockRemoteClient {
  query: QueryMock;
  mutation: MutationMock;
  onUpdate: ReturnType<typeof vi.fn>;
}

/** Cast a system-path mock into the `ConvexClient` the engine expects. */
function asConvexClient(
  client: MockSystemClient | MockRemoteClient,
): ConvexClient {
  return client as unknown as ConvexClient;
}

/**
 * The mock embedded client. Carries spies for the methods the engine drives;
 * {@link createEngine} adapts it into the real {@link EmbeddedClientLike}.
 */
interface MockEmbedded {
  client: ConvexClient;
  ingestDocuments: ReturnType<typeof vi.fn>;
  canonicalizeMappedCreate: ReturnType<typeof vi.fn>;
  getDocumentsForTable: ReturnType<typeof vi.fn>;
  hasLocalDocumentId?: ReturnType<typeof vi.fn>;
  getStorageMetadata?: ReturnType<typeof vi.fn>;
  getStorageBlob?: ReturnType<typeof vi.fn>;
  registerUploadUrlSource?: ReturnType<typeof vi.fn>;
}

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

function deferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createMockLocalClient(): MockSystemClient {
  let pendingEntries: PendingRow[] = [];
  let nextPendingId = 1;

  return {
    query: vi.fn((path: string): Promise<unknown> => {
      const routes: Record<string, unknown> = {
        "_system:idMapGetAll": [],
      };
      if (path === "_system:pendingGetAll") {
        return Promise.resolve([...pendingEntries]);
      }
      return Promise.resolve(routes[path] ?? null);
    }),
    mutation: vi.fn((path: string, args: Args): Promise<unknown> => {
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
        entry.leaseExpiresAt =
          Date.now() + ((args.leaseMs as number) ?? 30_000);
        return Promise.resolve({ ...entry });
      }
      if (path === "_system:pendingRenewLease") {
        const entry = pendingEntries.find((current) => current._id === args.id);
        if (entry && entry.owner === args.owner) {
          entry.leaseExpiresAt =
            Date.now() + ((args.leaseMs as number) ?? 30_000);
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

      return Promise.resolve(null);
    }),
  };
}

interface MockEmbeddedBundle {
  embedded: MockEmbedded;
  localClient: MockSystemClient;
  storageMetadata: Map<string, Doc>;
  storageBlobs: Map<string, Blob>;
  uploadUrlSources: Map<string, string>;
}

function createMockEmbedded(): MockEmbeddedBundle {
  const localClient = createMockLocalClient();
  const storageMetadata = new Map<string, Doc>();
  const storageBlobs = new Map<string, Blob>();
  const uploadUrlSources = new Map<string, string>();
  const embedded: MockEmbedded = {
    client: asConvexClient(localClient),
    ingestDocuments: vi.fn(async () => undefined),
    canonicalizeMappedCreate: vi.fn(async () => undefined),
    getDocumentsForTable: vi.fn(async () => []),
    getStorageMetadata: vi.fn(async (storageId: string) => {
      return storageMetadata.get(storageId) ?? null;
    }),
    getStorageBlob: vi.fn(async (storageId: string) => {
      return storageBlobs.get(storageId) ?? null;
    }),
    registerUploadUrlSource: vi.fn((uploadUrl: string, refName: string) => {
      uploadUrlSources.set(uploadUrl, refName);
    }),
  };
  return {
    embedded,
    localClient,
    storageMetadata,
    storageBlobs,
    uploadUrlSources,
  };
}

interface StatefulEmbeddedBundle {
  embedded: MockEmbedded;
  localClient: MockSystemClient;
  getDocs: () => Doc[];
}

function createStatefulEmbedded(initialDocs: Doc[]): StatefulEmbeddedBundle {
  let docs = [...initialDocs];
  const localClient: MockSystemClient = {
    query: vi.fn((path: string): Promise<unknown> => {
      const routes: Record<string, unknown> = {
        "_system:idMapGetAll": [],
        "_system:pendingGetAll": [],
      };
      return Promise.resolve(routes[path] ?? null);
    }),
    mutation: vi.fn((path: string, args: Args): Promise<unknown> => {
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

  const embedded: MockEmbedded = {
    client: asConvexClient(localClient),
    ingestDocuments: vi.fn(
      async (
        _table: string,
        nextDocs: Doc[],
        _scopeArgs?: Args,
        options?: { deleteAbsent?: boolean; keepIds?: ReadonlySet<string> },
      ) => {
        const byId = new Map(docs.map((doc) => [doc._id as string, doc]));
        for (const doc of nextDocs) {
          byId.set(doc._id as string, doc);
        }
        if (options?.deleteAbsent !== false) {
          const remoteIds = new Set(nextDocs.map((doc) => doc._id as string));
          const keepIds = options?.keepIds;
          for (const id of Array.from(byId.keys())) {
            if (!remoteIds.has(id) && !(keepIds?.has(id) ?? false)) {
              byId.delete(id);
            }
          }
        }
        docs = [...byId.values()];
      },
    ),
    canonicalizeMappedCreate: vi.fn(
      async (input: {
        localId: string;
        remoteId: string;
        tableName: string;
        schemas: Record<string, Definition>;
      }) => {
        const schema = input.schemas[input.tableName];
        if (!schema) {
          return;
        }
        const canonical = canonicalizeMappedCreateTable({
          docs,
          schema,
          localId: input.localId,
          remoteId: input.remoteId,
          rewriteOwnId: true,
          tableName: input.tableName,
        });
        docs = canonical.documents;
      },
    ),
    getDocumentsForTable: vi.fn(async () => [...docs]),
  };

  return {
    embedded,
    localClient,
    getDocs: () => docs,
  };
}

function createMockRemoteClient(): MockRemoteClient {
  return {
    query: vi.fn(async () => []),
    mutation: vi.fn(async () => null),
    onUpdate: vi.fn(() => vi.fn()), // returns unsubscribe fn
  };
}

interface SharedPendingPair {
  embeddedA: MockEmbedded;
  embeddedB: MockEmbedded;
  localClientA: MockSystemClient;
  localClientB: MockSystemClient;
  getPendingEntries: () => PendingRow[];
}

function createSharedPendingEmbeddedPair(): SharedPendingPair {
  let pendingEntries: PendingRow[] = [];
  let nextPendingId = 1;

  function createLocalClient(): MockSystemClient {
    return {
      query: vi.fn((path: string, args?: Args): Promise<unknown> => {
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
      mutation: vi.fn((path: string, args: Args): Promise<unknown> => {
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
          entry.leaseExpiresAt =
            Date.now() + ((args.leaseMs as number) ?? 30_000);
          return Promise.resolve({ ...entry });
        }
        if (path === "_system:pendingRenewLease") {
          const entry = pendingEntries.find(
            (current) => current._id === args.id,
          );
          if (entry && entry.owner === args.owner) {
            entry.leaseExpiresAt =
              Date.now() + ((args.leaseMs as number) ?? 30_000);
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

  function sharedEmbedded(localClient: MockSystemClient): MockEmbedded {
    return {
      client: asConvexClient(localClient),
      ingestDocuments: vi.fn(async () => undefined),
      canonicalizeMappedCreate: vi.fn(async () => undefined),
      getDocumentsForTable: vi.fn(async () => []),
      getStorageMetadata: vi.fn(async () => null),
      getStorageBlob: vi.fn(async () => null),
      registerUploadUrlSource: vi.fn(),
    };
  }

  return {
    embeddedA: sharedEmbedded(localClientA),
    embeddedB: sharedEmbedded(localClientB),
    localClientA,
    localClientB,
    getPendingEntries: () => pendingEntries,
  };
}

/**
 * Drain queued promise jobs plus the engine's `setTimeout(…, 0)` event-loop
 * yields. Each iteration flushes microtasks then crosses one macrotask
 * boundary, so chained `yieldToEventLoop()` hops settle deterministically
 * without a fixed-duration sleep.
 */
async function settle(iterations = 12): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await flushMicrotasks(3);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await flushMicrotasks(3);
}

function addEventListenerMock(): ReturnType<typeof vi.fn> {
  return globalThis.addEventListener as unknown as ReturnType<typeof vi.fn>;
}

function getRegisteredHandler(eventName: string): () => void {
  const addCalls = addEventListenerMock().mock.calls as Array<
    [string, () => void]
  >;
  const entry = addCalls.find((call) => call[0] === eventName);
  expect(entry).toBeDefined();
  return entry![1];
}

function getRegisteredHandlers(eventName: string): Array<() => void> {
  const addCalls = addEventListenerMock().mock.calls as Array<
    [string, () => void]
  >;
  return addCalls
    .filter((call) => call[0] === eventName)
    .map((call) => call[1]);
}

/** Resolve a mutation ref (string or `FunctionReference`) to its name. */
function refName(ref: unknown): string {
  return typeof ref === "string"
    ? ref
    : getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
}

type SnapshotHandler = (response: unknown) => void;

/** Extract the resolve-update callback passed to `remoteClient.onUpdate`. */
function getSnapshotHandler(
  remoteClient: MockRemoteClient,
  callIndex = 0,
): SnapshotHandler {
  const call = remoteClient.onUpdate.mock.calls[callIndex] as
    | [unknown, unknown, SnapshotHandler, ...unknown[]]
    | undefined;
  expect(call).toBeDefined();
  return call![2];
}

/** Shorthand for a table config with a resolve ref. */
function tableConfig(
  resolve: string,
  _unusedLegacyListRef?: string,
  schema: Definition = createMockSchema(),
): TableConfig {
  return { resolve, schema };
}

interface TestEngineConfig extends Omit<
  EngineConfig,
  "embedded" | "remoteClient"
> {
  embedded: MockEmbedded;
  remoteClient: MockRemoteClient;
}

function createEngine(config: TestEngineConfig): EngineInstance {
  const { embedded, remoteClient, ...rest } = config;
  return engine.create({
    ...rest,
    embedded: embedded as unknown as EmbeddedClientLike,
    remoteClient: asConvexClient(remoteClient),
  });
}

type MutationHandler = (
  path: string,
  args: Args,
) => Promise<unknown> | undefined;

/**
 * Layers a custom mutation handler on top of the base `createMockLocalClient`
 * implementation. The `customHandler` is called first; if it returns
 * `undefined` (not `Promise.resolve(undefined)`!), the call falls through to
 * the original mock implementation which handles all `_system:*` paths.
 */
function layerMutationMock(
  localClient: MockSystemClient,
  customHandler: MutationHandler,
) {
  const baseMutation = localClient.mutation.getMockImplementation();
  localClient.mutation.mockImplementation((path: string, args: Args) => {
    const custom = customHandler(path, args);
    if (custom !== undefined) return custom;
    return baseMutation ? baseMutation(path, args) : Promise.resolve(null);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("engine.create()", () => {
  let originalAddEventListener: typeof globalThis.addEventListener | undefined;
  let originalRemoveEventListener:
    | typeof globalThis.removeEventListener
    | undefined;
  let originalNavigator: Navigator | undefined;
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
    if (originalAddEventListener) {
      globalThis.addEventListener = originalAddEventListener;
    }
    if (originalRemoveEventListener) {
      globalThis.removeEventListener = originalRemoveEventListener;
    }
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

  it("transitions to resolved on start() when online", async () => {
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

    expect(statuses).toContain("resolved");

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

    await m.resolveNow();

    expect(remoteClient.query).toHaveBeenCalledTimes(1);

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
    await m.resolveNow();

    expect(remoteClient.query).toHaveBeenCalledTimes(2);
    expect(remoteClient.query).toHaveBeenCalledWith("tasks.resolve", {
      collectionSeq: null,
      documents: [],
    });
    expect(remoteClient.query).toHaveBeenCalledWith("comments.resolve", {
      collectionSeq: null,
      documents: [],
    });

    m.stop();
  });

  it("hydrates missing referenced documents before ingesting scoped children", async () => {
    const localClient = createMockLocalClient();
    const docsByTable = new Map<string, Array<Record<string, unknown>>>([
      ["projects", []],
      ["issues", []],
    ]);
    const embedded: MockEmbedded = {
      client: asConvexClient(localClient),
      ingestDocuments: vi.fn(async (table: string, docs: Doc[]) => {
        docsByTable.set(table, docs);
      }),
      canonicalizeMappedCreate: vi.fn(async () => undefined),
      getDocumentsForTable: vi.fn(
        async (table: string) => docsByTable.get(table) ?? [],
      ),
      hasLocalDocumentId: vi.fn((id: string) =>
        Array.from(docsByTable.values()).some((docs) =>
          docs.some((doc) => doc._id === id),
        ),
      ),
    };
    const remoteClient: MockRemoteClient = {
      query: vi.fn(async (ref: string, args?: Args) => {
        if (ref === "projects.resolve") {
          return {
            mode: "full",
            collectionSeq: 0,
            documents: ((args?.docIds as string[]) ?? []).map(
              (docId: string) => ({
                docId,
                seq: 0,
                document: {
                  _id: docId,
                  _creationTime: 1,
                  name: "Project",
                },
              }),
            ),
            isDone: true,
            continueCursor: null,
          };
        }
        if (ref === "issues.resolve") {
          return {
            mode: "full",
            collectionSeq: 0,
            documents: [
              {
                docId: "issue-1",
                seq: 0,
                document: {
                  _id: "issue-1",
                  _creationTime: 2,
                  projectId: "project-1",
                  title: "Issue",
                },
              },
            ],
            isDone: true,
            continueCursor: null,
          };
        }
        return { mode: "full", collectionSeq: 0, documents: [] };
      }),
      mutation: vi.fn().mockResolvedValue(null),
      onUpdate: vi.fn().mockReturnValue(vi.fn()),
    };

    const m = createEngine({
      embedded,
      remoteClient,
      tables: {
        projects: tableConfig(
          "projects.resolve",
          undefined,
          createMockSchema({
            shape: { name: "string" },
            getShape: () => ({ name: "string" }),
          }),
        ),
        issues: tableConfig(
          "issues.resolve",
          undefined,
          createMockSchema({
            shape: { projectId: v.id("projects"), title: "string" },
            getShape: () => ({ projectId: v.id("projects"), title: "string" }),
          }),
        ),
      },
    });

    m.start();
    await settle();
    await m.ensureScopeReady("issues", { projectId: "project-1" });

    expect(remoteClient.query).toHaveBeenCalledWith("projects.resolve", {
      collectionSeq: null,
      documents: [],
      docIds: ["project-1"],
    });
    expect(docsByTable.get("projects")).toEqual([
      { _id: "project-1", _creationTime: 1, name: "Project" },
    ]);
    expect(docsByTable.get("issues")).toEqual([
      {
        _id: "issue-1",
        _creationTime: 2,
        projectId: "project-1",
        title: "Issue",
      },
    ]);

    m.stop();
  });

  it("transitions to error when resolve fails after retries", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient: MockRemoteClient = {
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
    await settle();
    void m.resolveNow().catch(() => {});
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

    // onUpdate should have been called for each table, subscribing to the
    // resolve endpoint with stable args.
    expect(remoteClient.onUpdate).toHaveBeenCalledTimes(1);
    expect(remoteClient.onUpdate).toHaveBeenCalledWith(
      "resolve_ref",
      { collectionSeq: null, documents: [] },
      expect.any(Function),
      expect.any(Function),
    );

    m.stop();
  });

  it("stop() unsubscribes from remote subscriptions", async () => {
    const unsubscribe = vi.fn();
    const { embedded } = createMockEmbedded();
    const remoteClient: MockRemoteClient = {
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
    expect(statuses).toContain("resolved");
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
    const remoteClient: MockRemoteClient = {
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

    expect(remoteClient.onUpdate).toHaveBeenCalledTimes(1);
    const onUpdateCallsBeforeMutation = remoteClient.onUpdate.mock.calls.length;
    const queryCallsBeforeMutation = remoteClient.query.mock.calls.length;

    await m.mutation("tasks:create", { title: "Buy milk" });
    await settle(100);

    expect(unsubscribe).not.toHaveBeenCalled();
    expect(remoteClient.query).toHaveBeenCalledTimes(queryCallsBeforeMutation);
    expect(remoteClient.onUpdate).toHaveBeenCalledTimes(
      onUpdateCallsBeforeMutation,
    );
    expect(remoteClient.mutation).toHaveBeenCalledTimes(1);

    m.stop();
  });

  it("projects pending deletes over stale remote snapshots", async () => {
    const { embedded, getDocs } = createStatefulEmbedded([
      { _id: "task-1", _creationTime: 1, title: "Keep", body: "" },
      { _id: "task-2", _creationTime: 2, title: "Delete me", body: "" },
    ]);
    // The remote delete stays in flight for the whole test so the pending
    // delete must keep projecting over the stale snapshots.
    const remoteDelete = deferredPromise<string>();
    const remoteClient: MockRemoteClient = {
      ...createMockRemoteClient(),
      mutation: vi.fn(() => remoteDelete.promise),
      onUpdate: vi.fn(() => vi.fn()),
    };

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("tasks:resolve", "tasks:list") },
    });

    m.start();
    await settle();

    const onUpdateHandler = getSnapshotHandler(remoteClient);

    await m.mutation("tasks:remove", { id: "task-2" });
    expect(getDocs().some((doc) => doc._id === "task-2")).toBe(false);

    onUpdateHandler({
      mode: "full",
      collectionSeq: 1,
      protocolVersion: 1,
      documents: [
        {
          docId: "task-1",
          seq: 1,
          document: {
            _id: "task-1",
            _creationTime: 1,
            title: "Keep",
            body: "",
          },
        },
        {
          docId: "task-2",
          seq: 2,
          document: {
            _id: "task-2",
            _creationTime: 2,
            title: "Delete me",
            body: "",
          },
        },
      ],
    });
    await settle();

    expect(getDocs().some((doc) => doc._id === "task-2")).toBe(false);

    onUpdateHandler({
      mode: "full",
      collectionSeq: 2,
      protocolVersion: 1,
      documents: [
        {
          docId: "task-1",
          seq: 1,
          document: {
            _id: "task-1",
            _creationTime: 1,
            title: "Keep",
            body: "",
          },
        },
      ],
    });
    await settle();

    expect(getDocs().map((doc) => doc._id)).toEqual(["task-1"]);
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
      ([path]) => path === "_system:pendingPush",
    );

    expect(pendingPushCalls).toHaveLength(1);
    expect(m.pendingCount()).toBe(1);
  });

  it.skip("mutation() rejects when pending storage degrades to ephemeral queueing", async () => {
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

    expect(embedded.ingestDocuments).toHaveBeenCalledWith(
      "tasks",
      [
        {
          _id: "remote-task-1",
          _creationTime: 1,
          title: "Remote task",
          body: "from remote",
        },
      ],
      undefined,
      undefined,
    );
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

    expect(embedded.ingestDocuments).toHaveBeenCalledWith(
      "tasks",
      [
        {
          _id: "remote-task-1",
          _creationTime: 1,
          title: "Remote task",
          body: "from remote",
        },
      ],
      undefined,
      undefined,
    );
  });

  it("resolveNow() preserves local doc shape when resolve returns no diff", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();
    const proseSchema = define({
      shape: {
        title: registerField(v.string()),
        body: prose(),
      },
    });
    const localDoc = {
      _id: "task-1",
      _creationTime: 1,
      title: "Local task",
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Hello world" }],
          },
        ],
      },
    };
    embedded.getDocumentsForTable.mockResolvedValue([localDoc]);
    remoteClient.query.mockResolvedValue({
      mode: "incremental",
      collectionSeq: 1,
      protocolVersion: 1,
      documents: [{ docId: "task-1", seq: 1 }],
    });

    const m = createEngine({
      embedded,
      remoteClient,
      tables: {
        tasks: tableConfig("resolve_ref", "tasks_list", proseSchema),
      },
    });

    await m.resolveNow();

    expect(embedded.ingestDocuments).toHaveBeenCalledWith(
      "tasks",
      [localDoc],
      undefined,
      undefined,
    );
  });

  it("resolveNow() replaces local table state when the server falls back to full mode", async () => {
    const { embedded, getDocs } = createStatefulEmbedded([
      {
        _id: "stale-local",
        _creationTime: 1,
        title: "stale",
        body: "remove me",
      },
      {
        _id: "keep-remote",
        _creationTime: 2,
        title: "old title",
        body: "outdated",
      },
    ]);
    const remoteClient = createMockRemoteClient();
    remoteClient.query.mockResolvedValue({
      mode: "full",
      collectionSeq: 8,
      protocolVersion: 1,
      documents: [
        {
          docId: "keep-remote",
          seq: 8,
          document: {
            _id: "keep-remote",
            _creationTime: 2,
            title: "fresh title",
            body: "updated",
          },
        },
      ],
    });

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    await m.resolveNow();

    expect(getDocs()).toEqual([
      {
        _id: "keep-remote",
        _creationTime: 2,
        title: "fresh title",
        body: "updated",
      },
    ]);
  });

  it("resolveNow() streams paged full-mode results and prunes stale local docs", async () => {
    const { embedded, getDocs } = createStatefulEmbedded([
      {
        _id: "stale-local",
        _creationTime: 1,
        title: "stale",
        body: "remove me",
      },
    ]);
    const remoteClient = createMockRemoteClient();
    remoteClient.query
      .mockResolvedValueOnce({
        mode: "full",
        collectionSeq: 8,
        protocolVersion: 1,
        documents: [
          {
            docId: "page-1",
            seq: 1,
            document: {
              _id: "page-1",
              _creationTime: 11,
              title: "Page one",
              body: "first",
            },
          },
        ],
        continueCursor: "cursor-1",
        isDone: false,
      })
      .mockResolvedValueOnce({
        mode: "full",
        collectionSeq: 8,
        protocolVersion: 1,
        documents: [
          {
            docId: "page-2",
            seq: 2,
            document: {
              _id: "page-2",
              _creationTime: 12,
              title: "Page two",
              body: "second",
            },
          },
        ],
        continueCursor: null,
        isDone: true,
      });

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    await m.resolveNow();

    expect(remoteClient.query).toHaveBeenNthCalledWith(
      1,
      "resolve_ref",
      expect.objectContaining({
        collectionSeq: null,
        documents: [
          expect.objectContaining({
            docId: "stale-local",
            lastSeq: null,
            vector: expect.any(ArrayBuffer),
          }),
        ],
      }),
    );
    expect(remoteClient.query).toHaveBeenNthCalledWith(
      2,
      "resolve_ref",
      expect.objectContaining({
        collectionSeq: null,
        fullCursor: "cursor-1",
        documents: [expect.objectContaining({ docId: "stale-local" })],
      }),
    );
    // Streaming: one append-only ingest per page, then a final prune pass.
    const pageIngests = embedded.ingestDocuments.mock.calls.filter(
      (call) =>
        (call[3] as { deleteAbsent?: boolean } | undefined)?.deleteAbsent ===
        false,
    );
    expect(pageIngests).toHaveLength(2);
    const pruneIngests = embedded.ingestDocuments.mock.calls.filter(
      (call) =>
        (call[3] as { keepIds?: ReadonlySet<string> } | undefined)?.keepIds !==
        undefined,
    );
    expect(pruneIngests).toHaveLength(1);
    expect(getDocs()).toEqual([
      {
        _id: "page-1",
        _creationTime: 11,
        title: "Page one",
        body: "first",
      },
      {
        _id: "page-2",
        _creationTime: 12,
        title: "Page two",
        body: "second",
      },
    ]);
  });

  it("reloadIdentity() rehydrates scoped state before resolving", async () => {
    let activeIdentityKey: string | null = "user:a";
    let pendingEntries: Array<Record<string, unknown>> = [];
    const localClient: MockSystemClient = {
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
              const entries =
                args?.identityKey === "user:b"
                  ? [
                      {
                        _id: "pending-b",
                        ref: "tasks:create",
                        args: JSON.stringify({ id: "local-b" }),
                        localResult: JSON.stringify({ _id: "local-b" }),
                        table: "tasks",
                        identityKey: "user:b",
                      },
                    ]
                  : [];
              pendingEntries = entries;
              return Promise.resolve(entries);
            }

            return Promise.resolve(null);
          },
        ),
      mutation: vi.fn().mockImplementation((path: string, args: Args) => {
        if (path === "_system:pendingClaimNext") {
          const entry = pendingEntries.find(
            (current) =>
              (current.identityKey ?? null) === (args.identityKey ?? null) &&
              (((current.state as string | undefined) ?? "pending") ===
                "pending" ||
                (((current.state as string | undefined) ?? "pending") ===
                  "processing" &&
                  typeof current.leaseExpiresAt === "number" &&
                  (current.leaseExpiresAt as number) <= Date.now())),
          );
          if (!entry) {
            return Promise.resolve(null);
          }
          entry.state = "processing";
          entry.owner = args.owner;
          entry.processingStartedAt = Date.now();
          entry.leaseExpiresAt =
            Date.now() + ((args.leaseMs as number) ?? 30_000);
          return Promise.resolve({ ...entry });
        }
        if (path === "_system:pendingRenewLease") {
          const entry = pendingEntries.find(
            (current) => current._id === args.id,
          );
          if (entry && entry.owner === args.owner) {
            entry.leaseExpiresAt =
              Date.now() + ((args.leaseMs as number) ?? 30_000);
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
          const entry = pendingEntries.find(
            (current) => current._id === args.id,
          );
          if (entry) {
            entry.state = "pending";
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

    const embedded: MockEmbedded = {
      client: asConvexClient(localClient),
      ingestDocuments: vi.fn(async () => undefined),
      canonicalizeMappedCreate: vi.fn(async () => undefined),
      getDocumentsForTable: vi.fn(async () => []),
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
    await m.resolveNow();

    expect(embedded.getDocumentsForTable).toHaveBeenCalledWith("tasks");

    m.stop();
  });

  it("resolve sends state vectors for local docs to remote query", async () => {
    const { embedded } = createMockEmbedded();
    embedded.getDocumentsForTable.mockResolvedValue([
      { _id: "doc-1", _creationTime: 100, title: "Hello", body: "World" },
    ]);

    const remoteClient = createMockRemoteClient();
    remoteClient.query.mockResolvedValue([{ docId: "doc-1" }]);

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    m.start();
    await settle();
    await m.resolveNow();

    expect(remoteClient.query).toHaveBeenCalledTimes(1);
    const resolveArgs = remoteClient.query.mock.calls[0]![1] as {
      documents: Array<{ docId: string; vector: unknown }>;
    };
    expect(resolveArgs.documents).toHaveLength(1);
    expect(resolveArgs.documents[0]!.docId).toBe("doc-1");
    expect(resolveArgs.documents[0]!.vector).toBeInstanceOf(ArrayBuffer);

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
    remoteClient.query.mockResolvedValue([{ docId: "doc-1" }]);

    const m = createEngine({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    m.start();
    await settle();
    await m.resolveNow();

    expect(embedded.ingestDocuments).toHaveBeenCalledWith(
      "tasks",
      expect.arrayContaining([
        expect.objectContaining({ _id: "doc-1", _creationTime: 100 }),
      ]),
      undefined,
      undefined,
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
    const onUpdateCallback = getSnapshotHandler(remoteClient);

    // Simulate a remote resolve-endpoint update. The subscription target is
    // the resolve query; the handler receives ResolveResponse-shaped data
    // and unwraps the `document` fields before ingesting.
    onUpdateCallback({
      mode: "full",
      collectionSeq: 1,
      protocolVersion: 1,
      documents: [
        {
          docId: "doc-1",
          seq: 1,
          document: {
            _id: "doc-1",
            _creationTime: 100,
            title: "Task",
            body: "Body",
            secretField: "should-be-stripped",
            internalData: { nested: true },
          },
        },
      ],
    });

    // ingestDocuments should have been called with the omitted fields removed.
    await vi.waitFor(() =>
      expect(embedded.ingestDocuments).toHaveBeenCalledWith(
        "tasks",
        [
          expect.objectContaining({
            _id: "doc-1",
            _creationTime: 100,
            title: "Task",
            body: "Body",
          }),
        ],
        undefined,
        undefined,
      ),
    );

    // Verify the omitted fields are NOT present.
    const ingestCall = embedded.ingestDocuments.mock.calls.find(
      (call) => call[0] === "tasks",
    );
    expect(ingestCall).toBeDefined();
    const ingestedDoc = (ingestCall![1] as Doc[])[0];
    expect(ingestedDoc).not.toHaveProperty("secretField");
    expect(ingestedDoc).not.toHaveProperty("internalData");

    m.stop();
  });

  it("buffers child-table snapshots until parent-table docs are available locally", async () => {
    await withFakeTimers(async () => {
      const docsByTable = new Map<string, Array<Record<string, unknown>>>([
        ["projects", []],
        ["issues", []],
      ]);
      const localClient = createMockLocalClient();
      const ingestOrder: Array<string> = [];
      const embedded: MockEmbedded = {
        client: asConvexClient(localClient),
        ingestDocuments: vi.fn(async (table: string, docs: Doc[]) => {
          ingestOrder.push(table);
          docsByTable.set(table, [...docs]);
        }),
        canonicalizeMappedCreate: vi.fn(async () => undefined),
        getDocumentsForTable: vi.fn(async (table: string) => {
          return [...(docsByTable.get(table) ?? [])];
        }),
        hasLocalDocumentId: vi.fn((id: string) =>
          [...docsByTable.values()].some((docs) =>
            docs.some((doc) => doc._id === id),
          ),
        ),
      };

      const projectSchema = createMockSchema({
        shape: { name: "string" },
        getShape: () => ({ name: "string" }),
      });
      const issueSchema = createMockSchema({
        shape: {
          projectId: { kind: "id", tableName: "projects" },
          title: "string",
        },
        getShape: () => ({
          projectId: { kind: "id", tableName: "projects" },
          title: "string",
        }),
      });

      const updateHandlers = new Map<string, SnapshotHandler>();
      const remoteClient: MockRemoteClient = {
        ...createMockRemoteClient(),
        onUpdate: vi.fn(
          (query: string, _args: unknown, onUpdate: SnapshotHandler) => {
            updateHandlers.set(query, onUpdate);
            return vi.fn();
          },
        ),
      };

      const m = createEngine({
        embedded,
        remoteClient,
        tables: {
          projects: tableConfig(
            "projects:bind",
            "projects:list",
            projectSchema,
          ),
          issues: tableConfig("issues:bind", "issues:list", issueSchema),
        },
      });

      m.start();
      await vi.advanceTimersByTimeAsync(1);

      updateHandlers.get("issues:bind")?.({
        mode: "full",
        collectionSeq: 1,
        protocolVersion: 1,
        documents: [
          {
            docId: "issue-1",
            seq: 1,
            document: {
              _id: "issue-1",
              _creationTime: 2,
              projectId: "project-1",
              title: "Issue",
            },
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(1);

      expect(embedded.ingestDocuments).not.toHaveBeenCalledWith(
        "issues",
        expect.anything(),
      );

      updateHandlers.get("projects:bind")?.({
        mode: "full",
        collectionSeq: 1,
        protocolVersion: 1,
        documents: [
          {
            docId: "project-1",
            seq: 1,
            document: {
              _id: "project-1",
              _creationTime: 1,
              name: "Project",
            },
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(50);

      expect(ingestOrder).toEqual(["projects"]);
      expect(docsByTable.get("issues") ?? []).toEqual([]);
      m.stop();
    });
  });

  it("stops retrying buffered snapshot ingests after the retry budget is exhausted", async () => {
    await withFakeTimers(async () => {
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
      await vi.advanceTimersByTimeAsync(1);

      expect(remoteClient.onUpdate).toHaveBeenCalledTimes(1);
      const onUpdateCallback = remoteClient.onUpdate.mock.calls[0]![2];
      onUpdateCallback({
        mode: "full",
        collectionSeq: 1,
        protocolVersion: 1,
        documents: [
          {
            docId: "doc-1",
            seq: 1,
            document: {
              _id: "doc-1",
              _creationTime: 1,
              title: "Task",
              body: "Body",
            },
          },
        ],
      });

      for (let index = 0; index < 12; index += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      const callCountAfterRetries = embedded.ingestDocuments.mock.calls.length;

      await vi.advanceTimersByTimeAsync(30_000);

      expect(callCountAfterRetries).toBeGreaterThan(1);
      expect(embedded.ingestDocuments).toHaveBeenCalledTimes(
        callCountAfterRetries,
      );
      m.stop();
    });
  });

  // -------------------------------------------------------------------------
  // processQueue()
  // -------------------------------------------------------------------------

  describe("processQueue()", () => {
    it("forwards a queued mutation to remoteClient.mutation", async () => {
      const { embedded, localClient } = createMockEmbedded();
      layerMutationMock(localClient, (path) => {
        if (path === "tasks:create") return Promise.resolve({ _id: "local-1" });
        return undefined;
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

    it("returns the local id immediately and records local→remote mapping in the background", async () => {
      const { embedded, localClient } = createMockEmbedded();
      layerMutationMock(localClient, (path) => {
        if (path === "tasks:create") return Promise.resolve("local-uuid-1");
        return undefined;
      });
      embedded.hasLocalDocumentId = vi.fn(() => false);

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
      await settle();

      expect(result).toBe("local-uuid-1");
      expect(localClient.mutation).toHaveBeenCalledWith(
        "_system:idMapSet",
        expect.objectContaining({ localId: "local-uuid-1" }),
      );
      expect(m.idMap.getRemoteId("local-uuid-1")).toBe("remote-id-99");
      m.stop();
    });

    it("deletes stale mappings only when a hydrated mapped create already exists under the remote id", async () => {
      let pendingEntries: Array<Record<string, unknown>> = [
        {
          _id: "pending-doc-1",
          ref: "tasks:create",
          args: JSON.stringify({ title: "Test" }),
          localResult: JSON.stringify("local-uuid-1"),
          table: "tasks",
          payloadVersion: 1,
          hydrated: true,
          identityKey: null,
        },
      ];
      let idMappings: Array<{
        localId: string;
        remoteId: string;
        table: string;
      }> = [
        {
          localId: "local-uuid-1",
          remoteId: "remote-id-99",
          table: "tasks",
        },
      ];

      const localClient: MockSystemClient = {
        query: vi.fn().mockImplementation((path: string) => {
          if (path === "_system:idMapGetAll") {
            return Promise.resolve([...idMappings]);
          }
          if (path === "_system:pendingGetAll") {
            return Promise.resolve([...pendingEntries]);
          }
          return Promise.resolve(null);
        }),
        mutation: vi.fn().mockImplementation((path: string, args: Args) => {
          if (path === "_system:pendingClaimNext") {
            const entry = pendingEntries[0];
            if (!entry) {
              return Promise.resolve(null);
            }
            entry.state = "processing";
            entry.owner = args.owner;
            entry.leaseExpiresAt =
              Date.now() + ((args.leaseMs as number) ?? 30_000);
            return Promise.resolve({ ...entry });
          }
          if (path === "_system:pendingRemove") {
            pendingEntries = pendingEntries.filter(
              (entry) => entry._id !== args.id,
            );
            return Promise.resolve(null);
          }
          if (path === "_system:idMapDelete") {
            idMappings = idMappings.filter(
              (entry) => entry.localId !== args.localId,
            );
            return Promise.resolve(null);
          }
          return Promise.resolve(null);
        }),
      };

      const embedded: MockEmbedded = {
        client: asConvexClient(localClient),
        ingestDocuments: vi.fn(async () => undefined),
        canonicalizeMappedCreate: vi.fn(async () => undefined),
        getDocumentsForTable: vi.fn(async () => []),
        hasLocalDocumentId: vi.fn((id: string) => id === "remote-id-99"),
      };

      const remoteClient = createMockRemoteClient();

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      m.start();
      await settle();
      await settle();

      expect(localClient.mutation).toHaveBeenCalledWith(
        "_system:idMapDelete",
        expect.objectContaining({ localId: "local-uuid-1" }),
      );
      expect(remoteClient.mutation).not.toHaveBeenCalled();
      expect(m.idMap.getRemoteId("local-uuid-1")).toBeNull();
      expect(pendingEntries).toHaveLength(0);
      m.stop();
    });

    it("replays a hydrated mapped create when the local alias document still exists", async () => {
      let pendingEntries: Array<Record<string, unknown>> = [];
      let idMappings: Array<{
        localId: string;
        remoteId: string;
        table: string;
      }> = [];
      let nextPendingId = 1;

      const localClient: MockSystemClient = {
        query: vi.fn().mockImplementation((path: string) => {
          if (path === "_system:idMapGetAll") {
            return Promise.resolve([...idMappings]);
          }
          if (path === "_system:pendingGetAll") {
            return Promise.resolve([...pendingEntries]);
          }
          return Promise.resolve(null);
        }),
        mutation: vi.fn().mockImplementation((path: string, args: Args) => {
          if (path === "comments:create") {
            return Promise.resolve("local-comment-1");
          }
          if (path === "_system:pendingPush") {
            const entry = {
              _id: `pending-doc-${nextPendingId++}`,
              ...args,
            };
            pendingEntries.push(entry);
            return Promise.resolve(entry._id);
          }
          if (path === "_system:pendingGetAll") {
            return Promise.resolve([...pendingEntries]);
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
            entry.leaseExpiresAt =
              Date.now() + ((args.leaseMs as number) ?? 30_000);
            return Promise.resolve({ ...entry });
          }
          if (path === "_system:pendingRemove") {
            pendingEntries = pendingEntries.filter(
              (entry) => entry._id !== args.id,
            );
            return Promise.resolve(null);
          }
          if (path === "_system:pendingRenewLease") {
            const entry = pendingEntries.find(
              (current) => current._id === args.id,
            );
            if (entry && entry.owner === args.owner) {
              entry.leaseExpiresAt =
                Date.now() + ((args.leaseMs as number) ?? 30_000);
              return Promise.resolve(true);
            }
            return Promise.resolve(false);
          }
          if (path === "_system:idMapSet") {
            idMappings = idMappings
              .filter((entry) => entry.localId !== args.localId)
              .concat({
                localId: args.localId as string,
                remoteId: args.remoteId as string,
                table: args.table as string,
              });
            return Promise.resolve(null);
          }
          if (path === "_system:idMapDelete") {
            idMappings = idMappings.filter(
              (entry) => entry.localId !== args.localId,
            );
            return Promise.resolve(null);
          }
          return Promise.resolve(null);
        }),
      };

      const offlineConnectivity = { isOnline: () => false };
      const onlineConnectivity = { isOnline: () => true };
      const embedded: MockEmbedded = {
        client: asConvexClient(localClient),
        ingestDocuments: vi.fn(async () => undefined),
        canonicalizeMappedCreate: vi.fn(async () => undefined),
        getDocumentsForTable: vi.fn(async () => []),
        hasLocalDocumentId: vi.fn((id: string) => id === "local-comment-1"),
      };

      const remoteClient = createMockRemoteClient();
      remoteClient.mutation.mockResolvedValue("remote-comment-1");

      const firstEngine = createEngine({
        embedded,
        remoteClient,
        connectivity: offlineConnectivity,
        tables: { comments: tableConfig("resolve_ref") },
      });

      firstEngine.start();
      await settle();
      await firstEngine.mutation("comments:create", {
        body: "Hello",
        issueId: "issue-1",
      });
      await firstEngine.idMap.set(
        "local-comment-1",
        "remote-comment-1",
        "comments",
      );
      firstEngine.stop();

      expect(pendingEntries).toHaveLength(1);
      expect(idMappings).toEqual([
        {
          localId: "local-comment-1",
          remoteId: "remote-comment-1",
          table: "comments",
        },
      ]);

      const secondEngine = createEngine({
        embedded,
        remoteClient,
        connectivity: onlineConnectivity,
        tables: { comments: tableConfig("resolve_ref") },
      });

      secondEngine.start();
      await settle();
      await settle();

      expect(remoteClient.mutation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ body: "Hello", issueId: "issue-1" }),
      );

      secondEngine.stop();
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
      embedded.canonicalizeMappedCreate.mockImplementation(
        async (input: {
          localId: string;
          remoteId: string;
          tableName: string;
          schemas: Record<string, Definition>;
        }) => {
          const canonical = canonicalizeMappedCreateTable({
            docs,
            schema: input.schemas[input.tableName]!,
            localId: input.localId,
            remoteId: input.remoteId,
            rewriteOwnId: true,
            tableName: input.tableName,
          });
          docs = canonical.documents;
        },
      );

      const baseMutation = localClient.mutation.getMockImplementation();
      localClient.mutation.mockImplementation((path: string, args: Args) => {
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

    it("keeps the mapped create pending until runtime canonicalization finishes", async () => {
      const { embedded, localClient } = createMockEmbedded();
      layerMutationMock(localClient, (path) => {
        if (path === "tasks:create") return Promise.resolve("local-uuid-1");
        return undefined;
      });

      const remapReady = deferredPromise<void>();
      const releaseRemap = deferredPromise<void>();
      embedded.canonicalizeMappedCreate.mockImplementation(async () => {
        remapReady.resolve();
        await releaseRemap.promise;
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

      const mutationPromise = m.mutation("tasks:create", { title: "Test" });
      await remapReady.promise;

      expect(localClient.mutation).not.toHaveBeenCalledWith(
        "_system:pendingRemove",
        expect.anything(),
      );

      await expect(mutationPromise).resolves.toBe("local-uuid-1");

      releaseRemap.resolve();
      await settle();

      expect(localClient.mutation).toHaveBeenCalledWith(
        "_system:pendingRemove",
        expect.objectContaining({
          id: "pending-doc-1",
        }),
      );
      m.stop();
    });

    it("does not publish the local→remote id mapping until canonicalization finishes", async () => {
      const { embedded, localClient } = createMockEmbedded();
      layerMutationMock(localClient, (path) => {
        if (path === "tasks:create") return Promise.resolve("local-uuid-1");
        return undefined;
      });

      const remapReady = deferredPromise<void>();
      const releaseRemap = deferredPromise<void>();
      embedded.canonicalizeMappedCreate.mockImplementation(async () => {
        remapReady.resolve();
        await releaseRemap.promise;
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

      const mutationPromise = m.mutation("tasks:create", { title: "Test" });
      await remapReady.promise;

      expect(m.idMap.getRemoteId("local-uuid-1")).toBeNull();
      expect(localClient.mutation).not.toHaveBeenCalledWith(
        "_system:idMapSet",
        expect.anything(),
      );

      await expect(mutationPromise).resolves.toBe("local-uuid-1");

      releaseRemap.resolve();
      await settle();

      expect(localClient.mutation).toHaveBeenCalledWith(
        "_system:idMapSet",
        expect.objectContaining({
          localId: "local-uuid-1",
          remoteId: "remote-id-99",
        }),
      );
      m.stop();
    });

    it("dequeues entries after successful remote push", async () => {
      const { embedded, localClient } = createMockEmbedded();
      layerMutationMock(localClient, (path) => {
        if (path === "tasks:create") return Promise.resolve({ _id: "local-1" });
        return undefined;
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
      layerMutationMock(localClient, (path) => {
        if (path === "tasks:create") {
          pendingId += 1;
          return Promise.resolve(`local-uuid-${pendingId}`);
        }
        return undefined;
      });
      embedded.hasLocalDocumentId = vi.fn(() => false);

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
      localClient.mutation.mockImplementation((path: string, args: Args) => {
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
            leaseExpiresAt: Date.now() + ((args.leaseMs as number) ?? 30_000),
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
      await withFakeTimers(async () => {
        const { embedded, localClient } = createMockEmbedded();
        layerMutationMock(localClient, (path) => {
          if (path === "_system:pendingRenewLease") {
            return Promise.resolve(true);
          }
          if (path === "tasks:create") {
            return Promise.resolve("local-uuid-1");
          }
          return undefined;
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
          (call) => call[0] === "_system:pendingRenewLease",
        );
        expect(renewCalls.length).toBeGreaterThanOrEqual(2);
        m.stop();
      });
    });

    it("drops a hydrated create entry only when the canonical remote doc is already present", async () => {
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
      embedded.hasLocalDocumentId = vi.fn(
        (id: string) => id === "remote-id-99",
      );
      {
        let pendingClaimed = false;
        localClient.mutation.mockImplementation((path: string, args: Args) => {
          if (path === "_system:pendingClaimNext" && !pendingClaimed) {
            pendingClaimed = true;
            return Promise.resolve({
              _id: "pending-doc-1",
              ref: "tasks:create",
              args: JSON.stringify({ title: "Buy milk" }),
              localResult: JSON.stringify("local-uuid-1"),
              table: "tasks",
              hydrated: true,
              state: "processing",
              owner: args.owner,
              leaseExpiresAt: Date.now() + ((args.leaseMs as number) ?? 30_000),
              identityKey: null,
            });
          }
          if (path === "_system:pendingClaimNext") {
            return Promise.resolve(null);
          }
          return Promise.resolve(null);
        });
      }

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
      expect(localClient.mutation).toHaveBeenCalledWith(
        "_system:idMapDelete",
        expect.objectContaining({ localId: "local-uuid-1" }),
      );

      m.stop();
    });

    it("retains entry in queue on remote push failure", async () => {
      const { embedded, localClient } = createMockEmbedded();
      layerMutationMock(localClient, (path) => {
        if (path === "tasks:create") return Promise.resolve({ _id: "local-1" });
        return undefined;
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
      layerMutationMock(localClient, (path) => {
        if (path === "tasks:create") return Promise.resolve({ _id: "local-1" });
        return undefined;
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
      layerMutationMock(localClient, (path) => {
        if (path === "tasks:create") return Promise.resolve({ _id: "local-1" });
        return undefined;
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

    it("drops offline create/delete pairs before replay reaches remote", async () => {
      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: false },
        writable: true,
        configurable: true,
      });

      const { embedded } = createStatefulEmbedded([]);
      const remoteClient = createMockRemoteClient();

      const m = createEngine({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      m.start();
      await settle();

      const createdId = (await m.mutation("tasks:create", {
        title: "Ephemeral",
      })) as string;
      await m.mutation("tasks:remove", { id: createdId });
      await settle();

      expect(m.pendingCount()).toBe(0);
      expect(remoteClient.mutation).not.toHaveBeenCalled();

      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: true },
        writable: true,
        configurable: true,
      });
      getRegisteredHandler("online")();
      await settle(200);

      expect(remoteClient.mutation).not.toHaveBeenCalled();
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
      remoteClient.mutation.mockImplementation((ref: unknown, args: Args) => {
        const name = refName(ref);
        if (name === "files:generateUploadUrl") {
          return Promise.resolve("https://uploads.example/upload");
        }
        return Promise.resolve({ ...args, _id: "remote-doc-1" });
      });

      globalThis.fetch = vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify({ storageId: "remote-storage-1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );

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

      const [uploadUrl, uploadRequest] = vi.mocked(globalThis.fetch).mock
        .calls[0]!;
      if (typeof uploadUrl === "string") {
        expect(uploadUrl).toBe("https://uploads.example/upload");
      } else if (uploadUrl instanceof URL) {
        expect(uploadUrl.href).toBe("https://uploads.example/upload");
      } else {
        expect(uploadUrl.url).toBe("https://uploads.example/upload");
      }
      expect(uploadRequest).toMatchObject({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "text/plain",
        }),
      });
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
      localClient.mutation.mockImplementation((path: string, args: Args) => {
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
      remoteClient.mutation.mockImplementation((ref: unknown, args: Args) => {
        const name = refName(ref);
        if (name === "files:generateUploadUrl") {
          return Promise.resolve("https://uploads.example/upload");
        }
        return Promise.resolve({ ...args, _id: "remote-doc-2" });
      });

      globalThis.fetch = vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify({ storageId: "remote-storage-1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );

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
        expect.objectContaining({ attachmentId: "remote-storage-1" }),
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
      const remoteClientA: MockRemoteClient = {
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
        const remoteClientA: MockRemoteClient = {
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
      const remoteClient: MockRemoteClient = {
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

      const onUpdateCallsAfterStart = remoteClient.onUpdate.mock.calls.length;

      const offlineHandler = getRegisteredHandler("offline");
      offlineHandler();
      await settle();

      const onlineHandler = getRegisteredHandler("online");
      onlineHandler();
      onlineHandler();
      await settle();

      expect(remoteClient.query).toHaveBeenCalledTimes(1);

      resolveQuery([]);
      await settle(100);

      expect(remoteClient.onUpdate).toHaveBeenCalledTimes(
        onUpdateCallsAfterStart + 1,
      );
      m.stop();
    });

    it("does not start remote subscriptions while queued mutations remain pending", async () => {
      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: false },
        writable: true,
        configurable: true,
      });

      const { embedded, localClient } = createMockEmbedded();
      layerMutationMock(localClient, (path) => {
        if (path === "tasks:create") return Promise.resolve({ _id: "local-1" });
        return undefined;
      });

      const remoteClient: MockRemoteClient = {
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
      const { embedded } = createMockEmbedded();
      const remoteClient: MockRemoteClient = {
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

      const onUpdateCallsAfterStart = remoteClient.onUpdate.mock.calls.length;

      Object.defineProperty(globalThis, "navigator", {
        value: { onLine: false },
        writable: true,
        configurable: true,
      });
      getRegisteredHandler("offline")();
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
      expect(remoteClient.onUpdate).toHaveBeenCalledTimes(
        onUpdateCallsAfterStart + 1,
      );

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
      layerMutationMock(localClient, (path) => {
        if (path === "tasks:create")
          return Promise.resolve({ _id: `local-${Date.now()}` });
        return undefined;
      });

      const remoteClient: MockRemoteClient = {
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
      const remoteClient: MockRemoteClient = {
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
