import { BrowserWriteBroadcast } from "@embedded/browser/write";
import { EmbeddedRuntime } from "@embedded/runtime/embedded";
import type { Definition } from "@embedded/shared/schema";
import { createTestIdentity } from "@embedded/test";
import { mockAdapter } from "@tests/helpers/adapter";
import { describe, it, expect, beforeEach, afterEach } from "@tests/testkit";
import { makeFunctionReference } from "convex/server";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock BroadcastChannel (copied from browser/write.test.ts)
// ---------------------------------------------------------------------------

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];

  onmessage: ((ev: MessageEvent) => void) | null = null;
  name: string;
  private _closed = false;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: any): void {
    this._closed ||
      MockBroadcastChannel.instances
        .filter(
          (inst) =>
            inst !== this &&
            inst.name === this.name &&
            !inst._closed &&
            inst.onmessage,
        )
        .forEach((inst) =>
          inst.onmessage!(new MessageEvent("message", { data })),
        );
  }

  close(): void {
    this._closed = true;
  }

  static reset(): void {
    MockBroadcastChannel.instances = [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal modules record that satisfies the ModuleLoader requirement for
 * a `_generated` directory entry.
 */
const STUB_MODULES: Record<string, () => Promise<any>> = {
  "_generated/api": () => Promise.resolve({}),
};

function createMockSchema(overrides?: Partial<Definition>): Definition {
  return {
    version: 1,
    shape: { title: "string" },
    defaults: {},
    getShape: () => ({ title: "string" }),
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

function createSqlStorage(
  rowsByTable: Record<string, Array<Record<string, unknown>>>,
) {
  const getDocumentsByTable = vi.fn(async (tableName: string) => [
    ...(rowsByTable[tableName] ?? []),
  ]);
  const getDocument = vi.fn(async (tableName: string, id: string) => {
    return (
      rowsByTable[tableName]?.find((row) => String(row._id) === id) ?? null
    );
  });
  const listDocuments = vi.fn(async (tableName: string) => [
    ...(rowsByTable[tableName] ?? []),
  ]);
  const countDocuments = vi.fn(
    async (tableName: string) => rowsByTable[tableName]?.length ?? 0,
  );
  const readSource = vi.fn(async (source: any) => {
    const tableName =
      source.type === "FullTableScan"
        ? source.tableName
        : String(source.indexName).split(".")[0];
    let rows = [...(rowsByTable[tableName] ?? [])];
    if (source.type === "IndexRange") {
      rows = rows.filter((row) =>
        source.range.every(
          (entry: any) =>
            entry.type !== "Eq" || row[entry.fieldPath] === entry.value,
        ),
      );
    }
    return rows;
  });

  const storage = mockAdapter({
    kind: "sql",
    listAll: async () =>
      Object.entries(rowsByTable).flatMap(([tableName, docs]) =>
        docs.map((doc) => ({ tableName, doc })),
      ),
    list: listDocuments,
    get: getDocument,
    hasAnyDocuments: async (tableName: string) =>
      (rowsByTable[tableName]?.length ?? 0) > 0,
    listMany: async (tableNames: string[]) =>
      tableNames.flatMap((tableName) =>
        (rowsByTable[tableName] ?? []).map((doc) => ({ tableName, doc })),
      ),
    meta: async () => ({ timestamp: 0, lastCreationTime: 0 }),
    count: countDocuments,
    source: readSource,
    query: async () => null,
    listBlobs: async () => [],
    getBlob: async () => null,
    write: vi.fn(async (batch, opts) => {
      for (const put of batch.puts) {
        const tableRows = rowsByTable[put.tableName] ?? [];
        const next = tableRows.filter((row) => row._id !== put.doc._id);
        next.push(put.doc);
        rowsByTable[put.tableName] = next;
      }
      for (const deletion of batch.deletes) {
        rowsByTable[deletion.tableName] = (
          rowsByTable[deletion.tableName] ?? []
        ).filter((row) => row._id !== deletion.id);
      }
      if (opts) {
        return {
          meta: batch.meta,
          tables: (opts.materializedTables ?? []).map((tableName: string) => ({
            tableName,
            docs: rowsByTable[tableName] ?? [],
          })),
        };
      }
    }),
    putBlob: async () => undefined,
    deleteBlob: async () => undefined,
    clearAll: async () => undefined,
  });

  // Expose the `list` mock that mockAdapter actually wires. Tests destructure
  // as `{ list: someName }` and assert on it.
  return { storage, list: listDocuments, readSource, getDocument };
}

async function flushRuntimeWatch(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let runtime: EmbeddedRuntime;

beforeEach(() => {
  MockBroadcastChannel.reset();
  vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  runtime = new EmbeddedRuntime({ convex: { modules: STUB_MODULES } });
});

afterEach(() => {
  runtime.shutdown();
  vi.unstubAllGlobals();
  MockBroadcastChannel.reset();
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("Construction", () => {
  it("creates without errors with empty modules", () => {
    // runtime was already created in beforeEach — if we got here it succeeded
    expect(runtime).toBeDefined();
  });

  it("exposes all subsystems as public readonly fields", () => {
    expect(runtime.db).toBeDefined();
    expect(runtime.moduleLoader).toBeDefined();
    expect(runtime.executor).toBeDefined();
    expect(runtime.transactionManager).toBeDefined();
    expect(runtime.subscriptions).toBeDefined();
    expect(runtime.syncProtocol).toBeDefined();
    expect(runtime.sessions).toBeDefined();
    expect(runtime.writeFanout).toBeDefined();
    expect(runtime.auth).toBeDefined();
    expect(runtime.scheduler).toBeDefined();
  });

  it("surfaces storage hydration failures instead of swallowing them", async () => {
    const failingRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter({
        kind: "opaque",
        listAll: async () => {
          throw new Error("boom");
        },
        list: async () => [],
        meta: async () => null,
        listBlobs: async () => [],
        commit: async () => undefined,
        putBlob: async () => undefined,
        deleteBlob: async () => undefined,
        clear: async () => undefined,
      }),
    });

    try {
      await expect(failingRuntime.hydrate()).rejects.toThrow("boom");
    } finally {
      failingRuntime.shutdown();
    }
  });
});

describe("Action execution", () => {
  it("serializes top-level actions", async () => {
    const firstGate = deferredPromise<void>();
    const events: string[] = [];
    const serialRuntime = new EmbeddedRuntime({
      convex: {
        modules: {
          api: () =>
            Promise.resolve({
              first: {
                isAction: true,
                handler: async () => {
                  events.push("first:start");
                  await firstGate.promise;
                  events.push("first:end");
                  return "first";
                },
              },
              second: {
                isAction: true,
                handler: async () => {
                  events.push("second:start");
                  events.push("second:end");
                  return "second";
                },
              },
            }),
          _generated: () => Promise.resolve({}),
          "_generated/api": () => Promise.resolve({}),
        },
      },
    });

    try {
      const first = serialRuntime.executeLocal({
        kind: "action",
        path: "api:first",
        args: {},
      });
      await flushRuntimeWatch();
      const second = serialRuntime.executeLocal({
        kind: "action",
        path: "api:second",
        args: {},
      });
      await flushRuntimeWatch();

      expect(events).toEqual(["first:start"]);

      firstGate.resolve();

      await expect(first).resolves.toBe("first");
      await expect(second).resolves.toBe("second");
      expect(events).toEqual([
        "first:start",
        "first:end",
        "second:start",
        "second:end",
      ]);
    } finally {
      serialRuntime.shutdown();
    }
  });
});

describe("Blob storage", () => {
  it("rolls back metadata when durable blob storage fails", async () => {
    const blobRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter({
        kind: "opaque",
        listAll: async () => [],
        list: async () => [],
        meta: async () => ({ timestamp: 0, lastCreationTime: 0 }),
        listBlobs: async () => [],
        commit: async () => undefined,
        putBlob: async () => {
          throw new Error("disk full");
        },
        deleteBlob: async () => undefined,
        clear: async () => undefined,
      }),
    });

    try {
      await blobRuntime.hydrate();
      await expect(
        blobRuntime.storeUploadedBlob(new Blob(["data"])),
      ).rejects.toThrow("disk full");
      expect(blobRuntime.db.getDocumentsForTable("_storage")).toEqual([]);
    } finally {
      blobRuntime.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// handleMessage
// ---------------------------------------------------------------------------

describe("handleMessage", () => {
  it("returns FatalError ServerMessage for invalid JSON", async () => {
    await runtime.hydrate();

    const responses = await runtime.handleMessage("not valid json {{{");

    expect(responses).toHaveLength(1);
    const parsed = JSON.parse(responses[0]);
    expect(parsed.type).toBe("FatalError");
    expect(parsed.error).toBe("Invalid JSON");
  });

  it("routes valid Authenticate message through protocol", async () => {
    await runtime.hydrate();

    // Must Connect first to establish a session
    await runtime.handleMessage(
      JSON.stringify({
        type: "Connect",
        sessionId: "s1",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      }),
    );

    // Set identity so auth verification succeeds
    runtime.setIdentity({
      subject: "user-1",
      issuer: "https://test.local",
      tokenIdentifier: "https://test.local|user-1",
    });

    const responses = await runtime.handleMessage(
      JSON.stringify({
        type: "Authenticate",
        tokenType: "User",
        value: "test-token",
        baseVersion: 0,
        sessionId: "s1",
      }),
    );

    expect(responses.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(responses[0]);
    // Successful auth returns a Transition with incremented identity version
    expect(parsed.type).toBe("Transition");
  });

  it("returns serialized ServerMessage array", async () => {
    await runtime.hydrate();

    const responses = await runtime.handleMessage(
      JSON.stringify({
        type: "Connect",
        sessionId: "s1",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      }),
    );

    expect(Array.isArray(responses)).toBe(true);
    // Each element is a JSON string
    responses.forEach((r) => {
      expect(typeof r).toBe("string");
      const parsed = JSON.parse(r);
      expect(typeof parsed.type).toBe("string");
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation commit
// ---------------------------------------------------------------------------

describe("onMutationCommit", () => {
  it("invalidates subscriptions for written tables", () => {
    const cb = vi.fn();
    runtime.subscriptions.subscribe("q1", new Set(["users"]), cb);

    runtime.onMutationCommit({
      tablesWritten: new Set(["users"]),
      invalidation: { tables: new Set(["users"]), changes: [] },
      persisted: Promise.resolve(),
      timestamp: 1,
    });

    expect(cb).toHaveBeenCalledOnce();
  });

  it("is no-op for empty tablesWritten", () => {
    const cb = vi.fn();
    runtime.subscriptions.subscribe("q1", new Set(["users"]), cb);

    runtime.onMutationCommit({
      tablesWritten: new Set(),
      invalidation: { tables: new Set(), changes: [] },
      persisted: Promise.resolve(),
      timestamp: 0,
    });

    expect(cb).not.toHaveBeenCalled();
  });

  it("delays cross-tab fanout until storage settles", async () => {
    let resolvePersist!: () => void;
    const notifySpy = vi.spyOn(runtime.writeFanout, "notify");

    runtime.onMutationCommit({
      tablesWritten: new Set(["users"]),
      invalidation: { tables: new Set(["users"]), changes: [] },
      persisted: new Promise<void>((resolve) => {
        resolvePersist = resolve;
      }),
      timestamp: 1,
    });

    await Promise.resolve();
    expect(notifySpy).not.toHaveBeenCalled();

    resolvePersist();
    await flushRuntimeWatch();

    expect(notifySpy).toHaveBeenCalledWith(new Set(["users"]));
  });

  it("skips cross-tab fanout when storage fails", async () => {
    const notifySpy = vi.spyOn(runtime.writeFanout, "notify");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    runtime.onMutationCommit({
      tablesWritten: new Set(["users"]),
      invalidation: { tables: new Set(["users"]), changes: [] },
      persisted: Promise.reject(new Error("disk full")),
      timestamp: 1,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(notifySpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("cross-tab fanout refreshes another runtime after storage settles", async () => {
    const runtimeA = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      writeBroadcast: new BrowserWriteBroadcast("shared-runtime"),
    });
    const runtimeB = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      writeBroadcast: new BrowserWriteBroadcast("shared-runtime"),
    });

    try {
      await runtimeA.hydrate();
      await runtimeB.hydrate();

      const syncSpy = vi
        .spyOn(runtimeB.db, "syncTable")
        .mockResolvedValue(undefined as never);
      const reevalSpy = vi
        .spyOn(runtimeB.syncProtocol, "reEvaluateQueries")
        .mockResolvedValue(new Map());
      runtimeA.onMutationCommit({
        tablesWritten: new Set(["tasks"]),
        invalidation: { tables: new Set(["tasks"]), changes: [] },
        persisted: Promise.resolve(),
        timestamp: 1,
      });

      await flushRuntimeWatch();

      expect(syncSpy).toHaveBeenCalledWith("tasks");
      expect(reevalSpy).toHaveBeenCalledWith([
        { tableName: "tasks", before: null, after: null },
      ]);
    } finally {
      runtimeA.shutdown();
      runtimeB.shutdown();
    }
  });

  it("multiple cross-tab commits converge on the latest runtime refresh", async () => {
    const runtimeA = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      writeBroadcast: new BrowserWriteBroadcast("shared-runtime-burst"),
    });
    const runtimeB = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      writeBroadcast: new BrowserWriteBroadcast("shared-runtime-burst"),
    });

    try {
      await runtimeA.hydrate();
      await runtimeB.hydrate();

      const syncSpy = vi
        .spyOn(runtimeB.db, "syncTable")
        .mockResolvedValue(undefined as never);
      runtimeA.onMutationCommit({
        tablesWritten: new Set(["tasks"]),
        invalidation: { tables: new Set(["tasks"]), changes: [] },
        persisted: Promise.resolve(),
        timestamp: 1,
      });
      runtimeA.onMutationCommit({
        tablesWritten: new Set(["tasks"]),
        invalidation: { tables: new Set(["tasks"]), changes: [] },
        persisted: Promise.resolve(),
        timestamp: 2,
      });

      await flushRuntimeWatch();

      expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      runtimeA.shutdown();
      runtimeB.shutdown();
    }
  });
});

describe("transaction locking", () => {
  it("serializes concurrent top-level mutations", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const order: string[] = [];
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const localRuntime = new EmbeddedRuntime({
      convex: {
        modules: {
          ...STUB_MODULES,
          tasks: () =>
            Promise.resolve({
              create: {
                isMutation: true,
                _handler: async () => {
                  order.push("first:start");
                  firstStarted();
                  await new Promise<void>((resolve) => {
                    releaseFirst = resolve;
                  });
                  order.push("first:end");
                  return "first";
                },
              },
              update: {
                isMutation: true,
                _handler: async () => {
                  order.push("second:start");
                  order.push("second:end");
                  return "second";
                },
              },
            }),
        },
      },
    });

    await localRuntime.hydrate();

    const first = localRuntime.executeLocal({
      kind: "mutation",
      path: "tasks:create",
      args: {},
      applyLocalEffects: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    const second = localRuntime.executeLocal({
      kind: "mutation",
      path: "tasks:update",
      args: {},
      applyLocalEffects: false,
    });
    let secondResolved = false;
    void second.then(() => {
      secondResolved = true;
    });

    await firstStartedPromise;

    expect(secondResolved).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);

    localRuntime.shutdown();
  });
});

describe("sql storage hydration", () => {
  it("does not hydrate sql-backed tables on demand for local query watches", async () => {
    const getDocumentsByTable = vi.fn(async () => []);
    const getDocumentsByTables = vi.fn(async () => []);
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter({
        kind: "sql",
        listAll: async () => [],
        list: getDocumentsByTable,
        get: async () => null,
        getDocumentsByTables,
        hasAnyDocuments: async () => false,
        meta: async () => ({ timestamp: 0, lastCreationTime: 0 }),
        getDocuments: async () => [],
        count: async () => 0,
        source: async () => [],
        query: async () => [],
        listBlobs: async () => [],
        getBlob: async () => null,
        commit: async () => undefined,
        putBlob: async () => undefined,
        deleteBlob: async () => undefined,
        clear: async () => undefined,
      }),
    });

    try {
      await localRuntime.hydrate();
      vi.spyOn(localRuntime as any, "_evaluateLocalQuery").mockResolvedValue({
        result: [],
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      });

      localRuntime.watchLocalQuery("tasks:list", {});
      await flushRuntimeWatch();

      expect(getDocumentsByTables).not.toHaveBeenCalled();
      expect(getDocumentsByTable).not.toHaveBeenCalled();
    } finally {
      localRuntime.shutdown();
    }
  });

  it("eagerly hydrates via listAll during startup", async () => {
    const listAll = vi.fn(async () => []);
    const getDocumentsByTable = vi.fn(async () => []);
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter({
        kind: "sql",
        listAll,
        list: getDocumentsByTable,
        get: async () => null,
        hasAnyDocuments: async () => false,
        meta: async () => ({ timestamp: 0, lastCreationTime: 0 }),
        getDocuments: async () => [],
        count: async () => 0,
        source: async () => [],
        query: async () => [],
        listBlobs: async () => [],
        getBlob: async () => null,
        commit: async () => undefined,
        putBlob: async () => undefined,
        deleteBlob: async () => undefined,
        clear: async () => undefined,
      }),
    });

    try {
      await localRuntime.hydrate();
      // Eager hydration uses listAll (batch) rather than per-table list.
      expect(listAll).toHaveBeenCalled();
    } finally {
      localRuntime.shutdown();
    }
  });

  it("ingestDocuments diffs against the in-memory snapshot without re-reading sql", async () => {
    const {
      storage,
      list: getDocumentsByTable,
      readSource,
    } = createSqlStorage({
      tasks: [{ _id: "task-1", _creationTime: 1, title: "Persisted" }],
    });
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter(storage),
    });

    try {
      await localRuntime.hydrate();
      const readSourceCallsBeforeIngest = readSource.mock.calls.length;
      const listCallsBeforeIngest = getDocumentsByTable.mock.calls.length;

      await localRuntime.ingestDocuments("tasks", [
        { _id: "task-1", _creationTime: 1, title: "Persisted" },
      ]);

      // After Phase 1, queryable tables hydrate into RAM up front, so
      // ingestDocuments diffs against the in-memory snapshot. It must not
      // pushdown to the source query path or re-list the table from SQL.
      expect(readSource.mock.calls.length).toBe(readSourceCallsBeforeIngest);
      expect(getDocumentsByTable.mock.calls.length).toBe(listCallsBeforeIngest);
    } finally {
      localRuntime.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Document ingestion
// ---------------------------------------------------------------------------

describe("ingestDocuments", () => {
  it("inserts new documents", async () => {
    await runtime.hydrate();

    await runtime.ingestDocuments("tasks", [
      { _id: "id1", _creationTime: 1, title: "Task A" },
      { _id: "id2", _creationTime: 2, title: "Task B" },
    ]);

    const docs = await runtime.getDocumentsForTable("tasks");
    expect(docs).toHaveLength(2);

    const titles = docs
      .map((d) => d.title as string)
      .sort((a, b) => a.localeCompare(b));
    expect(titles).toEqual(["Task A", "Task B"]);
  });

  it("deletes documents missing from remote", async () => {
    await runtime.hydrate();

    // Ingest two documents
    await runtime.ingestDocuments("tasks", [
      { _id: "id1", _creationTime: 1, title: "Keep" },
      { _id: "id2", _creationTime: 2, title: "Remove" },
    ]);

    // Re-ingest with only one — id2 should be deleted
    await runtime.ingestDocuments("tasks", [
      { _id: "id1", _creationTime: 1, title: "Keep" },
    ]);

    const docs = await runtime.getDocumentsForTable("tasks");
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("Keep");
  });

  it("no-ops when documents are identical", async () => {
    await runtime.hydrate();

    const remoteDocs = [{ _id: "id1", _creationTime: 1, title: "Same" }];

    await runtime.ingestDocuments("tasks", remoteDocs);

    // Spy on subscription invalidation to detect writes
    const invalidateSpy = vi.spyOn(runtime.subscriptions, "invalidate");

    // Ingest the same documents again — should be a no-op
    await runtime.ingestDocuments("tasks", remoteDocs);

    // invalidate should NOT have been called by the second ingest
    expect(invalidateSpy).not.toHaveBeenCalled();

    invalidateSpy.mockRestore();
  });

  it("re-evaluates queries with the ingested table name", async () => {
    await runtime.hydrate();

    const reEvaluateQueriesSpy = vi.spyOn(
      runtime.syncProtocol,
      "reEvaluateQueries",
    );
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await runtime.ingestDocuments("tasks", [
      { _id: "id1", _creationTime: 1, title: "Task A" },
    ]);

    expect(reEvaluateQueriesSpy).toHaveBeenCalledWith([
      { tableName: "tasks", before: null, after: null },
    ]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("scopes mirrored table contents by identity and anonymous namespace", async () => {
    await runtime.hydrate();

    await runtime.ingestDocuments("tasks", [
      { _id: "anon-1", _creationTime: 1, title: "Anonymous" },
    ]);

    expect(await runtime.getDocumentsForTable("tasks")).toEqual([
      { _id: "anon-1", _creationTime: 1, title: "Anonymous" },
    ]);

    runtime.setIdentity(createTestIdentity({ subject: "alice" }));
    expect(await runtime.getDocumentsForTable("tasks")).toEqual([]);

    await runtime.ingestDocuments("tasks", [
      { _id: "alice-1", _creationTime: 2, title: "Alice" },
    ]);

    expect(await runtime.getDocumentsForTable("tasks")).toEqual([
      { _id: "alice-1", _creationTime: 2, title: "Alice" },
    ]);

    runtime.setIdentity(null);
    expect(await runtime.getDocumentsForTable("tasks")).toEqual([
      { _id: "anon-1", _creationTime: 1, title: "Anonymous" },
    ]);
  });

  it("migrates anonymous mirrored data into an authenticated namespace", async () => {
    await runtime.hydrate();

    await runtime.ingestDocuments("tasks", [
      { _id: "anon-1", _creationTime: 1, title: "Anonymous" },
    ]);

    const identity = createTestIdentity({ subject: "alice" });
    runtime.setIdentity(identity);
    await runtime.migrateAnonymousDataToIdentity(identity.tokenIdentifier);

    expect(await runtime.getDocumentsForTable("tasks")).toEqual([
      { _id: "anon-1", _creationTime: 1, title: "Anonymous" },
    ]);

    runtime.setIdentity(null);
    expect(await runtime.getDocumentsForTable("tasks")).toEqual([]);
  });

  it("canonicalizes a mapped create atomically across owning and referencing tables", async () => {
    await runtime.hydrate();

    await runtime.ingestDocuments("tasks", [
      { _id: "local-task", _creationTime: 1, title: "Local title" },
      { _id: "remote-task", _creationTime: 1, title: "Remote title" },
    ]);
    await runtime.ingestDocuments("comments", [
      {
        _id: "comment-1",
        _creationTime: 2,
        issueId: "local-task",
        body: "linked",
      },
    ]);

    await runtime.canonicalizeMappedCreate({
      localId: "local-task",
      remoteId: "remote-task",
      tableName: "tasks",
      schemas: {
        tasks: createMockSchema(),
        comments: createMockSchema({
          shape: {
            issueId: { kind: "id", tableName: "tasks" },
            body: "string",
          },
          getShape: () => ({
            issueId: { kind: "id", tableName: "tasks" },
            body: "string",
          }),
        }),
      },
    });

    expect(await runtime.getDocumentsForTable("tasks")).toEqual([
      { _id: "remote-task", _creationTime: 1, title: "Local title" },
    ]);
    expect(await runtime.getDocumentsForTable("comments")).toEqual([
      {
        _id: "comment-1",
        _creationTime: 2,
        issueId: "remote-task",
        body: "linked",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Direct execution
// ---------------------------------------------------------------------------

describe("executeLocal query", () => {
  it("runs a system function", async () => {
    await runtime.hydrate();

    // _system:idMapGetAll is a system query that returns all ID mappings
    const result = await runtime.executeLocal({
      kind: "query",
      path: "_system:idMapGetAll",
      args: {},
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("reads persisted sql-backed id map rows through system queries", async () => {
    const {
      storage,
      list: getDocumentsByTable,
      readSource,
    } = createSqlStorage({
      _resolve_id_map: [
        {
          _id: "map-1",
          _creationTime: 1,
          localId: "local-1",
          remoteId: "remote-1",
          table: "tasks",
          identityKey: "user:a",
        },
      ],
    });
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter(storage),
    });

    try {
      await localRuntime.hydrate();

      expect(getDocumentsByTable).not.toHaveBeenCalledWith("_resolve_id_map");

      const result = await localRuntime.executeLocal({
        kind: "query",
        path: "_system:idMapGetAll",
        args: { identityKey: "user:a" },
      });

      expect(result).toEqual([
        {
          localId: "local-1",
          remoteId: "remote-1",
          table: "tasks",
          identityKey: "user:a",
        },
      ]);
      expect(getDocumentsByTable).not.toHaveBeenCalledWith("_resolve_id_map");
      // Phase 1: hydrated tables serve reads from RAM, so the SQL source
      // pushdown is no longer the primary path. The data correctness checks
      // above are what matter.
    } finally {
      localRuntime.shutdown();
    }
  });

  it("reads sql-backed collection and document metadata through system queries", async () => {
    const {
      storage,
      readSource,
      list: getDocumentsByTable,
    } = createSqlStorage({
      _resolve_collection_metadata: [
        {
          _id: "collection-meta-1",
          _creationTime: 1,
          collection: "tasks",
          seq: 7,
          identityKey: "user:a",
          schemaVersion: 1,
        },
      ],
      _resolve_document_metadata: [
        {
          _id: "doc-meta-1",
          _creationTime: 1,
          collection: "tasks",
          docId: "task-1",
          seq: 3,
          identityKey: "user:a",
          schemaVersion: 1,
        },
      ],
    });
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter(storage),
    });

    try {
      await localRuntime.hydrate();

      const collectionSeq = await localRuntime.executeLocal({
        kind: "query",
        path: "_system:collectionMetadataGet",
        args: {
          collection: "tasks",
          identityKey: "user:a",
          schemaVersion: 1,
        },
      });
      const docMetadata = await localRuntime.executeLocal({
        kind: "query",
        path: "_system:documentMetadataGetBatch",
        args: {
          collection: "tasks",
          docIds: ["task-1"],
          identityKey: "user:a",
          schemaVersion: 1,
        },
      });

      expect(collectionSeq).toBe(7);
      expect(docMetadata).toEqual([{ docId: "task-1", seq: 3 }]);
      // Phase 1: hydrated tables serve reads from RAM, so the SQL source
      // pushdown is no longer the primary path. The data correctness checks
      // above are what matter.
      expect(getDocumentsByTable).not.toHaveBeenCalledWith(
        "_resolve_collection_metadata",
      );
      expect(getDocumentsByTable).not.toHaveBeenCalledWith(
        "_resolve_document_metadata",
      );
    } finally {
      localRuntime.shutdown();
    }
  });

  it("reads sql-backed auth state and pending identity keys through system queries", async () => {
    const { storage, list: getDocumentsByTable } = createSqlStorage({
      _resolve_auth_state: [
        {
          _id: "auth-1",
          _creationTime: 1,
          activeIdentityKey: "user:a",
          updatedAt: 1,
        },
      ],
      _resolve_pending: [
        {
          _id: "pending-1",
          _creationTime: 1,
          createdAt: 1,
          ref: "tasks:create",
          args: JSON.stringify({}),
          localResult: JSON.stringify(null),
          table: "tasks",
          payloadVersion: 1,
          identityKey: "user:b",
          state: "pending",
        },
        {
          _id: "pending-2",
          _creationTime: 2,
          createdAt: 2,
          ref: "tasks:update",
          args: JSON.stringify({}),
          localResult: JSON.stringify(null),
          table: "tasks",
          payloadVersion: 1,
          identityKey: "user:a",
          state: "pending",
        },
      ],
    });
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter(storage),
    });

    try {
      await localRuntime.hydrate();

      const activeIdentity = await localRuntime.executeLocal({
        kind: "query",
        path: "_system:authStateGetActive",
        args: {},
      });
      const identityKeys = await localRuntime.executeLocal({
        kind: "query",
        path: "_system:pendingListIdentityKeys",
        args: {},
      });

      expect(activeIdentity).toBe("user:a");
      expect(identityKeys).toEqual(["user:a", "user:b"]);
      // Eager `listAll` seeds memory on startup; system queries read from the
      // materialized view rather than pushing `list(tableName)` down per-read.
    } finally {
      localRuntime.shutdown();
    }
  });
});

describe("runtime query helpers", () => {
  it("queries through the public runtime facade", async () => {
    await runtime.hydrate();

    const executeLocal = vi
      .spyOn(runtime, "executeLocal")
      .mockResolvedValue([{ _id: "task-1" }]);

    const queryRef = makeFunctionReference<"query">("tasks:list");
    const result = await runtime.query(queryRef, {});

    expect(executeLocal).toHaveBeenCalledWith({
      kind: "query",
      path: "tasks:list",
      args: {},
    });
    expect(result).toEqual([{ _id: "task-1" }]);
  });

  it("paginates through the public runtime facade", async () => {
    await runtime.hydrate();

    const executeLocal = vi.spyOn(runtime, "executeLocal").mockResolvedValue({
      page: [{ _id: "task-1" }],
      isDone: false,
      continueCursor: "cursor-2",
    });

    const queryRef = makeFunctionReference<"query">("tasks:list");
    const result = await runtime.paginate(
      queryRef,
      { owner: "alice" },
      { initialNumItems: 10 },
    );

    expect(executeLocal).toHaveBeenCalledWith({
      kind: "query",
      path: "tasks:list",
      args: {
        owner: "alice",
        paginationOpts: {
          cursor: null,
          numItems: 10,
          id: -1,
        },
      },
    });
    expect(result).toEqual({
      page: [{ _id: "task-1" }],
      isDone: false,
      continueCursor: "cursor-2",
    });
  });
});

describe("prefetch startup", () => {
  it("seeds the runtime from prefetched data before first reads", async () => {
    const seededRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      prefetch: {
        identityKey: null,
        tables: {
          tasks: [
            {
              _id: "task-1",
              _creationTime: 1,
              title: "From prefetch",
            },
          ],
        },
        metadata: {
          tasks: {
            collectionSeq: 1,
            documents: [{ docId: "task-1", seq: 1 }],
          },
        },
      },
    });

    await seededRuntime.hydrate();

    expect(await seededRuntime.getDocumentsForTable("tasks")).toEqual([
      {
        _id: "task-1",
        _creationTime: 1,
        title: "From prefetch",
      },
    ]);

    seededRuntime.shutdown();
  });

  it("allows manual prefetch ingest when no initial prefetch is provided", async () => {
    const deferredRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
    });

    try {
      await deferredRuntime.hydrate();

      expect(await deferredRuntime.getDocumentsForTable("tasks")).toEqual([]);
      expect(deferredRuntime.getIdentityKey()).toBeNull();

      await deferredRuntime.ingestPrefetch({
        identityKey: "user-1",
        tables: {
          tasks: [
            {
              _id: "task-1",
              _creationTime: 1,
              title: "Deferred prefetch",
            },
          ],
        },
        metadata: {
          tasks: {
            collectionSeq: 1,
            documents: [{ docId: "task-1", seq: 1 }],
          },
        },
      });

      expect(await deferredRuntime.getDocumentsForTable("tasks")).toEqual([
        {
          _id: "task-1",
          _creationTime: 1,
          title: "Deferred prefetch",
        },
      ]);
      expect(deferredRuntime.getIdentityKey()).toBe("user-1");
    } finally {
      deferredRuntime.shutdown();
    }
  });

  it("does not overwrite persisted local data with prefetched rows", async () => {
    const persistedRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter({
        kind: "opaque",
        listAll: async () =>
          [
            {
              tableName: "tasks",
              doc: {
                _id: "task-local",
                _creationTime: 1,
                title: "Persisted local row",
              },
            },
          ] as any,
        list: async (tableName) =>
          tableName === "tasks"
            ? ([
                {
                  _id: "task-local",
                  _creationTime: 1,
                  title: "Persisted local row",
                },
              ] as any)
            : ([] as any),
        meta: async () => ({ timestamp: 1, lastCreationTime: 1 }),
        listBlobs: async () => [],
        commit: async () => undefined,
        putBlob: async () => undefined,
        deleteBlob: async () => undefined,
        clear: async () => undefined,
      }),
      prefetch: {
        identityKey: "prefetch-user",
        tables: {
          tasks: [
            {
              _id: "task-prefetch",
              _creationTime: 2,
              title: "Prefetched row",
            },
          ],
        },
        metadata: {
          tasks: {
            collectionSeq: 2,
            documents: [{ docId: "task-prefetch", seq: 2 }],
          },
        },
      },
    });

    try {
      await persistedRuntime.hydrate();

      expect(await persistedRuntime.getDocumentsForTable("tasks")).toEqual([
        {
          _id: "task-local",
          _creationTime: 1,
          title: "Persisted local row",
        },
      ]);
      expect(persistedRuntime.getIdentityKey()).toBeNull();
    } finally {
      persistedRuntime.shutdown();
    }
  });

  it("seeds resolve metadata from prefetched rows", async () => {
    const seededRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      prefetch: {
        identityKey: "user-1",
        tables: {
          tasks: [
            {
              _id: "task-1",
              _creationTime: 1,
              title: "From prefetch",
            },
          ],
        },
        metadata: {
          tasks: {
            collectionSeq: 9,
            documents: [{ docId: "task-1", seq: 9 }],
          },
        },
      },
    });

    try {
      await seededRuntime.hydrate();

      expect(
        seededRuntime.db.getDocumentsForTable("_resolve_collection_metadata"),
      ).toEqual([
        expect.objectContaining({
          collection: "tasks",
          seq: 9,
          identityKey: "user-1",
          schemaVersion: 1,
        }),
      ]);
      expect(
        seededRuntime.db.getDocumentsForTable("_resolve_document_metadata"),
      ).toEqual([
        expect.objectContaining({
          collection: "tasks",
          docId: "task-1",
          seq: 9,
          identityKey: "user-1",
          schemaVersion: 1,
        }),
      ]);
    } finally {
      seededRuntime.shutdown();
    }
  });

  it("persists prefetched sql rows during direct runtime startup", async () => {
    const rowsByTable: Record<string, Array<Record<string, unknown>>> = {};
    const { storage } = createSqlStorage(rowsByTable);
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter(storage),
      prefetch: {
        identityKey: null,
        tables: {
          tasks: [
            {
              _id: "task-prefetch",
              _creationTime: 1,
              title: "Prefetched",
            },
          ],
        },
        metadata: {
          tasks: {
            collectionSeq: 1,
            documents: [{ docId: "task-prefetch", seq: 1 }],
          },
        },
      },
    });

    try {
      await localRuntime.hydrate();
      expect(rowsByTable.tasks).toEqual([
        {
          __identityKey: null,
          _id: "task-prefetch",
          _creationTime: 1,
          title: "Prefetched",
        },
      ]);
    } finally {
      localRuntime.shutdown();
    }
  });
});

describe("watchLocalQuery", () => {
  it("waits for hydration before evaluating the first local result", async () => {
    const gate =
      deferredPromise<
        Array<{ tableName: string; doc: Record<string, unknown> }>
      >();
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter({
        kind: "opaque",
        listAll: async () => gate.promise,
        list: async () => [],
        meta: async () => null,
        listBlobs: async () => [],
        commit: async () => undefined,
        putBlob: async () => undefined,
        deleteBlob: async () => undefined,
        clear: async () => undefined,
      }),
    });

    const evaluateSpy = vi
      .spyOn(localRuntime as any, "_evaluateLocalQuery")
      .mockResolvedValue({
        result: [{ _id: "task-1" }],
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      });

    const watch = localRuntime.watchLocalQuery("tasks:list", {});

    try {
      await flushRuntimeWatch();

      expect(evaluateSpy).not.toHaveBeenCalled();
      expect(watch.localQueryResult()).toBeUndefined();

      gate.resolve([]);
      await localRuntime.hydrate();
      await flushRuntimeWatch();

      expect(evaluateSpy).toHaveBeenCalledWith("tasks:list", {});
      expect(watch.localQueryResult()).toEqual([{ _id: "task-1" }]);
    } finally {
      localRuntime.shutdown();
    }
  });

  it("returns undefined until the first evaluation completes", async () => {
    await runtime.hydrate();

    const evaluateSpy = vi
      .spyOn(runtime as any, "_evaluateLocalQuery")
      .mockResolvedValue({
        result: [{ _id: "task-1" }],
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      });

    const watch = runtime.watchLocalQuery("tasks:list", {});

    expect(watch.localQueryResult()).toBeUndefined();

    await flushRuntimeWatch();

    expect(evaluateSpy).toHaveBeenCalledWith("tasks:list", {});
    expect(watch.localQueryResult()).toEqual([{ _id: "task-1" }]);
  });

  it("notifies listeners asynchronously when a cached result already exists", async () => {
    vi.useFakeTimers();
    try {
      await runtime.hydrate();

      vi.spyOn(runtime as any, "_evaluateLocalQuery").mockResolvedValue({
        result: [{ _id: "task-1" }],
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      });

      const watch = runtime.watchLocalQuery("tasks:list", {});
      await flushRuntimeWatch();

      const callback = vi.fn();
      watch.onUpdate(callback);

      expect(callback).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();

      expect(callback).toHaveBeenCalledOnce();
      expect(watch.localQueryResult()).toEqual([{ _id: "task-1" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not miss the first callback when subscribed before hydration completes", async () => {
    const gate =
      deferredPromise<
        Array<{ tableName: string; doc: Record<string, unknown> }>
      >();
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter({
        kind: "opaque",
        listAll: async () => gate.promise,
        list: async () => [],
        meta: async () => null,
        listBlobs: async () => [],
        commit: async () => undefined,
        putBlob: async () => undefined,
        deleteBlob: async () => undefined,
        clear: async () => undefined,
      }),
    });

    vi.spyOn(localRuntime as any, "_evaluateLocalQuery").mockResolvedValue({
      result: [{ _id: "task-1" }],
      tablesRead: new Set(["tasks"]),
      dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
    });

    const watch = localRuntime.watchLocalQuery("tasks:list", {});
    const callback = vi.fn();
    watch.onUpdate(callback);

    try {
      gate.resolve([]);
      await localRuntime.hydrate();
      await flushRuntimeWatch();

      expect(callback).toHaveBeenCalledOnce();
      expect(watch.localQueryResult()).toEqual([{ _id: "task-1" }]);
    } finally {
      localRuntime.shutdown();
    }
  });

  it("re-evaluates after matching local writes invalidate tracked dependencies", async () => {
    await runtime.hydrate();

    const evaluateSpy = vi
      .spyOn(runtime as any, "_evaluateLocalQuery")
      .mockResolvedValueOnce({
        result: [{ _id: "task-1", title: "before" }],
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      })
      .mockResolvedValueOnce({
        result: [{ _id: "task-1", title: "after" }],
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      });

    const watch = runtime.watchLocalQuery("tasks:list", {});
    const callback = vi.fn();
    watch.onUpdate(callback);

    await flushRuntimeWatch();
    expect(callback).toHaveBeenCalledTimes(1);

    runtime.onMutationCommit({
      tablesWritten: new Set(["tasks"]),
      invalidation: { tables: new Set(["tasks"]), changes: [] },
      persisted: Promise.resolve(),
      timestamp: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(evaluateSpy).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(watch.localQueryResult()).toEqual([
      { _id: "task-1", title: "after" },
    ]);
  });

  it("updates local watches before storage settles for cold sql-backed tables", async () => {
    await runtime.hydrate();

    const evaluateSpy = vi
      .spyOn(runtime as any, "_evaluateLocalQuery")
      .mockResolvedValueOnce({
        result: [{ _id: "task-1", title: "before" }],
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      })
      .mockResolvedValueOnce({
        result: [{ _id: "task-1", title: "after" }],
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      });

    const watch = runtime.watchLocalQuery("tasks:list", {});
    const callback = vi.fn();
    watch.onUpdate(callback);

    await flushRuntimeWatch();
    expect(callback).toHaveBeenCalledTimes(1);

    const persisted = deferredPromise<void>();
    runtime.onMutationCommit({
      tablesWritten: new Set(["tasks"]),
      invalidation: { tables: new Set(["tasks"]), changes: [] },
      persisted: persisted.promise,
      timestamp: 1,
    });

    await flushRuntimeWatch();

    expect(evaluateSpy).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(watch.localQueryResult()).toEqual([
      { _id: "task-1", title: "after" },
    ]);

    persisted.resolve();
    await flushRuntimeWatch();

    expect(evaluateSpy).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("throws the latest evaluation error from localQueryResult", async () => {
    await runtime.hydrate();

    vi.spyOn(runtime as any, "_evaluateLocalQuery").mockRejectedValue(
      new Error("watch failed"),
    );

    const watch = runtime.watchLocalQuery("tasks:list", {});
    const callback = vi.fn();
    watch.onUpdate(callback);

    await flushRuntimeWatch();

    expect(callback).toHaveBeenCalledOnce();
    expect(() => watch.localQueryResult()).toThrow("watch failed");
    expect(watch.localQueryLogs()).toEqual(["watch failed"]);
  });
});

describe("watchLocalPaginatedQuery", () => {
  it("builds a paginated local result and supports loadMore", async () => {
    await runtime.hydrate();

    vi.spyOn(runtime as any, "_evaluateLocalPaginatedPage").mockImplementation(
      async (...args: any[]) => ({
        result:
          args[2] === null
            ? {
                page: [{ _id: "task-1" }],
                isDone: false,
                continueCursor: "cursor-2",
              }
            : {
                page: [{ _id: "task-2" }],
                isDone: true,
                continueCursor: "_end_cursor",
              },
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      }),
    );

    const watch = runtime.watchLocalPaginatedQuery(
      "tasks:list",
      {},
      {
        initialNumItems: 1,
      },
    );
    watch.onUpdate(() => {});

    await flushRuntimeWatch();

    const first = watch.localQueryResult();
    expect(first?.results).toEqual([{ _id: "task-1" }]);
    expect(first?.status).toBe("CanLoadMore");
    expect(first?.loadMore(1)).toBe(true);
    expect(watch.localQueryResult()?.status).toBe("LoadingMore");

    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (watch.localQueryResult()?.results.length === 2) {
        break;
      }
    }

    const second = watch.localQueryResult();
    expect(second?.results).toEqual([{ _id: "task-1" }, { _id: "task-2" }]);
    expect(second?.status).toBe("Exhausted");
  });
});

describe("protocol auth", () => {
  it("uses verifyToken hook when provided", async () => {
    const identity = createTestIdentity({ subject: "verified" });
    const runtime = new EmbeddedRuntime({
      convex: { modules: { "_generated/api": async () => ({}) } },
      verifyToken: async (token) => (token === "good" ? identity : null),
    });

    const auth = (runtime as any)._buildProtocolAuth();
    await expect(auth.verifyToken("good")).resolves.toEqual({
      identity,
      identityKey: identity.tokenIdentifier,
    });
    await expect(auth.verifyToken("bad")).rejects.toThrow(/rejected/);

    runtime.shutdown();
  });
});

describe("executeLocal system mutation", () => {
  it("runs a system function and commits", async () => {
    await runtime.hydrate();

    // Insert an ID mapping via the system mutation
    await runtime.executeLocal({
      kind: "mutation",
      path: "_system:idMapSet",
      args: {
        localId: "local-abc",
        remoteId: "remote-xyz",
        table: "users",
      },
      applyLocalEffects: false,
    });

    // Verify the mapping was committed by querying it back
    const result = await runtime.executeLocal({
      kind: "query",
      path: "_system:idMapGet",
      args: {
        localId: "local-abc",
      },
    });

    expect(result).toBe("remote-xyz");
  });

  it("claims persisted sql-backed pending entries through system mutations", async () => {
    const { storage, readSource } = createSqlStorage({
      _resolve_pending: [
        {
          _id: "pending-1",
          _creationTime: 1,
          createdAt: 1,
          ref: "tasks:create",
          args: JSON.stringify({ title: "hello" }),
          localResult: JSON.stringify({ ok: true }),
          table: "tasks",
          payloadVersion: 1,
          identityKey: "user:a",
          state: "pending",
        },
      ],
    });
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter(storage),
    });

    try {
      localRuntime.db.setReadBackendForTests(storage);
      await localRuntime.hydrate();

      const claimed = (await localRuntime.executeLocal({
        kind: "mutation",
        path: "_system:pendingClaimNext",
        args: {
          identityKey: "user:a",
          owner: "processor-a",
          leaseMs: 1000,
        },
        applyLocalEffects: false,
      })) as Record<string, unknown> | null;

      expect(claimed?._id).toBe("pending-1");
      expect(claimed?.state).toBe("processing");
      expect(claimed?.owner).toBe("processor-a");
      expect(typeof claimed?.leaseExpiresAt).toBe("number");

      const pending = (await localRuntime.executeLocal({
        kind: "query",
        path: "_system:pendingGetAll",
        args: { identityKey: "user:a" },
      })) as Array<Record<string, unknown>>;

      expect(pending).toHaveLength(1);
      expect(pending[0]?._id).toBe("pending-1");
      expect(pending[0]?.state).toBe("processing");
      expect(pending[0]?.owner).toBe("processor-a");
      // Phase 1: hydrated tables serve reads from RAM, so the SQL source
      // pushdown is no longer the primary path. The data correctness checks
      // above are what matter.
    } finally {
      localRuntime.shutdown();
    }
  });

  it("updates sql-backed collection and document metadata through system mutations", async () => {
    const { storage, readSource } = createSqlStorage({
      _resolve_collection_metadata: [],
      _resolve_document_metadata: [],
    });
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter(storage),
    });

    try {
      localRuntime.db.setReadBackendForTests(storage);
      await localRuntime.hydrate();

      await localRuntime.executeLocal({
        kind: "mutation",
        path: "_system:collectionMetadataSet",
        args: {
          collection: "tasks",
          seq: 11,
          identityKey: "user:a",
          schemaVersion: 1,
        },
        applyLocalEffects: false,
      });
      await localRuntime.executeLocal({
        kind: "mutation",
        path: "_system:documentMetadataSetBatch",
        args: {
          collection: "tasks",
          entries: [{ docId: "task-1", seq: 4 }],
          identityKey: "user:a",
          schemaVersion: 1,
        },
        applyLocalEffects: false,
      });

      const collectionSeq = await localRuntime.executeLocal({
        kind: "query",
        path: "_system:collectionMetadataGet",
        args: {
          collection: "tasks",
          identityKey: "user:a",
          schemaVersion: 1,
        },
      });
      const docMetadata = await localRuntime.executeLocal({
        kind: "query",
        path: "_system:documentMetadataGetBatch",
        args: {
          collection: "tasks",
          docIds: ["task-1"],
          identityKey: "user:a",
          schemaVersion: 1,
        },
      });

      expect(collectionSeq).toBe(11);
      expect(docMetadata).toEqual([{ docId: "task-1", seq: 4 }]);

      await localRuntime.executeLocal({
        kind: "mutation",
        path: "_system:documentMetadataDeleteBatch",
        args: {
          collection: "tasks",
          docIds: ["task-1"],
          identityKey: "user:a",
          schemaVersion: 1,
        },
        applyLocalEffects: false,
      });

      const afterDelete = await localRuntime.executeLocal({
        kind: "query",
        path: "_system:documentMetadataGetBatch",
        args: {
          collection: "tasks",
          docIds: ["task-1"],
          identityKey: "user:a",
          schemaVersion: 1,
        },
      });
      expect(afterDelete).toEqual([]);

      await localRuntime.executeLocal({
        kind: "mutation",
        path: "_system:documentMetadataSetBatch",
        args: {
          collection: "tasks",
          entries: [{ docId: "task-2", seq: 5 }],
          identityKey: "user:a",
          schemaVersion: 1,
        },
        applyLocalEffects: false,
      });
      await localRuntime.executeLocal({
        kind: "mutation",
        path: "_system:documentMetadataClearCollection",
        args: {
          collection: "tasks",
          identityKey: "user:a",
          schemaVersion: 1,
        },
        applyLocalEffects: false,
      });

      const afterClear = await localRuntime.executeLocal({
        kind: "query",
        path: "_system:documentMetadataGetBatch",
        args: {
          collection: "tasks",
          docIds: ["task-2"],
          identityKey: "user:a",
          schemaVersion: 1,
        },
      });
      expect(afterClear).toEqual([]);
      // Phase 1: hydrated tables serve reads from RAM, so the SQL source
      // pushdown is no longer the primary path. The data correctness checks
      // above are what matter.
    } finally {
      localRuntime.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe("shutdown", () => {
  it("is idempotent", () => {
    runtime.shutdown();
    // Second call should not throw
    expect(() => runtime.shutdown()).not.toThrow();
  });

  it("clears all transports", async () => {
    const transport = runtime.createTransport();
    const ws = new transport.webSocketConstructor("ws://localhost");

    // Flush microtask so the WebSocket opens
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ws.readyState).toBe(1); // OPEN

    runtime.shutdown();

    expect(ws.readyState).toBe(3); // CLOSED
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("setIdentity", () => {
  it("delegates to auth resolver", async () => {
    const identity = {
      subject: "user-42",
      issuer: "https://test.local",
      tokenIdentifier: "https://test.local|user-42",
      name: "Alice",
    };

    runtime.setIdentity(identity);

    const resolved = await runtime.auth.getUserIdentity();
    expect(resolved).toEqual(identity);

    // Clear it
    runtime.setIdentity(null);
    const cleared = await runtime.auth.getUserIdentity();
    expect(cleared).toBeNull();
  });
});
