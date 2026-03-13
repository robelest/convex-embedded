import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vite-plus/test";

import { engine } from "#resolve/client/engine";
import type { Definition } from "#resolve/server/schema";

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
    history: {},
    defaults: {},
    getShape: () => ({ title: "string", body: "string" }),
    getCrdtFields: () => new Map(),
    getOmittedFields: () => [],
    ...overrides,
  } as Definition;
}

function createMockLocalClient() {
  return {
    query: vi.fn().mockImplementation((path: string) => {
      const routes: Record<string, unknown> = {
        "_system:idMapGetAll": [],
        "_system:pendingGetAll": [],
      };
      return Promise.resolve(routes[path] ?? null);
    }),
    mutation: vi.fn().mockImplementation((path: string) => {
      const routes: Record<string, unknown> = {
        "_system:pendingPush": "pending-doc-1",
      };
      return Promise.resolve(routes[path] ?? null);
    }),
  };
}

function createMockEmbedded() {
  const localClient = createMockLocalClient();
  return {
    embedded: {
      client: localClient,
      ingestDocuments: vi.fn().mockResolvedValue(undefined),
      getDocumentsForTable: vi.fn().mockResolvedValue([]),
    },
    localClient, // keep reference for assertions
  };
}

function createMockRemoteClient() {
  return {
    query: vi.fn().mockResolvedValue([]),
    mutation: vi.fn().mockResolvedValue(null),
    onUpdate: vi.fn().mockReturnValue(vi.fn()), // returns unsubscribe fn
  };
}

function settle(ms = 50) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Shorthand for a table config with both resolve and query refs. */
function tableConfig(
  resolve: string,
  query: string = `${resolve.split(".")[0]}_list`,
  schema: Definition = createMockSchema(),
) {
  return { resolve, query, schema };
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

  beforeEach(() => {
    originalAddEventListener = globalThis.addEventListener;
    originalRemoveEventListener = globalThis.removeEventListener;
    originalNavigator = globalThis.navigator;

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
  });

  // -------------------------------------------------------------------------
  // Basic structure
  // -------------------------------------------------------------------------

  it("returns a MonitorInstance with expected methods", () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = engine.create({
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

    const m = engine.create({
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

    const m = engine.create({
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
    expect(localClient.query).toHaveBeenCalledWith("_system:idMapGetAll", {});
    expect(localClient.query).toHaveBeenCalledWith("_system:pendingGetAll", {});

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

    const m = engine.create({
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

    const m = engine.create({
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

  it("stop() cleans up and sets status to idle", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = engine.create({
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

    const m = engine.create({
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

    const m = engine.create({
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
    const remoteClient = {
      query: vi.fn().mockRejectedValue(new Error("network error")),
      mutation: vi.fn().mockResolvedValue(null),
      onUpdate: vi.fn().mockReturnValue(vi.fn()),
    };

    const m = engine.create({
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

    const m = engine.create({
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
    const remoteClient = {
      ...createMockRemoteClient(),
      onUpdate: vi.fn().mockReturnValue(unsubscribe),
    };

    const m = engine.create({
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

    const m = engine.create({
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

    const m = engine.create({
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

    const m = engine.create({
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

    const m = engine.create({
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

    const m = engine.create({
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

    const m = engine.create({
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

  // -------------------------------------------------------------------------
  // resolveNow
  // -------------------------------------------------------------------------

  it("resolveNow() triggers a resolve cycle", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = engine.create({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("resolve_ref") },
    });

    await m.resolveNow();

    expect(remoteClient.query).toHaveBeenCalledTimes(1);
    expect(m.getStatus()).toEqual({ status: "resolved" });
  });

  // -------------------------------------------------------------------------
  // pendingCount
  // -------------------------------------------------------------------------

  it("pendingCount() reflects queue size", async () => {
    const { embedded } = createMockEmbedded();
    const remoteClient = createMockRemoteClient();

    const m = engine.create({
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

    const m = engine.create({
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

    const m = engine.create({
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

    const m = engine.create({
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

    const m = engine.create({
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

      const m = engine.create({
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

      const m = engine.create({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      m.start();
      await settle();

      await m.mutation("tasks:create", { title: "Test" });
      await settle(100);

      expect(m.idMap.getRemoteId("local-uuid-1")).toBe("remote-id-99");
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

      const m = engine.create({
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

      const m = engine.create({
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

      const m = engine.create({
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
      const addCalls = (globalThis.addEventListener as ReturnType<typeof vi.fn>)
        .mock.calls;
      const onlineEntry = addCalls.find(
        (call: unknown[]) => call[0] === "online",
      );
      expect(onlineEntry).toBeDefined();
      const onlineHandler = onlineEntry![1] as () => void;

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

    it("emits offline status on offline event", async () => {
      const { embedded } = createMockEmbedded();
      const remoteClient = createMockRemoteClient();

      const m = engine.create({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref") },
      });

      const statuses: string[] = [];
      m.on("change", (s) => statuses.push(s.status));

      m.start();
      await settle();

      // Find the registered "offline" handler
      const addCalls = (globalThis.addEventListener as ReturnType<typeof vi.fn>)
        .mock.calls;
      const offlineEntry = addCalls.find(
        (call: unknown[]) => call[0] === "offline",
      );
      expect(offlineEntry).toBeDefined();
      const offlineHandler = offlineEntry![1] as () => void;

      offlineHandler();
      await settle();

      expect(statuses).toContain("offline");
      m.stop();
    });

    it("stops remote subscriptions on offline event", async () => {
      const unsubscribe = vi.fn();
      const { embedded } = createMockEmbedded();
      const remoteClient = {
        ...createMockRemoteClient(),
        onUpdate: vi.fn().mockReturnValue(unsubscribe),
      };

      const m = engine.create({
        embedded,
        remoteClient,
        tables: { tasks: tableConfig("resolve_ref", "tasks_list") },
      });

      m.start();
      await settle();

      // Subscriptions should be active
      expect(remoteClient.onUpdate).toHaveBeenCalledTimes(1);

      // Find the registered "offline" handler
      const addCalls = (globalThis.addEventListener as ReturnType<typeof vi.fn>)
        .mock.calls;
      const offlineEntry = addCalls.find(
        (call: unknown[]) => call[0] === "offline",
      );
      expect(offlineEntry).toBeDefined();
      const offlineHandler = offlineEntry![1] as () => void;

      offlineHandler();
      await settle();

      expect(unsubscribe).toHaveBeenCalled();
      m.stop();
    });
  });
});
