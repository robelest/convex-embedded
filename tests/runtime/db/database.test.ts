import { OpaqueAdapter } from "@embedded/persistence/opaque/adapter";
import { Database } from "@embedded/runtime/db/database";
import type { ParsedSchema } from "@embedded/runtime/db/schema";
import { mockAdapter } from "@tests/helpers/test-adapter";
import { describe, it, expect } from "@tests/testkit";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a schema-less database. */
function createDb(): Database {
  return new Database(null);
}

/** Create a database with a "messages" table schema. */
function createSchemaDb(): Database {
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

function createIndexedDb(): Database {
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

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

describe("Database — ID generation", () => {
  it("insert creates UUID-format IDs", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "test" });
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    db.commit();
  });

  it("IDs are unique across inserts", () => {
    const db = createDb();
    db.startTransaction();
    const id1 = db.insert("tasks", { title: "a" });
    const id2 = db.insert("tasks", { title: "b" });
    const id3 = db.insert("other", { x: 1 });
    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id2).not.toBe(id3);
    db.commit();
  });

  it("retries id generation when the crypto provider returns a duplicate", () => {
    const db = new Database(null, undefined, {
      randomUUID: (() => {
        const values = [
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
        ];
        let index = 0;
        return () => values[index++] ?? crypto.randomUUID();
      })(),
      getRandomValues: (bytes: Uint8Array) => crypto.getRandomValues(bytes),
      sha256: async () => new Uint8Array(),
      encryptAesGcm: async () => new Uint8Array(),
      decryptAesGcm: async () => new Uint8Array(),
    });

    db.startTransaction();
    const id1 = db.insert("tasks", { title: "a" });
    const id2 = db.insert("tasks", { title: "b" });

    expect(id1).toBe("00000000-0000-4000-8000-000000000001");
    expect(id2).toBe("00000000-0000-4000-8000-000000000002");
    db.commit();
  });
});

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

describe("Database — CRUD", () => {
  it("insert + get: returns document with _id and _creationTime", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "hello" });
    const doc = db.get("tasks", id);
    expect(doc).not.toBeNull();
    expect(doc!._id).toBe(id);
    expect(doc!._creationTime).toBeTypeOf("number");
    expect(doc!.title).toBe("hello");
    db.commit();
  });

  it("patch: modifies specified fields, preserves unpatched fields", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "original", priority: 1 });
    db.patch("tasks", id, { title: "updated" });
    const doc = db.get("tasks", id)!;
    expect(doc.title).toBe("updated");
    expect(doc.priority).toBe(1);
    db.commit();
  });

  it("replace: replaces all user fields", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "old", priority: 1 });
    db.replace("tasks", id, { title: "new" });
    const doc = db.get("tasks", id)!;
    expect(doc.title).toBe("new");
    expect(doc.priority).toBeUndefined();
    expect(doc._id).toBe(id);
    expect(doc._creationTime).toBeTypeOf("number");
    db.commit();
  });

  it("delete: document returns null after deletion", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "bye" });
    expect(db.get("tasks", id)).not.toBeNull();
    db.delete("tasks", id);
    expect(db.get("tasks", id)).toBeNull();
    db.commit();
  });

  it("get on non-existent ID returns null", () => {
    const db = createDb();
    db.startTransaction();
    const result = db.get(
      undefined,
      "00000000-0000-4000-8000-000000000000" as any,
    );
    expect(result).toBeNull();
    db.commit();
  });
});

// ---------------------------------------------------------------------------
// Transaction semantics
// ---------------------------------------------------------------------------

describe("Database — transactions", () => {
  it("writes are visible within the transaction", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "visible" });
    expect(db.get("tasks", id)!.title).toBe("visible");
    db.commit();
  });

  it("commit() applies writes — visible after commit", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "persisted" });
    db.commit();

    // Start a new transaction and read the committed document.
    db.startTransaction();
    const doc = db.get("tasks", id);
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe("persisted");
    db.commit();
  });

  it("rollbackWrites() discards writes", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "rolled-back" });
    db.rollbackWrites();

    db.startTransaction();
    const doc = db.get("tasks", id);
    expect(doc).toBeNull();
    db.commit();
  });

  it("nested transactions: child commit merges into parent", () => {
    const db = createDb();
    db.startTransaction(); // parent
    const id1 = db.insert("tasks", { title: "parent-write" });

    db.startTransaction(); // child
    const id2 = db.insert("tasks", { title: "child-write" });
    db.commit(); // child commit — merges into parent

    // Both should be visible in the parent transaction.
    expect(db.get("tasks", id1)).not.toBeNull();
    expect(db.get("tasks", id2)).not.toBeNull();
    db.commit(); // parent commit

    // Both persisted.
    db.startTransaction();
    expect(db.get("tasks", id1)).not.toBeNull();
    expect(db.get("tasks", id2)).not.toBeNull();
    db.commit();
  });

  it("nested transactions: child rollback discards only child writes", () => {
    const db = createDb();
    db.startTransaction(); // parent
    const id1 = db.insert("tasks", { title: "parent-write" });

    db.startTransaction(); // child
    const id2 = db.insert("tasks", { title: "child-write" });
    db.rollbackWrites(); // child rollback

    // Parent write should still be visible.
    expect(db.get("tasks", id1)).not.toBeNull();
    // Child write should be gone.
    expect(db.get("tasks", id2)).toBeNull();
    db.commit();
  });
});

// ---------------------------------------------------------------------------
// MVCC timestamps
// ---------------------------------------------------------------------------

describe("Database — MVCC timestamps", () => {
  it("initial timestamp is 0", () => {
    const db = createDb();
    expect(db.timestamp).toBe(0);
  });

  it("timestamp increments on commit with writes", () => {
    const db = createDb();
    db.startTransaction();
    db.insert("tasks", { title: "a" });
    db.commit();
    expect(db.timestamp).toBe(1);
  });

  it("timestamp does NOT increment on commit without writes", () => {
    const db = createDb();
    db.startTransaction();
    // No writes.
    db.commit();
    expect(db.timestamp).toBe(0);
  });

  it("timestamp does NOT increment on rollback", () => {
    const db = createDb();
    db.startTransaction();
    db.insert("tasks", { title: "a" });
    db.rollbackWrites();
    expect(db.timestamp).toBe(0);
  });

  it("timestamp increments correctly across multiple commits", () => {
    const db = createDb();

    db.startTransaction();
    db.insert("tasks", { title: "a" });
    db.commit();
    expect(db.timestamp).toBe(1);

    db.startTransaction();
    db.insert("tasks", { title: "b" });
    db.commit();
    expect(db.timestamp).toBe(2);

    // Read-only transaction — no bump.
    db.startTransaction();
    db.commit();
    expect(db.timestamp).toBe(2);
  });
});

describe("Database — async read backend", () => {
  it("startQueryAsync uses backend IndexRange reads when available", async () => {
    const db = createIndexedDb();
    const docs = [
      {
        _id: "a" as any,
        _creationTime: 1,
        status: "active",
        title: "first",
      },
      {
        _id: "b" as any,
        _creationTime: 2,
        status: "done",
        title: "second",
      },
      {
        _id: "c" as any,
        _creationTime: 3,
        status: "active",
        title: "third",
      },
    ];
    const readSource = vi.fn(async () => [docs[0]!, docs[2]!]);
    db.setReadBackendForTests({
      readSource,
      listDocuments: async () => docs,
      get: async () => null,
      count: async () => docs.length,
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

  it("startQueryAsync uses backend query pushdown for simple filters and limit", async () => {
    const db = createIndexedDb();
    const docs = [
      {
        _id: "a" as any,
        _creationTime: 1,
        status: "active",
        title: "first",
      },
      {
        _id: "c" as any,
        _creationTime: 3,
        status: "active",
        title: "third",
      },
    ];
    const readQuery = vi.fn(async () => [docs[0]!]);
    db.setReadBackendForTests({
      readQuery,
      source: async () => docs,
      listDocuments: async () => docs,
      get: async () => null,
      count: async () => docs.length,
    });

    const queryId = db.startQueryAsync({
      source: {
        type: "FullTableScan",
        tableName: "tasks",
        order: "asc",
      },
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

  it("vectorSearchAsync uses backend vector candidates when available", async () => {
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
    const vectorDb = new Database(vectorSchema);
    const readVectorCandidates = vi.fn(async () => [
      {
        _id: "a" as any,
        _creationTime: 1,
        status: "active",
        embedding: [1, 0],
      },
      {
        _id: "b" as any,
        _creationTime: 2,
        status: "active",
        embedding: [0.5, 0.5],
      },
    ]);
    vectorDb.setReadBackendForTests({
      readVectorCandidates,
    });
    vectorDb.setStorage(
      mockAdapter({
        kind: "sql",
        listAll: async () => [],
        list: async () => [],
        meta: async () => null,
        listBlobs: async () => [],
        get: async () => null,
        count: async () => 0,
        listDocuments: async () => [],
        source: async () => [],
        query: async () => [],
        readVectorCandidates,
        commit: async () => undefined,
        putBlob: async () => undefined,
        deleteBlob: async () => undefined,
        clear: async () => undefined,
      }),
    );

    const results = await vectorDb.vectorSearchAsync(
      "tasks.by_embedding",
      [1, 0],
      { $eq: [{ $field: "status" }, { $literal: "active" }] },
      5,
    );

    expect(readVectorCandidates).toHaveBeenCalled();
    expect(results.map((result) => result._id)).toEqual(["a", "b"]);
    expect(results[0]!._score).toBeGreaterThan(results[1]!._score);
  });
});

// ---------------------------------------------------------------------------
// tablesWritten tracking
// ---------------------------------------------------------------------------

describe("Database — tablesWritten", () => {
  it("commit() returns the set of written tables", () => {
    const db = createDb();
    db.startTransaction();
    db.insert("tasks", { title: "a" });
    const { tablesWritten } = db.commit();
    expect(tablesWritten).toBeInstanceOf(Set);
    expect(tablesWritten.has("tasks")).toBe(true);
  });

  it("tracks multiple tables when writing to multiple tables", () => {
    const db = createDb();
    db.startTransaction();
    db.insert("tasks", { title: "a" });
    db.insert("users", { name: "alice" });
    const { tablesWritten } = db.commit();
    expect(tablesWritten.has("tasks")).toBe(true);
    expect(tablesWritten.has("users")).toBe(true);
    expect(tablesWritten.size).toBe(2);
  });

  it("returns empty set for read-only transaction", () => {
    const db = createDb();
    db.startTransaction();
    const { tablesWritten } = db.commit();
    expect(tablesWritten.size).toBe(0);
  });
});

describe("Database — committed indexes", () => {
  it("dedupes duplicate ids in committed index reads", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "a" });
    db.commit();

    const state = db as any;
    state._indexDocuments.set("tasks.by_creation_time", [id, id]);

    const docs = db.getIndexedDocuments("tasks", "by_creation_time");
    expect(docs).toHaveLength(1);
    expect(docs[0]!._id).toBe(id);
  });
});

describe("Database — sql committed state authority", () => {
  it("does not materialize cold sql-backed user tables on outer commit", async () => {
    const applyCommitSpy = vi.fn(async (batch) => ({
      meta: batch.meta,
      tables: [],
    }));
    const db = createDb();
    db.setStorage(
      mockAdapter({
        kind: "sql",
        listAll: async () => [],
        list: async () => [],
        meta: async () => null,
        listBlobs: async () => [],
        get: async () => null,
        count: async () => 0,
        listDocuments: async () => [],
        source: async () => [],
        query: async () => [],
        commit: async () => undefined,
        atomicCommit: applyCommitSpy,
        putBlob: async () => undefined,
        deleteBlob: async () => undefined,
        clear: async () => undefined,
      }),
    );

    db.startTransaction();
    db.insert("tasks", { title: "persisted" });
    const commit = await db.commitAsync();

    expect(commit.tablesWritten.has("tasks")).toBe(true);
    expect(commit.invalidation).toEqual({
      tables: new Set(["tasks"]),
      changes: [],
    });
    expect(db.hasDocumentsForTable("tasks")).toBe(false);

    await commit.persisted;
    expect(applyCommitSpy).toHaveBeenCalledTimes(1);
  });

  it("reports coarse deletes for cold sql-backed tables without materializing them", async () => {
    const applyCommitSpy = vi.fn(async (batch) => ({
      meta: batch.meta,
      tables: [],
    }));
    const db = createDb();
    db.setStorage(
      mockAdapter({
        kind: "sql",
        listAll: async () => [],
        list: async () => [],
        meta: async () => null,
        listBlobs: async () => [],
        get: async () => null,
        count: async () => 0,
        listDocuments: async () => [],
        source: async () => [],
        query: async () => [],
        commit: async () => undefined,
        atomicCommit: applyCommitSpy,
        putBlob: async () => undefined,
        deleteBlob: async () => undefined,
        clear: async () => undefined,
      }),
    );

    const state = db as any;
    state._idTableMap.set("task-1", "tasks");

    db.startTransaction();
    state._addWriteRaw("task-1", null);
    const commit = await db.commitAsync();

    expect(commit.tablesWritten.has("tasks")).toBe(true);
    expect(commit.invalidation).toEqual({
      tables: new Set(["tasks"]),
      changes: [],
    });

    await commit.persisted;
    expect(applyCommitSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves the transaction until an outer sql commit succeeds", async () => {
    const db = createDb();
    db.setStorage(
      mockAdapter({
        atomicCommit: vi.fn(async () => {
          throw new Error("sql write failed");
        }),
        listAll: async () => [],
        list: async () => [],
        meta: async () => null,
        listBlobs: async () => [],
        get: async () => null,
        count: async () => 0,
        query: async () => [],
        source: async () => [],
        vectorSearch: async () => [],
        commit: async () => undefined,
        putBlob: async () => undefined,
        deleteBlob: async () => undefined,
        clear: async () => undefined,
      }),
    );

    db.startTransaction();
    db.insert("tasks", { title: "pending" });

    await expect(db.commitAsync()).rejects.toThrow("sql write failed");
    expect(() => db.rollbackWrites()).not.toThrow();
    expect(db.timestamp).toBe(0);
  });
});

describe("Database — hydrate", () => {
  it("replaces existing in-memory state on full hydration", async () => {
    const storage = new OpaqueAdapter();
    const db = createDb();

    db.startTransaction();
    const ghostId = db.insert("tasks", { title: "ghost" });
    db.commit();

    const persisted = new Database(null, storage);
    persisted.startTransaction();
    const persistedId = persisted.insert("tasks", { title: "persisted" });
    const persistedCommit = persisted.commit();
    await persistedCommit.persisted;

    db.setStorage(storage);
    await db.hydrate();

    expect(db.get("tasks", ghostId as any)).toBeNull();
    expect(db.get("tasks", persistedId as any)).toEqual(
      expect.objectContaining({
        _id: persistedId,
        title: "persisted",
      }),
    );
    expect(db.getDocumentsForTable("tasks")).toHaveLength(1);
  });

  it("replaces only the requested tables on scoped hydration", async () => {
    const storage = new OpaqueAdapter();
    const db = createDb();

    db.startTransaction();
    const staleTaskId = db.insert("tasks", { title: "stale task" });
    const localUserId = db.insert("users", { name: "Local user" });
    db.commit();

    const persisted = new Database(null, storage);
    persisted.startTransaction();
    const persistedTaskId = persisted.insert("tasks", {
      title: "persisted task",
    });
    const persistedCommit = persisted.commit();
    await persistedCommit.persisted;

    db.setStorage(storage);
    await db.hydrate({ tables: ["tasks"] });

    expect(db.get("tasks", staleTaskId as any)).toBeNull();
    expect(db.get("tasks", persistedTaskId as any)).toEqual(
      expect.objectContaining({
        _id: persistedTaskId,
        title: "persisted task",
      }),
    );
    expect(db.get("users", localUserId as any)).toEqual(
      expect.objectContaining({
        _id: localUserId,
        name: "Local user",
      }),
    );
  });

  it("clears cached blobs when the storage adapter is replaced", async () => {
    const storageId = "blob-1";
    const storage1 = new OpaqueAdapter();
    const storage2 = new OpaqueAdapter();
    const fileDoc = { _id: storageId as any, _creationTime: 1 };

    await storage1.commit({
      puts: [{ tableName: "_storage", doc: fileDoc }],
      deletes: [],
      meta: { timestamp: 1, lastCreationTime: 1 },
    });
    await storage1.putBlob(storageId, new Blob(["one"]));

    await storage2.commit({
      puts: [{ tableName: "_storage", doc: fileDoc }],
      deletes: [],
      meta: { timestamp: 1, lastCreationTime: 1 },
    });
    await storage2.putBlob(storageId, new Blob(["two"]));

    const db = createDb();
    db.setStorage(storage1);
    await db.hydrate();
    expect(await (await db.loadFile(storageId as any))?.text()).toBe("one");

    db.setStorage(storage2);
    await db.hydrate();
    expect(await (await db.loadFile(storageId as any))?.text()).toBe("two");
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("Database — schema validation", () => {
  it("inserting a valid document succeeds", () => {
    const db = createSchemaDb();
    db.startTransaction();
    expect(() =>
      db.insert("messages", { body: "hello", author: "alice" }),
    ).not.toThrow();
    db.commit();
  });

  it("inserting an invalid document throws (missing required field)", () => {
    const db = createSchemaDb();
    db.startTransaction();
    expect(() => db.insert("messages", { body: "hello" })).toThrow(
      /Missing required field/,
    );
  });

  it("inserting an invalid document throws (extra field)", () => {
    const db = createSchemaDb();
    db.startTransaction();
    expect(() =>
      db.insert("messages", { body: "hello", author: "alice", extra: true }),
    ).toThrow(/Unexpected field/);
  });

  it("inserting an invalid document throws (wrong type)", () => {
    const db = createSchemaDb();
    db.startTransaction();
    expect(() => db.insert("messages", { body: 123, author: "alice" })).toThrow(
      /Validator error/,
    );
  });

  it("inserting into an unschema'd table (not in schema) succeeds", () => {
    const db = createSchemaDb();
    db.startTransaction();
    // "other" is not defined in the schema, so no validation occurs.
    expect(() => db.insert("other", { anything: true })).not.toThrow();
    db.commit();
  });
});

// ---------------------------------------------------------------------------
// normalizeId
// ---------------------------------------------------------------------------

describe("Database — normalizeId", () => {
  it("valid ID for the correct table returns itself", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "a" });
    expect(db.normalizeId("tasks", id)).toBe(id);
    db.commit();
  });

  it("ID for a different table returns null", () => {
    const db = createDb();
    db.startTransaction();
    const id = db.insert("tasks", { title: "a" });
    expect(db.normalizeId("users", id)).toBeNull();
    db.commit();
  });

  it("non-ID string returns null", () => {
    const db = createDb();
    expect(db.normalizeId("tasks", "random-string")).toBeNull();
  });

  it("deleted IDs stop normalizing after commit", () => {
    const db = createDb();
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

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("Database — error cases", () => {
  it("patch on non-existent document throws", () => {
    const db = createDb();
    db.startTransaction();
    expect(() =>
      db.patch("tasks", "00000000-0000-4000-8000-000000000000" as any, {
        x: 1,
      }),
    ).toThrow(/non-existent/);
    db.commit();
  });

  it("delete on non-existent document throws", () => {
    const db = createDb();
    db.startTransaction();
    expect(() =>
      db.delete("tasks", "00000000-0000-4000-8000-000000000000" as any),
    ).toThrow(/non-existent/);
    db.commit();
  });

  it("replace on non-existent document throws", () => {
    const db = createDb();
    db.startTransaction();
    expect(() =>
      db.replace("tasks", "00000000-0000-4000-8000-000000000000" as any, {
        title: "new",
      }),
    ).toThrow(/non-existent/);
    db.commit();
  });

  it("write outside transaction throws", () => {
    const db = createDb();
    expect(() => db.insert("tasks", { title: "fail" })).toThrow(
      /outside of transaction/,
    );
  });
});
