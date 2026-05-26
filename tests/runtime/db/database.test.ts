import { createAmbientCryptoProvider } from "@embedded/runtime/crypto";
import { Database } from "@embedded/runtime/db/database";
import type { ParsedSchema } from "@embedded/runtime/db/schema";
import type { DocumentId, StoredDocument } from "@embedded/runtime/db/types";
import type { WriteBatch, WriteResult } from "@embedded/storage/adapter";
import { mockAdapter } from "@tests/helpers/adapter";
import { describe, expect, it, vi } from "@tests/testkit";

const MISSING_ID = "00000000-0000-4000-8000-000000000000" as DocumentId;

/** Private members reached into by a few low-level state tests. */
interface DatabaseInternals {
  _indexDocuments: Map<string, string[]>;
  _idTableMap: Map<string, string>;
  _addWriteRaw(id: DocumentId, newValue: StoredDocument | null): void;
}

function internals(db: Database): DatabaseInternals {
  return db as unknown as DatabaseInternals;
}

function schemaDb(): Database {
  const schema: ParsedSchema = {
    schemaValidation: true,
    tables: new Map([
      [
        "messages",
        {
          indexes: [],
          vectorIndexes: [],
          documentType: {
            type: "object",
            value: {
              body: { fieldType: { type: "string" }, optional: false },
              author: { fieldType: { type: "string" }, optional: false },
            },
          },
        },
      ],
    ]),
  };
  return new Database(schema);
}

function indexedDb(): Database {
  const schema: ParsedSchema = {
    schemaValidation: false,
    tables: new Map([
      [
        "tasks",
        {
          indexes: [{ indexDescriptor: "by_status", fields: ["status"] }],
          vectorIndexes: [],
          searchIndexes: [],
          documentType: { type: "any" },
        },
      ],
    ]),
  };
  return new Database(schema);
}

/** A sql-backed mock adapter whose document reads/queries are stubbed empty. */
function sqlAdapter(
  overrides: Parameters<typeof mockAdapter>[0] = {},
): ReturnType<typeof mockAdapter> {
  return mockAdapter({
    kind: "sql",
    getMetadata: async () => null,
    listBlobs: async () => [],
    getDocument: async () => null,
    countDocuments: async () => 0,
    getDocuments: async () => [],
    source: async () => [],
    query: async () => [],
    vectorSearch: async () => [],
    write: async (batch, opts) =>
      opts
        ? {
            meta: batch.meta,
            tables: (opts.materializedTables ?? []).map((tableName) => ({
              tableName,
              docs: [],
            })),
          }
        : undefined,
    storeBlob: async () => undefined,
    deleteBlob: async () => undefined,
    clearAll: async () => undefined,
    ...overrides,
  });
}

describe("Database — ID generation", () => {
  it("generates UUID-format IDs on insert", () => {
    const db = new Database(null);
    db.startTransaction();
    const id = db.insert("tasks", { title: "test" });
    db.commit();

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("generates unique IDs across inserts", () => {
    const db = new Database(null);
    db.startTransaction();
    const ids = new Set([
      db.insert("tasks", { title: "a" }),
      db.insert("tasks", { title: "b" }),
      db.insert("other", { x: 1 }),
    ]);
    db.commit();

    expect(ids.size).toBe(3);
  });

  it("retries id generation when the crypto provider returns a duplicate", () => {
    const uuids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    let index = 0;
    const db = new Database(null, undefined, {
      ...createAmbientCryptoProvider(),
      randomUUID: () => uuids[index++] ?? crypto.randomUUID(),
    });

    db.startTransaction();
    const id1 = db.insert("tasks", { title: "a" });
    const id2 = db.insert("tasks", { title: "b" });
    db.commit();

    expect(id1).toBe("00000000-0000-4000-8000-000000000001");
    expect(id2).toBe("00000000-0000-4000-8000-000000000002");
  });
});

describe("Database — CRUD", () => {
  it("returns the inserted document with _id and _creationTime from get", () => {
    const db = new Database(null);
    db.startTransaction();
    const id = db.insert("tasks", { title: "hello" });
    const doc = db.get("tasks", id);
    db.commit();

    expect(doc?._id).toBe(id);
    expect(doc?._creationTime).toBeTypeOf("number");
    expect(doc?.title).toBe("hello");
  });

  it("patches only the specified fields", () => {
    const db = new Database(null);
    db.startTransaction();
    const id = db.insert("tasks", { title: "original", priority: 1 });
    db.patch("tasks", id, { title: "updated" });
    const doc = db.get("tasks", id);
    db.commit();

    expect(doc?.title).toBe("updated");
    expect(doc?.priority).toBe(1);
  });

  it("replaces all user fields", () => {
    const db = new Database(null);
    db.startTransaction();
    const id = db.insert("tasks", { title: "old", priority: 1 });
    db.replace("tasks", id, { title: "new" });
    const doc = db.get("tasks", id);
    db.commit();

    expect(doc?.title).toBe("new");
    expect(doc?.priority).toBeUndefined();
    expect(doc?._id).toBe(id);
    expect(doc?._creationTime).toBeTypeOf("number");
  });

  it("returns null for a document after deletion", () => {
    const db = new Database(null);
    db.startTransaction();
    const id = db.insert("tasks", { title: "bye" });
    expect(db.get("tasks", id)).not.toBeNull();

    db.delete("tasks", id);
    db.commit();

    expect(db.get("tasks", id)).toBeNull();
  });

  it("returns null when getting a non-existent ID", () => {
    const db = new Database(null);
    db.startTransaction();
    const result = db.get(undefined, MISSING_ID);
    db.commit();

    expect(result).toBeNull();
  });

  it("strips identity scope markers from SQL-backed async reads", async () => {
    const schema: ParsedSchema = {
      schemaValidation: false,
      tables: new Map([
        [
          "tasks",
          {
            indexes: [],
            vectorIndexes: [],
            searchIndexes: [],
            documentType: { type: "any" },
          },
        ],
      ]),
    };
    const scopedDoc: StoredDocument = {
      _id: "task-1" as DocumentId,
      _creationTime: 1,
      __identityKey: "user-1",
      title: "private",
    };
    const db = new Database(
      schema,
      mockAdapter({
        kind: "sql",
        getDocument: async (_table, _id, opts) =>
          opts?.activeIdentityKey === "user-1" ? scopedDoc : null,
        getDocuments: async (_table, opts) =>
          opts?.activeIdentityKey === "user-1" ? [scopedDoc] : [],
      }),
    );

    db.setActiveIdentityKey("user-1");
    const doc = await db.getAsync("tasks", "task-1" as DocumentId);
    const docs = await db.listDocumentsAsync("tasks");

    expect(doc).toEqual({ _id: "task-1", _creationTime: 1, title: "private" });
    expect(docs).toEqual([doc]);

    db.setActiveIdentityKey("user-2");
    await expect(
      db.getAsync("tasks", "task-1" as DocumentId),
    ).resolves.toBeNull();
  });
});

describe("Database — transactions", () => {
  it("makes writes visible within the same transaction", () => {
    const db = new Database(null);
    db.startTransaction();
    const id = db.insert("tasks", { title: "visible" });

    expect(db.get("tasks", id)?.title).toBe("visible");
    db.commit();
  });

  it("persists writes after commit", () => {
    const db = new Database(null);
    db.startTransaction();
    const id = db.insert("tasks", { title: "persisted" });
    db.commit();

    db.startTransaction();
    const doc = db.get("tasks", id);
    db.commit();

    expect(doc?.title).toBe("persisted");
  });

  it("discards writes on rollback", () => {
    const db = new Database(null);
    db.startTransaction();
    const id = db.insert("tasks", { title: "rolled-back" });
    db.rollbackWrites();

    db.startTransaction();
    const doc = db.get("tasks", id);
    db.commit();

    expect(doc).toBeNull();
  });

  it("merges a child commit into the parent transaction", () => {
    const db = new Database(null);
    db.startTransaction();
    const parentId = db.insert("tasks", { title: "parent-write" });

    db.startTransaction();
    const childId = db.insert("tasks", { title: "child-write" });
    db.commit();

    expect(db.get("tasks", parentId)).not.toBeNull();
    expect(db.get("tasks", childId)).not.toBeNull();
    db.commit();

    db.startTransaction();
    expect(db.get("tasks", parentId)).not.toBeNull();
    expect(db.get("tasks", childId)).not.toBeNull();
    db.commit();
  });

  it("discards only child writes on child rollback", () => {
    const db = new Database(null);
    db.startTransaction();
    const parentId = db.insert("tasks", { title: "parent-write" });

    db.startTransaction();
    const childId = db.insert("tasks", { title: "child-write" });
    db.rollbackWrites();

    expect(db.get("tasks", parentId)).not.toBeNull();
    expect(db.get("tasks", childId)).toBeNull();
    db.commit();
  });
});

describe("Database — MVCC timestamps", () => {
  it("starts at 0", () => {
    expect(new Database(null).timestamp).toBe(0);
  });

  it("increments on commit with writes", () => {
    const db = new Database(null);
    db.startTransaction();
    db.insert("tasks", { title: "a" });
    db.commit();

    expect(db.timestamp).toBe(1);
  });

  it("does not increment on commit without writes", () => {
    const db = new Database(null);
    db.startTransaction();
    db.commit();

    expect(db.timestamp).toBe(0);
  });

  it("does not increment on rollback", () => {
    const db = new Database(null);
    db.startTransaction();
    db.insert("tasks", { title: "a" });
    db.rollbackWrites();

    expect(db.timestamp).toBe(0);
  });

  it("increments once per committed mutation", () => {
    const db = new Database(null);

    db.startTransaction();
    db.insert("tasks", { title: "a" });
    db.commit();
    expect(db.timestamp).toBe(1);

    db.startTransaction();
    db.insert("tasks", { title: "b" });
    db.commit();
    expect(db.timestamp).toBe(2);

    db.startTransaction();
    db.commit();
    expect(db.timestamp).toBe(2);
  });
});

describe("Database — async read backend", () => {
  const docs: StoredDocument[] = [
    {
      _id: "a" as DocumentId,
      _creationTime: 1,
      status: "active",
      title: "first",
    },
    {
      _id: "b" as DocumentId,
      _creationTime: 2,
      status: "done",
      title: "second",
    },
    {
      _id: "c" as DocumentId,
      _creationTime: 3,
      status: "active",
      title: "third",
    },
  ];

  it("reads IndexRange results through the backend source", async () => {
    const db = indexedDb();
    const readSource = vi.fn(async () => [docs[0]!, docs[2]!]);
    db.setReadBackendForTests({
      source: readSource,
      getDocuments: async () => docs,
      countDocuments: async () => docs.length,
    });

    const queryId = db.startQueryAsync({
      source: {
        type: "IndexRange",
        indexName: "tasks.by_status",
        range: [{ type: "Eq", fieldPath: "status", value: "active" }],
        order: "asc",
      },
      operators: [],
    });

    const first = await db.queryNextAsync(queryId);
    const second = await db.queryNextAsync(queryId);
    const done = await db.queryNextAsync(queryId);

    expect(readSource).toHaveBeenCalled();
    expect(first.value).toMatchObject({ title: "first" });
    expect(second.value).toMatchObject({ title: "third" });
    expect(done.done).toBe(true);
  });

  it("pushes down simple filters and limit to the backend query", async () => {
    const db = indexedDb();
    const activeDocs = [docs[0]!, docs[2]!];
    const readQuery = vi.fn(async () => [docs[0]!]);
    db.setReadBackendForTests({
      query: readQuery,
      source: async () => activeDocs,
      getDocuments: async () => activeDocs,
      countDocuments: async () => activeDocs.length,
    });

    const queryId = db.startQueryAsync({
      source: { type: "FullTableScan", tableName: "tasks", order: "asc" },
      operators: [
        { filter: { $eq: [{ $field: "status" }, { $literal: "active" }] } },
        { limit: 1 },
      ],
    });

    const first = await db.queryNextAsync(queryId);
    const done = await db.queryNextAsync(queryId);

    expect(readQuery).toHaveBeenCalled();
    expect(first.value).toMatchObject({ title: "first" });
    expect(done.done).toBe(true);
  });

  it("scores backend vector candidates", async () => {
    const vectorSchema: ParsedSchema = {
      schemaValidation: false,
      tables: new Map([
        [
          "tasks",
          {
            indexes: [],
            searchIndexes: [],
            vectorIndexes: [
              {
                indexDescriptor: "by_embedding",
                vectorField: "embedding",
                dimensions: 2,
                filterFields: ["status"],
              },
            ],
            documentType: { type: "any" },
          },
        ],
      ]),
    };
    const candidates: StoredDocument[] = [
      {
        _id: "a" as DocumentId,
        _creationTime: 1,
        status: "active",
        embedding: [1, 0],
      },
      {
        _id: "b" as DocumentId,
        _creationTime: 2,
        status: "active",
        embedding: [0.5, 0.5],
      },
    ];
    const readVectorCandidates = vi.fn(async () => candidates);
    const vectorDb = new Database(vectorSchema);
    vectorDb.setReadBackendForTests({ vectorSearch: readVectorCandidates });
    vectorDb.setStorage(sqlAdapter({ vectorSearch: readVectorCandidates }));

    const results = await vectorDb.vectorSearchAsync(
      "tasks.by_embedding",
      [1, 0],
      { $eq: [{ $field: "status" }, { $literal: "active" }] },
      5,
    );

    expect(readVectorCandidates).toHaveBeenCalled();
    expect(results.map((result) => result._id)).toEqual(["a", "b"]);
    expect(results[0]?._score).toBeGreaterThan(results[1]?._score ?? 0);
  });

  it("reads a queryable table with pending writes via push-down + overlay, never full-hydrate", async () => {
    const committed: StoredDocument[] = [
      { _id: "c1" as DocumentId, _creationTime: 1, status: "active" },
      { _id: "c2" as DocumentId, _creationTime: 2, status: "active" },
    ];
    const source = vi.fn(async () => committed);
    const getDocuments = vi.fn(async () => committed);
    const db = indexedDb();
    db.setReadBackendForTests({
      source,
      getDocuments,
      getDocument: async () => null,
      countDocuments: async () => committed.length,
    });
    db.setStorage(
      sqlAdapter({
        source,
        getDocuments,
        getDocument: async () => null,
        countDocuments: async () => committed.length,
      }),
    );

    db.startTransaction();
    db.insert("tasks", { status: "active" });

    const queryId = db.startQueryAsync({
      source: {
        type: "IndexRange",
        indexName: "tasks.by_status",
        range: [{ type: "Eq", fieldPath: "status", value: "active" }],
        order: "asc",
      },
      operators: [],
    });
    const results: Array<Record<string, unknown>> = [];
    for (;;) {
      const next = await db.queryNextAsync(queryId);
      if (next.done) break;
      results.push(next.value as Record<string, unknown>);
    }
    db.queryCleanup(queryId);
    db.rollbackWrites();

    expect(source).toHaveBeenCalled();
    expect(getDocuments).not.toHaveBeenCalled();
    expect(db.isTableHydrationAttempted("tasks")).toBe(false);
    expect(results).toHaveLength(3);
    expect(results.filter((doc) => doc._id === "c1")).toHaveLength(1);
    expect(results.filter((doc) => doc._id === "c2")).toHaveLength(1);
    expect(
      results.filter((doc) => doc._id !== "c1" && doc._id !== "c2"),
    ).toHaveLength(1);
  });

  it("listDocumentsForScopeAsync reads only the scope via the index, not the whole table", async () => {
    const active: StoredDocument[] = [
      { _id: "a1" as DocumentId, _creationTime: 1, status: "active" },
      { _id: "a2" as DocumentId, _creationTime: 2, status: "active" },
    ];
    const source = vi.fn(async () => active);
    const getDocuments = vi.fn(async () => [
      ...active,
      { _id: "d1" as DocumentId, _creationTime: 3, status: "done" },
    ]);
    const db = indexedDb();
    db.setReadBackendForTests({
      source,
      getDocuments,
      getDocument: async () => null,
      countDocuments: async () => active.length,
    });
    db.setStorage(
      sqlAdapter({
        source,
        getDocuments,
        getDocument: async () => null,
        countDocuments: async () => active.length,
      }),
    );

    const result = await db.listDocumentsForScopeAsync("tasks", {
      status: "active",
    });

    expect(source).toHaveBeenCalled();
    expect(getDocuments).not.toHaveBeenCalled();
    expect(result?.map((doc) => doc._id)).toEqual(["a1", "a2"]);
    expect(db.isTableHydrationAttempted("tasks")).toBe(false);
  });

  it("listDocumentsForScopeAsync returns null when no index covers the scope", async () => {
    const db = indexedDb();
    const getDocuments = vi.fn(async () => []);
    db.setReadBackendForTests({
      source: async () => [],
      getDocuments,
      getDocument: async () => null,
      countDocuments: async () => 0,
    });

    const result = await db.listDocumentsForScopeAsync("tasks", {
      priority: 5,
    });

    expect(result).toBeNull();
    expect(getDocuments).not.toHaveBeenCalled();
  });
});

describe("Database — tablesWritten", () => {
  it("returns the single written table", () => {
    const db = new Database(null);
    db.startTransaction();
    db.insert("tasks", { title: "a" });
    const { tablesWritten } = db.commit();

    expect([...tablesWritten]).toEqual(["tasks"]);
  });

  it("returns every written table", () => {
    const db = new Database(null);
    db.startTransaction();
    db.insert("tasks", { title: "a" });
    db.insert("users", { name: "alice" });
    const { tablesWritten } = db.commit();

    expect(tablesWritten).toEqual(new Set(["tasks", "users"]));
  });

  it("returns an empty set for a read-only transaction", () => {
    const db = new Database(null);
    db.startTransaction();
    const { tablesWritten } = db.commit();

    expect(tablesWritten.size).toBe(0);
  });
});

describe("Database — committed indexes", () => {
  it("dedupes duplicate ids in committed index reads", () => {
    const db = new Database(null);
    db.startTransaction();
    const id = db.insert("tasks", { title: "a" });
    db.commit();

    internals(db)._indexDocuments.set("tasks.by_creation_time", [id, id]);

    const docs = db.getIndexedDocuments("tasks", "by_creation_time");
    expect(docs).toHaveLength(1);
    expect(docs[0]?._id).toBe(id);
  });
});

describe("Database — sql committed state authority", () => {
  it("mirrors writes into the in-memory snapshot on outer commit", async () => {
    const write = vi.fn(
      async (batch: WriteBatch): Promise<WriteResult> => ({
        meta: batch.meta,
        tables: [],
      }),
    );
    const db = new Database(null);
    db.setStorage(sqlAdapter({ write }));

    db.startTransaction();
    const insertedId = db.insert("tasks", { title: "persisted" });
    const commit = await db.commitAsync();

    expect(commit.tablesWritten.has("tasks")).toBe(true);
    expect(commit.invalidation.tables).toEqual(new Set(["tasks"]));
    expect(commit.invalidation.changes).toHaveLength(1);
    expect(commit.invalidation.changes[0]?.tableName).toBe("tasks");
    expect(commit.invalidation.changes[0]?.before).toBeNull();
    expect(commit.invalidation.changes[0]?.after?._id).toBe(insertedId);
    expect(db.hasDocumentsForTable("tasks")).toBe(true);

    await commit.persisted;
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("reports precise deletes and removes the in-memory row", async () => {
    const write = vi.fn(
      async (batch: WriteBatch): Promise<WriteResult> => ({
        meta: batch.meta,
        tables: [],
      }),
    );
    const db = new Database(null);
    db.setStorage(sqlAdapter({ write }));

    internals(db)._idTableMap.set("task-1", "tasks");

    db.startTransaction();
    internals(db)._addWriteRaw("task-1" as DocumentId, null);
    const commit = await db.commitAsync();

    expect(commit.tablesWritten.has("tasks")).toBe(true);
    expect(commit.invalidation.tables).toEqual(new Set(["tasks"]));
    expect(commit.invalidation.changes).toHaveLength(1);
    expect(commit.invalidation.changes[0]?.tableName).toBe("tasks");
    expect(commit.invalidation.changes[0]?.after).toBeNull();

    await commit.persisted;
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("commits to memory immediately and surfaces sql write failures via persisted", async () => {
    const db = new Database(null);
    db.setStorage(
      sqlAdapter({
        write: vi.fn(async () => {
          throw new Error("sql write failed");
        }),
      }),
    );

    db.startTransaction();
    db.insert("tasks", { title: "pending" });
    const result = await db.commitAsync();

    expect(db.timestamp).toBe(1);
    await expect(result.persisted).rejects.toThrow("sql write failed");
  });
});

describe("Database — hydrate", () => {
  it("replaces existing in-memory state on full hydration", async () => {
    const storage = mockAdapter();
    const db = new Database(null);

    db.startTransaction();
    const ghostId = db.insert("tasks", { title: "ghost" });
    db.commit();

    const persistedId = await seedPersistedTask(storage, "persisted");

    db.setStorage(storage);
    await db.hydrate();

    expect(db.get("tasks", ghostId)).toBeNull();
    expect(db.get("tasks", persistedId)).toEqual(
      expect.objectContaining({ _id: persistedId, title: "persisted" }),
    );
    expect(db.getDocumentsForTable("tasks")).toHaveLength(1);
  });

  it("replaces only the requested tables on scoped hydration", async () => {
    const storage = mockAdapter();
    const db = new Database(null);

    db.startTransaction();
    const staleTaskId = db.insert("tasks", { title: "stale task" });
    const localUserId = db.insert("users", { name: "Local user" });
    db.commit();

    const persistedTaskId = await seedPersistedTask(storage, "persisted task");

    db.setStorage(storage);
    await db.hydrate({ tables: ["tasks"] });

    expect(db.get("tasks", staleTaskId)).toBeNull();
    expect(db.get("tasks", persistedTaskId)).toEqual(
      expect.objectContaining({
        _id: persistedTaskId,
        title: "persisted task",
      }),
    );
    expect(db.get("users", localUserId)).toEqual(
      expect.objectContaining({ _id: localUserId, name: "Local user" }),
    );
  });

  it("clears cached blobs when the storage adapter is replaced", async () => {
    const storageId = "blob-1" as DocumentId;
    const fileDoc: StoredDocument = { _id: storageId, _creationTime: 1 };

    const storage1 = mockAdapter();
    await storage1.write({
      puts: [{ tableName: "_storage", doc: fileDoc }],
      deletes: [],
      meta: { timestamp: 1, lastCreationTime: 1 },
    });
    await storage1.storeBlob(storageId, new Blob(["one"]));

    const storage2 = mockAdapter();
    await storage2.write({
      puts: [{ tableName: "_storage", doc: fileDoc }],
      deletes: [],
      meta: { timestamp: 1, lastCreationTime: 1 },
    });
    await storage2.storeBlob(storageId, new Blob(["two"]));

    const db = new Database(null);
    db.setStorage(storage1);
    await db.hydrate();
    expect(await (await db.loadFile(storageId))?.text()).toBe("one");

    db.setStorage(storage2);
    await db.hydrate();
    expect(await (await db.loadFile(storageId))?.text()).toBe("two");
  });
});

describe("Database — schema validation", () => {
  it("accepts a valid document", () => {
    const db = schemaDb();
    db.startTransaction();
    expect(() =>
      db.insert("messages", { body: "hello", author: "alice" }),
    ).not.toThrow();
    db.commit();
  });

  it("rejects a document missing a required field", () => {
    const db = schemaDb();
    db.startTransaction();
    expect(() => db.insert("messages", { body: "hello" })).toThrow(
      /Missing required field/,
    );
  });

  it("rejects a document with an extra field", () => {
    const db = schemaDb();
    db.startTransaction();
    expect(() =>
      db.insert("messages", { body: "hello", author: "alice", extra: true }),
    ).toThrow(/Unexpected field/);
  });

  it("rejects a document with a wrong field type", () => {
    const db = schemaDb();
    db.startTransaction();
    expect(() => db.insert("messages", { body: 123, author: "alice" })).toThrow(
      /Validator error/,
    );
  });

  it("does not validate tables absent from the schema", () => {
    const db = schemaDb();
    db.startTransaction();
    expect(() => db.insert("other", { anything: true })).not.toThrow();
    db.commit();
  });
});

describe("Database — normalizeId", () => {
  it("returns the id for the correct table", () => {
    const db = new Database(null);
    db.startTransaction();
    const id = db.insert("tasks", { title: "a" });
    expect(db.normalizeId("tasks", id)).toBe(id);
    db.commit();
  });

  it("returns null for an id from a different table", () => {
    const db = new Database(null);
    db.startTransaction();
    const id = db.insert("tasks", { title: "a" });
    expect(db.normalizeId("users", id)).toBeNull();
    db.commit();
  });

  it("returns null for a non-id string", () => {
    const db = new Database(null);
    expect(db.normalizeId("tasks", "random-string")).toBeNull();
  });

  it("stops normalizing a deleted id after commit", () => {
    const db = new Database(null);
    db.startTransaction();
    const id = db.insert("tasks", { title: "a" });
    db.commit();

    db.startTransaction();
    db.delete("tasks", id);
    db.commit();

    expect(db.normalizeId("tasks", id)).toBeNull();
    expect(db.getTableForId(id)).toBeUndefined();
  });
});

describe("Database — error cases", () => {
  it("throws when patching a non-existent document", () => {
    const db = new Database(null);
    db.startTransaction();
    expect(() => db.patch("tasks", MISSING_ID, { x: 1 })).toThrow(
      /non-existent/,
    );
    db.commit();
  });

  it("throws when deleting a non-existent document", () => {
    const db = new Database(null);
    db.startTransaction();
    expect(() => db.delete("tasks", MISSING_ID)).toThrow(/non-existent/);
    db.commit();
  });

  it("throws when replacing a non-existent document", () => {
    const db = new Database(null);
    db.startTransaction();
    expect(() => db.replace("tasks", MISSING_ID, { title: "new" })).toThrow(
      /non-existent/,
    );
    db.commit();
  });

  it("throws when writing outside a transaction", () => {
    const db = new Database(null);
    expect(() => db.insert("tasks", { title: "fail" })).toThrow(
      /outside of transaction/,
    );
  });
});

async function seedPersistedTask(
  storage: ReturnType<typeof mockAdapter>,
  title: string,
): Promise<DocumentId> {
  const persisted = new Database(null, storage);
  persisted.startTransaction();
  const id = persisted.insert("tasks", { title });
  await persisted.commit().persisted;
  return id;
}
