import { BrowserWriteBroadcast } from "@embedded/browser/write";
import type { ConvexModuleRegistry } from "@embedded/kernel/modules";
import type { AsyncReadBackend } from "@embedded/runtime/db/backend";
import {
  RUNTIME_SYSTEM_TABLES,
  type DatabaseCommitResult,
} from "@embedded/runtime/db/database";
import type {
  DocumentId,
  QueryDependency,
  Source,
  StoredDocument,
} from "@embedded/runtime/db/types";
import { EmbeddedRuntime } from "@embedded/runtime/embedded";
import { LocalQueryEvaluationError } from "@embedded/runtime/registry";
import type { Definition } from "@embedded/shared/schema";
import type {
  WriteBatch,
  WriteOptions,
  WriteResult,
} from "@embedded/storage/adapter";
import { createTestIdentity } from "@embedded/test";
import { mockAdapter, type OpaqueTestAdapter } from "@tests/helpers/adapter";
import { flushMicrotasks } from "@tests/helpers/time";
import { it as itBase, describe, expect, vi } from "@tests/testkit";
import { makeFunctionReference } from "convex/server";

// ---------------------------------------------------------------------------
// Mock BroadcastChannel
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

  postMessage(data: unknown): void {
    if (this._closed) return;
    for (const inst of MockBroadcastChannel.instances) {
      if (
        inst !== this &&
        inst.name === this.name &&
        !inst._closed &&
        inst.onmessage
      ) {
        inst.onmessage(new MessageEvent("message", { data }));
      }
    }
  }

  close(): void {
    this._closed = true;
  }

  static reset(): void {
    MockBroadcastChannel.instances = [];
  }
}

// ---------------------------------------------------------------------------
// Private members reached into by watch/auth tests.
// ---------------------------------------------------------------------------

interface LocalEvaluation {
  result: unknown;
  tablesRead: Set<string>;
  dependencies: QueryDependency[];
}

interface PaginatedEvaluation {
  result: { page: unknown[]; isDone: boolean; continueCursor: string };
  tablesRead: Set<string>;
  dependencies: QueryDependency[];
}

interface VerifiedIdentity {
  identity: ReturnType<typeof createTestIdentity>;
  identityKey: string;
}

interface RuntimeInternals {
  _evaluateLocalQuery(
    pathName: string,
    args: Record<string, unknown>,
  ): Promise<LocalEvaluation>;
  _evaluateLocalPaginatedPage(
    pathName: string,
    args: Record<string, unknown>,
    cursor: string | null,
    numItems: number,
  ): Promise<PaginatedEvaluation>;
  _buildProtocolAuth(): {
    verifyToken(token: string): Promise<VerifiedIdentity>;
  };
  _crossTabSyncChain: Promise<void>;
}

function internals(runtime: EmbeddedRuntime): RuntimeInternals {
  return runtime as unknown as RuntimeInternals;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_MODULES: ConvexModuleRegistry = {
  "_generated/api": () => Promise.resolve({}),
};

function createMockSchema(overrides?: Partial<Definition>): Definition {
  return {
    version: 1,
    shape: { title: "string" },
    defaults: {},
    migrations: {},
    getShape: () => ({ title: "string" }),
    getCrdtFields: () => new Map(),
    getOmittedFields: () => [],
    ...overrides,
  };
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

type RowsByTable = Record<string, StoredDocument[]>;

function createSqlStorage(rowsByTable: RowsByTable): {
  storage: OpaqueTestAdapter;
  list: ReturnType<
    typeof vi.fn<(tableName: string) => Promise<StoredDocument[]>>
  >;
  readSource: ReturnType<
    typeof vi.fn<(source: Source) => Promise<StoredDocument[]>>
  >;
  getDocument: ReturnType<
    typeof vi.fn<
      (tableName: string, id: string) => Promise<StoredDocument | null>
    >
  >;
} {
  const getDocument = vi.fn(async (tableName: string, id: string) => {
    return (
      rowsByTable[tableName]?.find((row) => String(row._id) === id) ?? null
    );
  });
  const getTableDocuments = vi.fn(async (tableName: string) => [
    ...(rowsByTable[tableName] ?? []),
  ]);
  const countDocuments = vi.fn(
    async (tableName: string) => rowsByTable[tableName]?.length ?? 0,
  );
  const readSource = vi.fn(
    async (source: Source): Promise<StoredDocument[]> => {
      const tableName =
        source.type === "FullTableScan"
          ? source.tableName
          : (source.indexName.split(".")[0] ?? source.indexName);
      let rows = [...(rowsByTable[tableName] ?? [])];
      if (source.type === "IndexRange") {
        rows = rows.filter((row) =>
          source.range.every(
            (entry) =>
              entry.type !== "Eq" || row[entry.fieldPath] === entry.value,
          ),
        );
      }
      return rows;
    },
  );

  const storage = mockAdapter({
    kind: "sql",
    getDocuments: async (table?: string) =>
      table === undefined
        ? Object.entries(rowsByTable).flatMap(([tableName, docs]) =>
            docs.map((doc) => ({ tableName, doc })),
          )
        : getTableDocuments(table),
    getDocument,
    hasDocuments: async (tableName: string) =>
      (rowsByTable[tableName]?.length ?? 0) > 0,
    getMetadata: async () => ({ timestamp: 0, lastCreationTime: 0 }),
    countDocuments,
    source: readSource,
    query: async () => null,
    listBlobs: async () => [],
    getBlob: async () => null,
    write: async (batch: WriteBatch, opts?: WriteOptions) => {
      for (const put of batch.puts) {
        const tableRows = rowsByTable[put.tableName] ?? [];
        rowsByTable[put.tableName] = [
          ...tableRows.filter((row) => row._id !== put.doc._id),
          put.doc,
        ];
      }
      for (const deletion of batch.deletes) {
        rowsByTable[deletion.tableName] = (
          rowsByTable[deletion.tableName] ?? []
        ).filter((row) => String(row._id) !== deletion.id);
      }
      if (opts) {
        const result: WriteResult = {
          meta: batch.meta,
          tables: (opts.materializedTables ?? []).map((tableName) => ({
            tableName,
            docs: rowsByTable[tableName] ?? [],
          })),
        };
        return result;
      }
    },
    storeBlob: async () => undefined,
    deleteBlob: async () => undefined,
    clearAll: async () => undefined,
  });

  return { storage, list: getTableDocuments, readSource, getDocument };
}

function doc(id: string, fields: Record<string, unknown>): StoredDocument {
  return { _id: id as StoredDocument["_id"], _creationTime: 1, ...fields };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface EmbeddedFixtures {
  /** Mock BroadcastChannel installed for the test, auto-restored. */
  broadcast: typeof MockBroadcastChannel;
  /** A default (un-hydrated) runtime backed by {@link STUB_MODULES}. */
  runtime: EmbeddedRuntime;
}

const it = itBase.extend<EmbeddedFixtures>({
  broadcast: async ({ onTestFinished }, use) => {
    MockBroadcastChannel.reset();
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
    onTestFinished(() => {
      vi.unstubAllGlobals();
      MockBroadcastChannel.reset();
    });
    await use(MockBroadcastChannel);
  },
  runtime: async ({ broadcast: _broadcast, onTestFinished }, use) => {
    const runtime = new EmbeddedRuntime({ convex: { modules: STUB_MODULES } });
    onTestFinished(() => runtime.shutdown());
    await use(runtime);
  },
});

function makeCommit(
  overrides: Partial<DatabaseCommitResult> = {},
): DatabaseCommitResult {
  return {
    tablesWritten: new Set(),
    invalidation: { tables: new Set(), changes: [] },
    persisted: Promise.resolve(),
    timestamp: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("Construction", () => {
  it("creates without errors with empty modules", ({ runtime }) => {
    expect(runtime).toBeDefined();
  });

  it("exposes all subsystems as public readonly fields", ({ runtime }) => {
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

  it("surfaces storage hydration failures instead of swallowing them", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const failingRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter({
        kind: "opaque",
        getDocuments: async (table?: string) => {
          if (table === undefined) {
            throw new Error("boom");
          }
          return [];
        },
        getMetadata: async () => null,
        listBlobs: async () => [],
        write: async () => undefined,
        storeBlob: async () => undefined,
        deleteBlob: async () => undefined,
        clearAll: async () => undefined,
      }),
    });
    onTestFinished(() => failingRuntime.shutdown());

    await expect(failingRuntime.hydrate()).rejects.toThrow("boom");
  });
});

describe("Action execution", () => {
  it("serializes top-level actions", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
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
    onTestFinished(() => serialRuntime.shutdown());

    const first = serialRuntime.executeLocal({
      kind: "action",
      path: "api:first",
      args: {},
    });
    await flushMicrotasks(10);
    const second = serialRuntime.executeLocal({
      kind: "action",
      path: "api:second",
      args: {},
    });
    await flushMicrotasks(10);

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
  });
});

describe("Blob storage", () => {
  it("rolls back metadata when durable blob storage fails", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const blobRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter({
        kind: "opaque",
        getDocuments: async () => [],
        getMetadata: async () => ({ timestamp: 0, lastCreationTime: 0 }),
        listBlobs: async () => [],
        write: async () => undefined,
        storeBlob: async () => {
          throw new Error("disk full");
        },
        deleteBlob: async () => undefined,
        clearAll: async () => undefined,
      }),
    });
    onTestFinished(() => blobRuntime.shutdown());

    await blobRuntime.hydrate();
    await expect(
      blobRuntime.storeUploadedBlob(new Blob(["data"])),
    ).rejects.toThrow("disk full");
    expect(blobRuntime.db.getDocumentsForTable("_storage")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// handleMessage
// ---------------------------------------------------------------------------

describe("handleMessage", () => {
  it("returns FatalError ServerMessage for invalid JSON", async ({
    runtime,
  }) => {
    await runtime.hydrate();

    const responses = await runtime.handleMessage("not valid json {{{");

    expect(responses).toHaveLength(1);
    const parsed = JSON.parse(responses[0]!) as { type: string; error: string };
    expect(parsed.type).toBe("FatalError");
    expect(parsed.error).toBe("Invalid JSON");
  });

  it("routes valid Authenticate message through protocol", async ({
    runtime,
  }) => {
    await runtime.hydrate();

    await runtime.handleMessage(
      JSON.stringify({
        type: "Connect",
        sessionId: "s1",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      }),
    );

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
    const parsed = JSON.parse(responses[0]!) as { type: string };
    expect(parsed.type).toBe("Transition");
  });

  it("returns serialized ServerMessage array", async ({ runtime }) => {
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
    for (const response of responses) {
      expect(typeof response).toBe("string");
      const parsed = JSON.parse(response) as { type: unknown };
      expect(typeof parsed.type).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Mutation commit
// ---------------------------------------------------------------------------

describe("onMutationCommit", () => {
  it("invalidates subscriptions for written tables", ({ runtime }) => {
    const cb = vi.fn();
    runtime.subscriptions.subscribe("q1", new Set(["users"]), cb);

    runtime.onMutationCommit(
      makeCommit({
        tablesWritten: new Set(["users"]),
        invalidation: { tables: new Set(["users"]), changes: [] },
        timestamp: 1,
      }),
    );

    expect(cb).toHaveBeenCalledOnce();
  });

  it("is no-op for empty tablesWritten", ({ runtime }) => {
    const cb = vi.fn();
    runtime.subscriptions.subscribe("q1", new Set(["users"]), cb);

    runtime.onMutationCommit(makeCommit());

    expect(cb).not.toHaveBeenCalled();
  });

  it("delays cross-tab fanout until storage settles", async ({ runtime }) => {
    const persisted = deferredPromise<void>();
    const notifySpy = vi.spyOn(runtime.writeFanout, "notify");

    runtime.onMutationCommit(
      makeCommit({
        tablesWritten: new Set(["users"]),
        invalidation: { tables: new Set(["users"]), changes: [] },
        persisted: persisted.promise,
        timestamp: 1,
      }),
    );

    await flushMicrotasks();
    expect(notifySpy).not.toHaveBeenCalled();

    persisted.resolve();
    await flushMicrotasks(10);

    expect(notifySpy).toHaveBeenCalledWith(new Set(["users"]));
  });

  it("skips cross-tab fanout when storage fails", async ({ runtime }) => {
    const notifySpy = vi.spyOn(runtime.writeFanout, "notify");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    runtime.onMutationCommit(
      makeCommit({
        tablesWritten: new Set(["users"]),
        invalidation: { tables: new Set(["users"]), changes: [] },
        persisted: Promise.reject(new Error("disk full")),
        timestamp: 1,
      }),
    );

    await flushMicrotasks();

    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("cross-tab fanout refreshes another runtime after storage settles", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const runtimeA = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      writeBroadcast: new BrowserWriteBroadcast("shared-runtime"),
    });
    const runtimeB = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      writeBroadcast: new BrowserWriteBroadcast("shared-runtime"),
    });
    onTestFinished(() => {
      runtimeA.shutdown();
      runtimeB.shutdown();
    });

    await runtimeA.hydrate();
    await runtimeB.hydrate();

    const syncSpy = vi.spyOn(runtimeB.db, "syncTable").mockResolvedValue();
    const reevalSpy = vi
      .spyOn(runtimeB.syncProtocol, "reEvaluateQueries")
      .mockResolvedValue(new Map());
    runtimeA.onMutationCommit(
      makeCommit({
        tablesWritten: new Set(["tasks"]),
        invalidation: { tables: new Set(["tasks"]), changes: [] },
        timestamp: 1,
      }),
    );

    await flushMicrotasks(10);

    expect(syncSpy).toHaveBeenCalledWith("tasks");
    expect(reevalSpy).toHaveBeenCalledWith([
      { tableName: "tasks", before: null, after: null },
    ]);
  });

  it("multiple cross-tab commits converge on the latest runtime refresh", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const runtimeA = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      writeBroadcast: new BrowserWriteBroadcast("shared-runtime-burst"),
    });
    const runtimeB = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      writeBroadcast: new BrowserWriteBroadcast("shared-runtime-burst"),
    });
    onTestFinished(() => {
      runtimeA.shutdown();
      runtimeB.shutdown();
    });

    await runtimeA.hydrate();
    await runtimeB.hydrate();

    const syncSpy = vi.spyOn(runtimeB.db, "syncTable").mockResolvedValue();
    runtimeA.onMutationCommit(
      makeCommit({
        tablesWritten: new Set(["tasks"]),
        invalidation: { tables: new Set(["tasks"]), changes: [] },
        timestamp: 1,
      }),
    );
    runtimeA.onMutationCommit(
      makeCommit({
        tablesWritten: new Set(["tasks"]),
        invalidation: { tables: new Set(["tasks"]), changes: [] },
        timestamp: 2,
      }),
    );

    await flushMicrotasks(10);
    await internals(runtimeB)._crossTabSyncChain;

    expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("transaction locking", () => {
  it("serializes concurrent top-level mutations", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const releaseFirst = deferredPromise<void>();
    const firstStarted = deferredPromise<void>();
    const order: string[] = [];
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
                  firstStarted.resolve();
                  await releaseFirst.promise;
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
    onTestFinished(() => localRuntime.shutdown());

    await localRuntime.hydrate();

    const first = localRuntime.executeLocal({
      kind: "mutation",
      path: "tasks:create",
      args: {},
      applyLocalEffects: false,
    });
    await flushMicrotasks();
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

    await firstStarted.promise;

    expect(secondResolved).toBe(false);

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });
});

describe("sql storage hydration", () => {
  it("does NOT eager-hydrate sql-backed user tables at open (lazy)", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const getDocumentsByTable = vi.fn(async () => []);
    const getAllDocuments = vi.fn(async () => []);
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter({
        kind: "sql",
        getDocuments: async (table?: string) =>
          table === undefined ? getAllDocuments() : getDocumentsByTable(),
        getDocument: async () => null,
        hasDocuments: async () => false,
        getMetadata: async () => ({ timestamp: 0, lastCreationTime: 0 }),
        countDocuments: async () => 0,
        source: async () => [],
        query: async () => [],
        listBlobs: async () => [],
        getBlob: async () => null,
        write: async () => undefined,
        storeBlob: async () => undefined,
        deleteBlob: async () => undefined,
        clearAll: async () => undefined,
      }),
    });
    onTestFinished(() => localRuntime.shutdown());

    await localRuntime.hydrate();

    // Open hydrates system tables only — never a no-arg full load, never the
    // user `tasks` table.
    expect(getAllDocuments).not.toHaveBeenCalled();
    expect(getDocumentsByTable).not.toHaveBeenCalledWith("tasks");
    expect(localRuntime.db.isTableHydrationAttempted("tasks")).toBe(false);
  });

  it("hydrates system tables (by name) at open, not user tables", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const tablesLoadedByName: string[] = [];
    const getAllDocuments = vi.fn(async () => []);
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter({
        kind: "sql",
        getDocuments: async (table?: string) => {
          if (table === undefined) return getAllDocuments();
          tablesLoadedByName.push(table);
          return [];
        },
        getDocument: async () => null,
        hasDocuments: async () => false,
        getMetadata: async () => ({ timestamp: 0, lastCreationTime: 0 }),
        countDocuments: async () => 0,
        source: async () => [],
        query: async () => [],
        listBlobs: async () => [],
        getBlob: async () => null,
        write: async () => undefined,
        storeBlob: async () => undefined,
        deleteBlob: async () => undefined,
        clearAll: async () => undefined,
      }),
    });
    onTestFinished(() => localRuntime.shutdown());

    await localRuntime.hydrate();

    expect(getAllDocuments).not.toHaveBeenCalled();
    expect(tablesLoadedByName).toContain("_resolve_id_map");
    expect(tablesLoadedByName.every((t) => t.startsWith("_"))).toBe(true);
  });

  it("RUNTIME_SYSTEM_TABLES covers replay/scheduled/metadata and is all system tables", () => {
    expect(RUNTIME_SYSTEM_TABLES.every((t) => t.startsWith("_"))).toBe(true);
    // Tables read at open / required for correctness must be eagerly hydrated.
    for (const required of [
      "_resolve_pending",
      "_resolve_pending_uploads",
      "_resolve_id_map",
      "_resolve_processors",
      "_resolve_collection_metadata",
      "_resolve_document_metadata",
      "_resolve_schema_versions",
      "_resolve_store_versions",
      "_resolve_auth_state",
      "_scheduled_functions",
      "_storage",
    ]) {
      expect(RUNTIME_SYSTEM_TABLES).toContain(required);
    }
  });

  it("tableHydrated resolves immediately for queryable user tables (no gate hang)", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const { storage } = createSqlStorage({});
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage,
    });
    onTestFinished(() => localRuntime.shutdown());

    await localRuntime.hydrate();

    // The user table is not hydrated under lazy hydration, but the per-table
    // gate must resolve (reads are served by push-down) — never hang.
    const outcome = await Promise.race([
      localRuntime.db.tableHydrated("tasks").then(() => "resolved" as const),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 50),
      ),
    ]);
    expect(outcome).toBe("resolved");
  });
});

// ---------------------------------------------------------------------------
// Document ingestion
// ---------------------------------------------------------------------------

describe("ingestDocuments", () => {
  it("inserts new documents", async ({ runtime }) => {
    await runtime.hydrate();

    await runtime.ingestDocuments("tasks", [
      { _id: "id1", _creationTime: 1, title: "Task A" },
      { _id: "id2", _creationTime: 2, title: "Task B" },
    ]);

    const docs = await runtime.getDocumentsForTable("tasks");
    expect(docs).toHaveLength(2);

    const titles = docs
      .map((d) => String(d.title))
      .sort((a, b) => a.localeCompare(b));
    expect(titles).toEqual(["Task A", "Task B"]);
  });

  it("deletes documents missing from remote", async ({ runtime }) => {
    await runtime.hydrate();

    await runtime.ingestDocuments("tasks", [
      { _id: "id1", _creationTime: 1, title: "Keep" },
      { _id: "id2", _creationTime: 2, title: "Remove" },
    ]);

    await runtime.ingestDocuments("tasks", [
      { _id: "id1", _creationTime: 1, title: "Keep" },
    ]);

    const docs = await runtime.getDocumentsForTable("tasks");
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe("Keep");
  });

  it("no-ops when documents are identical", async ({ runtime }) => {
    await runtime.hydrate();

    const remoteDocs = [{ _id: "id1", _creationTime: 1, title: "Same" }];

    await runtime.ingestDocuments("tasks", remoteDocs);

    const invalidateSpy = vi.spyOn(runtime.subscriptions, "invalidate");

    await runtime.ingestDocuments("tasks", remoteDocs);

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("re-evaluates queries with the ingested table name", async ({
    runtime,
  }) => {
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
  });

  it("scopes mirrored table contents by identity and anonymous namespace", async ({
    runtime,
  }) => {
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

  it("migrates anonymous mirrored data into an authenticated namespace", async ({
    runtime,
  }) => {
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

  it("canonicalizes a mapped create atomically across owning and referencing tables", async ({
    runtime,
  }) => {
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
// Lazy windowed ingest (Stage 3)
// ---------------------------------------------------------------------------

describe("lazy windowed ingest", () => {
  function seedLargeTable(): {
    storage: OpaqueTestAdapter;
    list: ReturnType<typeof createSqlStorage>["list"];
    getDocument: ReturnType<typeof createSqlStorage>["getDocument"];
  } {
    const rows = Array.from({ length: 50 }, (_, i) =>
      doc(`t${i}`, { title: `old ${i}` }),
    );
    const { storage, list, getDocument } = createSqlStorage({ tasks: rows });
    return { storage, list, getDocument };
  }

  it("reads only the candidate window, not the whole table, when deleteAbsent is false", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const { storage, list, getDocument } = seedLargeTable();
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage,
    });
    onTestFinished(() => localRuntime.shutdown());

    await localRuntime.hydrate();
    expect(localRuntime.db.isTableHydrationAttempted("tasks")).toBe(false);

    list.mockClear();
    getDocument.mockClear();

    await localRuntime.ingestDocuments(
      "tasks",
      [
        { _id: "t1", _creationTime: 1, title: "new 1" },
        { _id: "t99", _creationTime: 1, title: "brand new" },
      ],
      undefined,
      { deleteAbsent: false },
    );

    // The diff map is built from per-id push-down for exactly the window ids —
    // never a whole-table read.
    expect(list).not.toHaveBeenCalledWith("tasks");
    const taskGets = getDocument.mock.calls.filter(([t]) => t === "tasks");
    expect(taskGets.map(([, id]) => id).sort()).toEqual(["t1", "t99"]);
    // Still lazy after the windowed ingest.
    expect(localRuntime.db.isTableHydrationAttempted("tasks")).toBe(false);

    // The upsert committed for both the changed and the new document.
    const t1 = await localRuntime.db.getAsync("tasks", "t1" as DocumentId);
    const t99 = await localRuntime.db.getAsync("tasks", "t99" as DocumentId);
    expect(t1?.title).toBe("new 1");
    expect(t99?.title).toBe("brand new");
  });

  it("falls back to a whole-table read for a reconciling (delete-capable) ingest", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const { storage, list } = seedLargeTable();
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage,
    });
    onTestFinished(() => localRuntime.shutdown());

    await localRuntime.hydrate();
    list.mockClear();

    // No deleteAbsent: false — the reconcile must enumerate local ids to know
    // which documents are absent from the remote snapshot, so it reads the
    // whole (scoped) table.
    await localRuntime.ingestDocuments("tasks", [
      { _id: "t1", _creationTime: 1, title: "new 1" },
    ]);

    expect(list).toHaveBeenCalledWith("tasks");
  });
});

// ---------------------------------------------------------------------------
// Direct execution
// ---------------------------------------------------------------------------

describe("executeLocal query", () => {
  it("runs a system function", async ({ runtime }) => {
    await runtime.hydrate();

    const result = await runtime.executeLocal({
      kind: "query",
      path: "_system:idMapGetAll",
      args: {},
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("reads persisted sql-backed id map rows through system queries", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const { storage, list: getDocumentsByTable } = createSqlStorage({
      _resolve_id_map: [
        doc("map-1", {
          localId: "local-1",
          remoteId: "remote-1",
          table: "tasks",
          identityKey: "user:a",
        }),
      ],
    });
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage,
    });
    onTestFinished(() => localRuntime.shutdown());

    await localRuntime.hydrate();

    // System tables are hydrated eagerly at open (loaded by name).
    expect(getDocumentsByTable).toHaveBeenCalledWith("_resolve_id_map");
    const readsAfterOpen = getDocumentsByTable.mock.calls.filter(
      ([t]) => t === "_resolve_id_map",
    ).length;

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
    // The system query reads from memory — no additional sql read.
    expect(
      getDocumentsByTable.mock.calls.filter(([t]) => t === "_resolve_id_map")
        .length,
    ).toBe(readsAfterOpen);
  });

  it("reads sql-backed collection and document metadata through system queries", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const { storage, list: getDocumentsByTable } = createSqlStorage({
      _resolve_collection_metadata: [
        doc("collection-meta-1", {
          collection: "tasks",
          seq: 7,
          identityKey: "user:a",
          schemaVersion: 1,
        }),
      ],
      _resolve_document_metadata: [
        doc("doc-meta-1", {
          collection: "tasks",
          docId: "task-1",
          seq: 3,
          identityKey: "user:a",
          schemaVersion: 1,
        }),
      ],
    });
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage,
    });
    onTestFinished(() => localRuntime.shutdown());

    await localRuntime.hydrate();

    const collectionSeq = await localRuntime.executeLocal({
      kind: "query",
      path: "_system:collectionMetadataGet",
      args: { collection: "tasks", identityKey: "user:a", schemaVersion: 1 },
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
    // System metadata tables are hydrated eagerly at open; queries read memory.
    expect(getDocumentsByTable).toHaveBeenCalledWith(
      "_resolve_collection_metadata",
    );
    expect(getDocumentsByTable).toHaveBeenCalledWith(
      "_resolve_document_metadata",
    );
  });

  it("reads sql-backed auth state and pending identity keys through system queries", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const { storage } = createSqlStorage({
      _resolve_auth_state: [
        doc("auth-1", { activeIdentityKey: "user:a", updatedAt: 1 }),
      ],
      _resolve_pending: [
        doc("pending-1", {
          createdAt: 1,
          ref: "tasks:create",
          args: JSON.stringify({}),
          localResult: JSON.stringify(null),
          table: "tasks",
          payloadVersion: 1,
          identityKey: "user:b",
          state: "pending",
        }),
        doc("pending-2", {
          createdAt: 2,
          ref: "tasks:update",
          args: JSON.stringify({}),
          localResult: JSON.stringify(null),
          table: "tasks",
          payloadVersion: 1,
          identityKey: "user:a",
          state: "pending",
        }),
      ],
    });
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage,
    });
    onTestFinished(() => localRuntime.shutdown());

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
  });
});

describe("runtime query helpers", () => {
  it("queries through the public runtime facade", async ({ runtime }) => {
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

  it("paginates through the public runtime facade", async ({ runtime }) => {
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
        paginationOpts: { cursor: null, numItems: 10, id: -1 },
      },
    });
    expect(result).toEqual({
      page: [{ _id: "task-1" }],
      isDone: false,
      continueCursor: "cursor-2",
    });
  });
});

describe("watchLocalQuery", () => {
  it("waits for hydration before evaluating the first local result", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const gate =
      deferredPromise<Array<{ tableName: string; doc: StoredDocument }>>();
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter({
        kind: "opaque",
        getDocuments: async (table?: string) =>
          table === undefined ? gate.promise : [],
        getMetadata: async () => null,
        listBlobs: async () => [],
        write: async () => undefined,
        storeBlob: async () => undefined,
        deleteBlob: async () => undefined,
        clearAll: async () => undefined,
      }),
    });
    onTestFinished(() => localRuntime.shutdown());

    const evaluateSpy = vi
      .spyOn(internals(localRuntime), "_evaluateLocalQuery")
      .mockResolvedValue({
        result: [{ _id: "task-1" }],
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      });

    const watch = localRuntime.watchLocalQuery("tasks:list", {});

    await flushMicrotasks(10);

    expect(evaluateSpy).not.toHaveBeenCalled();
    expect(watch.localQueryResult()).toBeUndefined();

    gate.resolve([]);
    await localRuntime.hydrate();
    await flushMicrotasks(10);

    expect(evaluateSpy).toHaveBeenCalledWith("tasks:list", {});
    expect(watch.localQueryResult()).toEqual([{ _id: "task-1" }]);
  });

  it("returns undefined until the first evaluation completes", async ({
    runtime,
  }) => {
    await runtime.hydrate();

    const evaluateSpy = vi
      .spyOn(internals(runtime), "_evaluateLocalQuery")
      .mockResolvedValue({
        result: [{ _id: "task-1" }],
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      });

    const watch = runtime.watchLocalQuery("tasks:list", {});

    expect(watch.localQueryResult()).toBeUndefined();

    await flushMicrotasks(10);

    expect(evaluateSpy).toHaveBeenCalledWith("tasks:list", {});
    expect(watch.localQueryResult()).toEqual([{ _id: "task-1" }]);
  });

  it("notifies listeners asynchronously when a cached result already exists", async ({
    runtime,
  }) => {
    await runtime.hydrate();

    vi.spyOn(internals(runtime), "_evaluateLocalQuery").mockResolvedValue({
      result: [{ _id: "task-1" }],
      tablesRead: new Set(["tasks"]),
      dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
    });

    const watch = runtime.watchLocalQuery("tasks:list", {});
    await flushMicrotasks(10);

    const callback = vi.fn();
    watch.onUpdate(callback);

    expect(callback).not.toHaveBeenCalled();

    await flushMicrotasks(10);

    expect(callback).toHaveBeenCalledOnce();
    expect(watch.localQueryResult()).toEqual([{ _id: "task-1" }]);
  });

  it("does not miss the first callback when subscribed before hydration completes", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const gate =
      deferredPromise<Array<{ tableName: string; doc: StoredDocument }>>();
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage: mockAdapter({
        kind: "opaque",
        getDocuments: async (table?: string) =>
          table === undefined ? gate.promise : [],
        getMetadata: async () => null,
        listBlobs: async () => [],
        write: async () => undefined,
        storeBlob: async () => undefined,
        deleteBlob: async () => undefined,
        clearAll: async () => undefined,
      }),
    });
    onTestFinished(() => localRuntime.shutdown());

    vi.spyOn(internals(localRuntime), "_evaluateLocalQuery").mockResolvedValue({
      result: [{ _id: "task-1" }],
      tablesRead: new Set(["tasks"]),
      dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
    });

    const watch = localRuntime.watchLocalQuery("tasks:list", {});
    const callback = vi.fn();
    watch.onUpdate(callback);

    gate.resolve([]);
    await localRuntime.hydrate();
    await flushMicrotasks(10);

    expect(callback).toHaveBeenCalledOnce();
    expect(watch.localQueryResult()).toEqual([{ _id: "task-1" }]);
  });

  it("re-evaluates after matching local writes invalidate tracked dependencies", async ({
    runtime,
  }) => {
    await runtime.hydrate();

    const evaluateSpy = vi
      .spyOn(internals(runtime), "_evaluateLocalQuery")
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

    await flushMicrotasks(10);
    expect(callback).toHaveBeenCalledTimes(1);

    runtime.onMutationCommit(
      makeCommit({
        tablesWritten: new Set(["tasks"]),
        invalidation: { tables: new Set(["tasks"]), changes: [] },
        timestamp: 1,
      }),
    );

    await vi.waitFor(() => expect(evaluateSpy).toHaveBeenCalledTimes(2));

    expect(callback).toHaveBeenCalledTimes(2);
    expect(watch.localQueryResult()).toEqual([
      { _id: "task-1", title: "after" },
    ]);
  });

  it("re-evaluates a thrown query once its partial-read tables are invalidated", async ({
    runtime,
  }) => {
    await runtime.hydrate();

    const evaluateSpy = vi
      .spyOn(internals(runtime), "_evaluateLocalQuery")
      .mockRejectedValueOnce(
        new LocalQueryEvaluationError(
          new Error("Project not found"),
          new Set(["projects"]),
          [{ type: "FullTableScan", tableName: "projects" }],
        ),
      )
      .mockResolvedValueOnce({
        result: [{ _id: "issue-1" }],
        tablesRead: new Set(["projects", "issues"]),
        dependencies: [
          { type: "FullTableScan", tableName: "projects" },
          { type: "FullTableScan", tableName: "issues" },
        ],
      });

    const watch = runtime.watchLocalQuery("issues:forProject", {
      projectId: "p1",
    });
    const callback = vi.fn();
    watch.onUpdate(callback);

    await flushMicrotasks(10);
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    expect(() => watch.localQueryResult()).toThrow("Project not found");

    runtime.onMutationCommit(
      makeCommit({
        tablesWritten: new Set(["projects"]),
        invalidation: {
          tables: new Set(["projects"]),
          changes: [
            {
              tableName: "projects",
              before: null,
              after: { _id: "p1" } as unknown as StoredDocument,
            },
          ],
        },
        timestamp: 1,
      }),
    );

    await vi.waitFor(() => expect(evaluateSpy).toHaveBeenCalledTimes(2));
    expect(watch.localQueryResult()).toEqual([{ _id: "issue-1" }]);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("recovers when a dep table is ingested mid-eval, before partial-deps are wired", async ({
    runtime,
  }) => {
    await runtime.hydrate();

    const evaluateSpy = vi
      .spyOn(internals(runtime), "_evaluateLocalQuery")
      .mockImplementationOnce(async () => {
        runtime.onMutationCommit(
          makeCommit({
            tablesWritten: new Set(["projects"]),
            invalidation: {
              tables: new Set(["projects"]),
              changes: [
                {
                  tableName: "projects",
                  before: null,
                  after: { _id: "p1" } as unknown as StoredDocument,
                },
              ],
            },
            timestamp: 1,
          }),
        );
        throw new LocalQueryEvaluationError(
          new Error("Project not found"),
          new Set(["projects"]),
          [{ type: "DocumentRead", tableName: "projects", id: "p1" }],
        );
      })
      .mockResolvedValueOnce({
        result: [{ _id: "issue-1" }],
        tablesRead: new Set(["projects", "issues"]),
        dependencies: [
          { type: "DocumentRead", tableName: "projects", id: "p1" },
          { type: "FullTableScan", tableName: "issues" },
        ],
      });

    const watch = runtime.watchLocalQuery("issues:forProject", {
      projectId: "p1",
    });
    watch.onUpdate(() => {});

    await vi.waitFor(() => expect(evaluateSpy).toHaveBeenCalledTimes(2));
    expect(watch.localQueryResult()).toEqual([{ _id: "issue-1" }]);
  });

  it("updates local watches before storage settles for cold sql-backed tables", async ({
    runtime,
  }) => {
    await runtime.hydrate();

    const evaluateSpy = vi
      .spyOn(internals(runtime), "_evaluateLocalQuery")
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

    await flushMicrotasks(10);
    expect(callback).toHaveBeenCalledTimes(1);

    const persisted = deferredPromise<void>();
    runtime.onMutationCommit(
      makeCommit({
        tablesWritten: new Set(["tasks"]),
        invalidation: { tables: new Set(["tasks"]), changes: [] },
        persisted: persisted.promise,
        timestamp: 1,
      }),
    );

    await flushMicrotasks(10);

    expect(evaluateSpy).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(watch.localQueryResult()).toEqual([
      { _id: "task-1", title: "after" },
    ]);

    persisted.resolve();
    await flushMicrotasks(10);

    expect(evaluateSpy).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("throws the latest evaluation error from localQueryResult", async ({
    runtime,
  }) => {
    await runtime.hydrate();

    vi.spyOn(internals(runtime), "_evaluateLocalQuery").mockRejectedValue(
      new Error("watch failed"),
    );

    const watch = runtime.watchLocalQuery("tasks:list", {});
    const callback = vi.fn();
    watch.onUpdate(callback);

    await flushMicrotasks(10);

    expect(callback).toHaveBeenCalledOnce();
    expect(() => watch.localQueryResult()).toThrow("watch failed");
    expect(watch.localQueryLogs()).toEqual(["watch failed"]);
  });
});

describe("watchLocalPaginatedQuery", () => {
  it("builds a paginated local result and supports loadMore", async ({
    runtime,
  }) => {
    await runtime.hydrate();

    vi.spyOn(
      internals(runtime),
      "_evaluateLocalPaginatedPage",
    ).mockImplementation(async (_pathName, _args, cursor) => ({
      result:
        cursor === null
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
    }));

    const watch = runtime.watchLocalPaginatedQuery(
      "tasks:list",
      {},
      { initialNumItems: 1 },
    );
    watch.onUpdate(() => {});

    await flushMicrotasks(10);

    const first = watch.localQueryResult();
    expect(first?.results).toEqual([{ _id: "task-1" }]);
    expect(first?.status).toBe("CanLoadMore");
    expect(first?.loadMore(1)).toBe(true);
    expect(watch.localQueryResult()?.status).toBe("LoadingMore");

    await vi.waitFor(() =>
      expect(watch.localQueryResult()?.results).toHaveLength(2),
    );

    const second = watch.localQueryResult();
    expect(second?.results).toEqual([{ _id: "task-1" }, { _id: "task-2" }]);
    expect(second?.status).toBe("Exhausted");
  });

  it("re-evaluates a paginated watch that threw once partial-read tables ingest", async ({
    runtime,
  }) => {
    await runtime.hydrate();

    const spy = vi
      .spyOn(internals(runtime), "_evaluateLocalPaginatedPage")
      .mockRejectedValueOnce(
        new LocalQueryEvaluationError(
          new Error("Project not found"),
          new Set(["projects"]),
          [{ type: "DocumentRead", tableName: "projects", id: "p1" }],
        ),
      )
      .mockResolvedValueOnce({
        result: {
          page: [{ _id: "issue-1" }],
          isDone: true,
          continueCursor: "_end_cursor",
        },
        tablesRead: new Set(["projects", "issues"]),
        dependencies: [
          { type: "DocumentRead", tableName: "projects", id: "p1" },
          { type: "FullTableScan", tableName: "issues" },
        ],
      });

    const watch = runtime.watchLocalPaginatedQuery(
      "issues:forProject",
      { projectId: "p1" },
      { initialNumItems: 50 },
    );
    const callback = vi.fn();
    watch.onUpdate(callback);

    await flushMicrotasks(10);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(() => watch.localQueryResult()).toThrow("Project not found");

    runtime.onMutationCommit(
      makeCommit({
        tablesWritten: new Set(["projects"]),
        invalidation: {
          tables: new Set(["projects"]),
          changes: [
            {
              tableName: "projects",
              before: null,
              after: { _id: "p1" } as unknown as StoredDocument,
            },
          ],
        },
        timestamp: 1,
      }),
    );

    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(watch.localQueryResult()?.results).toEqual([{ _id: "issue-1" }]);
  });
});

describe("protocol auth", () => {
  it("uses verifyToken hook when provided", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const identity = createTestIdentity({ subject: "verified" });
    const runtime = new EmbeddedRuntime({
      convex: { modules: { "_generated/api": async () => ({}) } },
      verifyToken: async (token) => (token === "good" ? identity : null),
    });
    onTestFinished(() => runtime.shutdown());

    const auth = internals(runtime)._buildProtocolAuth();
    await expect(auth.verifyToken("good")).resolves.toEqual({
      identity,
      identityKey: identity.tokenIdentifier,
    });
    await expect(auth.verifyToken("bad")).rejects.toThrow(/rejected/);
  });
});

describe("executeLocal system mutation", () => {
  it("runs a system function and commits", async ({ runtime }) => {
    await runtime.hydrate();

    await runtime.executeLocal({
      kind: "mutation",
      path: "_system:idMapSet",
      args: { localId: "local-abc", remoteId: "remote-xyz", table: "users" },
      applyLocalEffects: false,
    });

    const result = await runtime.executeLocal({
      kind: "query",
      path: "_system:idMapGet",
      args: { localId: "local-abc" },
    });

    expect(result).toBe("remote-xyz");
  });

  it("claims persisted sql-backed pending entries through system mutations", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const { storage } = createSqlStorage({
      _resolve_pending: [
        doc("pending-1", {
          createdAt: 1,
          ref: "tasks:create",
          args: JSON.stringify({ title: "hello" }),
          localResult: JSON.stringify({ ok: true }),
          table: "tasks",
          payloadVersion: 1,
          identityKey: "user:a",
          state: "pending",
        }),
      ],
    });
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage,
    });
    onTestFinished(() => localRuntime.shutdown());

    localRuntime.db.setReadBackendForTests(
      storage as unknown as AsyncReadBackend,
    );
    await localRuntime.hydrate();

    const claimed = (await localRuntime.executeLocal({
      kind: "mutation",
      path: "_system:pendingClaimNext",
      args: { identityKey: "user:a", owner: "processor-a", leaseMs: 1000 },
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
  });

  it("updates sql-backed collection and document metadata through system mutations", async ({
    broadcast: _broadcast,
    onTestFinished,
  }) => {
    const { storage } = createSqlStorage({
      _resolve_collection_metadata: [],
      _resolve_document_metadata: [],
    });
    const localRuntime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage,
    });
    onTestFinished(() => localRuntime.shutdown());

    localRuntime.db.setReadBackendForTests(
      storage as unknown as AsyncReadBackend,
    );
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
      args: { collection: "tasks", identityKey: "user:a", schemaVersion: 1 },
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
      args: { collection: "tasks", identityKey: "user:a", schemaVersion: 1 },
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
  });
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe("shutdown", () => {
  it("is idempotent", ({ runtime }) => {
    runtime.shutdown();
    expect(() => runtime.shutdown()).not.toThrow();
  });

  it("clears all transports", async ({ runtime }) => {
    const transport = runtime.createTransport();
    const ws = new transport.webSocketConstructor("ws://localhost");

    await flushMicrotasks();
    expect(ws.readyState).toBe(1);

    runtime.shutdown();

    expect(ws.readyState).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("setIdentity", () => {
  it("delegates to auth resolver", async ({ runtime }) => {
    const identity = {
      subject: "user-42",
      issuer: "https://test.local",
      tokenIdentifier: "https://test.local|user-42",
      name: "Alice",
    };

    runtime.setIdentity(identity);

    const resolved = await runtime.auth.getUserIdentity();
    expect(resolved).toEqual(identity);

    runtime.setIdentity(null);
    const cleared = await runtime.auth.getUserIdentity();
    expect(cleared).toBeNull();
  });
});
