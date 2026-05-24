/**
 * Integration tests for the embedded Convex runtime.
 *
 * Exercises the Database, QueryEngine, UdfExecutor, Syscalls, and
 * SubscriptionManager layers working together end-to-end.
 */
import { Database } from "@embedded/runtime/db/database";
import type { ParsedSchema } from "@embedded/runtime/db/schema";
import type {
  DocumentId,
  GenericDocument,
  SerializedQuery,
  VectorSearchExpression,
} from "@embedded/runtime/db/types";
import { SubscriptionManager } from "@embedded/sync/subscriptions";
import { describe, expect, it, vi } from "@tests/testkit";

const MISSING_ID = "00000000-0000-4000-8000-000000000000" as DocumentId;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Schema-less database inside a fresh transaction. */
function freshDb(): Database {
  const db = new Database(null);
  db.startTransaction();
  return db;
}

/** Yield non-null values from a streaming query until done. */
function* iterateQuery(
  db: Database,
  queryId: number,
): Generator<GenericDocument> {
  let next = db.queryNext(queryId);
  while (!next.done) {
    if (next.value !== null) {
      yield next.value;
    }
    next = db.queryNext(queryId);
  }
}

/** Collect all results from a streaming query. */
function collectQuery(db: Database, query: SerializedQuery): GenericDocument[] {
  const queryId = db.startQuery(query);
  return Array.from(iterateQuery(db, queryId));
}

/** Full-table scan helper (ascending). */
function fullScan(tableName: string): SerializedQuery {
  return {
    source: { type: "FullTableScan", tableName, order: "asc" },
    operators: [],
  };
}

/** Schema with "messages" table, "by_author" index, and search index. */
function messagesSchema(): ParsedSchema {
  return {
    schemaValidation: true,
    tables: new Map([
      [
        "messages",
        {
          indexes: [{ indexDescriptor: "by_author", fields: ["author"] }],
          vectorIndexes: [],
          searchIndexes: [
            {
              indexDescriptor: "search_body",
              searchField: "body",
              filterFields: ["author"],
            },
          ],
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
}

function vectorSchema(): ParsedSchema {
  return {
    schemaValidation: false,
    tables: new Map([
      [
        "embeddings",
        {
          indexes: [],
          vectorIndexes: [
            {
              indexDescriptor: "by_embedding",
              vectorField: "embedding",
              dimensions: 2,
              filterFields: ["category", "status"],
            },
          ],
          searchIndexes: [],
          documentType: { type: "any" },
        },
      ],
    ]),
  };
}

function vectorEq(fieldPath: string, value: unknown): VectorSearchExpression {
  return {
    $eq: [{ $field: fieldPath }, { $literal: value as never }],
  };
}

function vectorOr(
  ...expressions: VectorSearchExpression[]
): VectorSearchExpression {
  return { $or: expressions };
}

// ===========================================================================
// 1. CRUD operations via Database
// ===========================================================================

describe("Integration: Database CRUD", () => {
  it("insert + get round-trip preserves all fields", () => {
    const db = freshDb();
    const id = db.insert("messages", { body: "hello", author: "alice" });
    const doc = db.get("messages", id);

    expect(doc).not.toBeNull();
    expect(doc!._id).toBe(id);
    expect(doc!._creationTime).toBeTypeOf("number");
    expect(doc!.body).toBe("hello");
    expect(doc!.author).toBe("alice");
    db.commit();
  });

  it("patch merges fields without touching others", () => {
    const db = freshDb();
    const id = db.insert("tasks", {
      title: "original",
      priority: 1,
      done: false,
    });
    db.patch("tasks", id, { title: "updated" });

    const doc = db.get("tasks", id)!;
    expect(doc.title).toBe("updated");
    expect(doc.priority).toBe(1);
    expect(doc.done).toBe(false);
    db.commit();
  });

  it("replace removes old user fields and sets new ones", () => {
    const db = freshDb();
    const id = db.insert("tasks", { title: "old", priority: 1 });
    db.replace("tasks", id, { title: "new" });

    const doc = db.get("tasks", id)!;
    expect(doc.title).toBe("new");
    expect(doc.priority).toBeUndefined();
    expect(doc._id).toBe(id);
    expect(doc._creationTime).toBeTypeOf("number");
    db.commit();
  });

  it("delete makes document unreachable", () => {
    const db = freshDb();
    const id = db.insert("tasks", { title: "bye" });
    expect(db.get("tasks", id)).not.toBeNull();

    db.delete("tasks", id);
    expect(db.get("tasks", id)).toBeNull();
    db.commit();
  });

  it("multiple inserts in one transaction are all visible", () => {
    const db = freshDb();
    const ids = [
      db.insert("items", { n: 1 }),
      db.insert("items", { n: 2 }),
      db.insert("items", { n: 3 }),
    ];

    for (const id of ids) {
      expect(db.get("items", id)).not.toBeNull();
    }
    db.commit();

    db.startTransaction();
    for (const id of ids) {
      expect(db.get("items", id)).not.toBeNull();
    }
    db.commit();
  });

  it("normalizeId returns the id when table matches", () => {
    const db = freshDb();
    const id = db.insert("tasks", { title: "a" });
    expect(db.normalizeId("tasks", id)).toBe(id);
    db.commit();
  });

  it("normalizeId returns null when table does not match", () => {
    const db = freshDb();
    const id = db.insert("tasks", { title: "a" });
    expect(db.normalizeId("users", id)).toBeNull();
    db.commit();
  });

  it("normalizeId returns null for arbitrary strings", () => {
    const db = new Database(null);
    expect(db.normalizeId("tasks", "not-an-id")).toBeNull();
    expect(db.normalizeId("tasks", "")).toBeNull();
  });
});

// ===========================================================================
// 2. Query pipeline
// ===========================================================================

describe("Integration: Query Pipeline", () => {
  it("full table scan returns all docs sorted by _creationTime asc", () => {
    const db = freshDb();
    db.insert("messages", { body: "first", order: 1 });
    db.insert("messages", { body: "second", order: 2 });
    db.insert("messages", { body: "third", order: 3 });
    db.commit();

    db.startTransaction();
    const results = collectQuery(db, fullScan("messages"));
    expect(results).toHaveLength(3);
    expect(results[0]!.body).toBe("first");
    expect(results[1]!.body).toBe("second");
    expect(results[2]!.body).toBe("third");
    db.rollbackWrites();
  });

  it("full table scan descending reverses order", () => {
    const db = freshDb();
    db.insert("messages", { body: "A" });
    db.insert("messages", { body: "B" });
    db.insert("messages", { body: "C" });
    db.commit();

    db.startTransaction();
    const results = collectQuery(db, {
      source: { type: "FullTableScan", tableName: "messages", order: "desc" },
      operators: [],
    });
    expect(results).toHaveLength(3);
    expect(results[0]!.body).toBe("C");
    expect(results[2]!.body).toBe("A");
    db.rollbackWrites();
  });

  it("filter operator narrows results", () => {
    const db = freshDb();
    db.insert("items", { kind: "apple", count: 5 });
    db.insert("items", { kind: "banana", count: 3 });
    db.insert("items", { kind: "apple", count: 7 });
    db.commit();

    db.startTransaction();
    const results = collectQuery(db, {
      source: { type: "FullTableScan", tableName: "items", order: "asc" },
      operators: [
        { filter: { $eq: [{ $field: "kind" }, { $literal: "apple" }] } },
      ],
    });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.kind === "apple")).toBe(true);
    db.rollbackWrites();
  });

  it("limit operator caps result count", () => {
    const db = freshDb();
    for (let i = 0; i < 10; i++) {
      db.insert("items", { n: i });
    }
    db.commit();

    db.startTransaction();
    const results = collectQuery(db, {
      source: { type: "FullTableScan", tableName: "items", order: "asc" },
      operators: [{ limit: 3 }],
    });
    expect(results).toHaveLength(3);
    db.rollbackWrites();
  });

  it("filter + limit work together", () => {
    const db = freshDb();
    for (let i = 0; i < 10; i++) {
      db.insert("items", { n: i, even: i % 2 === 0 });
    }
    db.commit();

    db.startTransaction();
    const results = collectQuery(db, {
      source: { type: "FullTableScan", tableName: "items", order: "asc" },
      operators: [
        { filter: { $eq: [{ $field: "even" }, { $literal: true }] } },
        { limit: 2 },
      ],
    });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.even === true)).toBe(true);
    db.rollbackWrites();
  });

  it("query on empty table returns nothing", () => {
    const db = freshDb();
    db.commit();

    db.startTransaction();
    const results = collectQuery(db, fullScan("nonexistent"));
    expect(results).toHaveLength(0);
    db.rollbackWrites();
  });

  it("count returns the correct number of documents", () => {
    const db = freshDb();
    db.insert("items", { n: 1 });
    db.insert("items", { n: 2 });
    db.insert("items", { n: 3 });
    db.commit();

    db.startTransaction();
    expect(db.count("items")).toBe(3);
    expect(db.count("empty")).toBe(0);
    db.rollbackWrites();
  });
});

// ===========================================================================
// 3. Schema validation
// ===========================================================================

describe("Integration: Schema Validation", () => {
  it("accepts documents matching the schema", () => {
    const db = new Database(messagesSchema());
    db.startTransaction();
    expect(() =>
      db.insert("messages", { body: "hi", author: "alice" }),
    ).not.toThrow();
    db.commit();
  });

  it("rejects documents with wrong field type", () => {
    const db = new Database(messagesSchema());
    db.startTransaction();
    expect(() => db.insert("messages", { body: 123, author: "alice" })).toThrow(
      /Validator error/,
    );
  });

  it("rejects documents with missing required field", () => {
    const db = new Database(messagesSchema());
    db.startTransaction();
    expect(() => db.insert("messages", { body: "hi" })).toThrow(
      /Missing required field/,
    );
  });

  it("rejects documents with extra fields", () => {
    const db = new Database(messagesSchema());
    db.startTransaction();
    expect(() =>
      db.insert("messages", { body: "hi", author: "alice", extra: true }),
    ).toThrow(/Unexpected field/);
  });

  it("patch also validates against schema", () => {
    const db = new Database(messagesSchema());
    db.startTransaction();
    const id = db.insert("messages", { body: "hi", author: "alice" });
    expect(() => db.patch("messages", id, { body: 42 })).toThrow(
      /Validator error/,
    );
  });

  it("replace also validates against schema", () => {
    const db = new Database(messagesSchema());
    db.startTransaction();
    const id = db.insert("messages", { body: "hi", author: "alice" });
    expect(() => db.replace("messages", id, { body: "new" })).toThrow(
      /Missing required field/,
    );
  });

  it("inserting into table not in schema is allowed (no validation)", () => {
    const db = new Database(messagesSchema());
    db.startTransaction();
    expect(() => db.insert("other", { anything: 42 })).not.toThrow();
    db.commit();
  });

  it("schema-less mode allows any document", () => {
    const db = new Database(null);
    db.startTransaction();
    expect(() =>
      db.insert("whatever", { a: 1, b: "two", c: [3], d: { nested: true } }),
    ).not.toThrow();
    db.commit();
  });
});

// ===========================================================================
// 4. Index range queries
// ===========================================================================

describe("Integration: Index Range Queries", () => {
  function indexedDb(): Database {
    const db = new Database(messagesSchema());
    db.startTransaction();
    db.insert("messages", { body: "hello from alice", author: "alice" });
    db.insert("messages", { body: "hello from bob", author: "bob" });
    db.insert("messages", { body: "another from alice", author: "alice" });
    db.insert("messages", { body: "from charlie", author: "charlie" });
    db.commit();
    return db;
  }

  it("Eq range on indexed field returns matching documents", () => {
    const db = indexedDb();
    db.startTransaction();

    const results = collectQuery(db, {
      source: {
        type: "IndexRange",
        indexName: "messages.by_author",
        range: [{ type: "Eq", fieldPath: "author", value: "alice" }],
        order: "asc",
      },
      operators: [],
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.author === "alice")).toBe(true);
    db.rollbackWrites();
  });

  it("Eq range with no matches returns empty", () => {
    const db = indexedDb();
    db.startTransaction();

    const results = collectQuery(db, {
      source: {
        type: "IndexRange",
        indexName: "messages.by_author",
        range: [{ type: "Eq", fieldPath: "author", value: "nobody" }],
        order: "asc",
      },
      operators: [],
    });

    expect(results).toHaveLength(0);
    db.rollbackWrites();
  });

  it("by_creation_time built-in index works", () => {
    const db = indexedDb();
    db.startTransaction();

    const results = collectQuery(db, {
      source: {
        type: "IndexRange",
        indexName: "messages.by_creation_time",
        range: [],
        order: "desc",
      },
      operators: [{ limit: 2 }],
    });

    expect(results).toHaveLength(2);
    expect(results[0]!.author).toBe("charlie");
    expect(results[1]!.author).toBe("alice");
    db.rollbackWrites();
  });

  it("by_id built-in index works", () => {
    const db = indexedDb();
    db.startTransaction();

    const results = collectQuery(db, {
      source: {
        type: "IndexRange",
        indexName: "messages.by_id",
        range: [],
        order: "asc",
      },
      operators: [],
    });

    expect(results).toHaveLength(4);
    db.rollbackWrites();
  });

  it("throws for undeclared index", () => {
    const db = indexedDb();
    db.startTransaction();

    expect(() =>
      collectQuery(db, {
        source: {
          type: "IndexRange",
          indexName: "messages.nonexistent_index",
          range: [],
          order: "asc",
        },
        operators: [],
      }),
    ).toThrow(/not declared/);
    db.rollbackWrites();
  });
});

// ===========================================================================
// 5. Pagination
// ===========================================================================

describe("Integration: Pagination", () => {
  it("first page returns correct number of results", () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) {
      db.insert("items", { n: i });
    }
    db.commit();

    db.startTransaction();
    const page1 = db.paginate({
      query: fullScan("items"),
      cursor: null,
      pageSize: 2,
    });

    expect(page1.page).toHaveLength(2);
    expect(page1.isDone).toBe(false);
    expect(page1.continueCursor).not.toBe("_end_cursor");
    db.rollbackWrites();
  });

  it("subsequent pages continue from cursor", () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) {
      db.insert("items", { n: i });
    }
    db.commit();

    db.startTransaction();
    const page1 = db.paginate({
      query: fullScan("items"),
      cursor: null,
      pageSize: 2,
    });

    const page2 = db.paginate({
      query: fullScan("items"),
      cursor: page1.continueCursor,
      pageSize: 2,
    });

    expect(page2.page).toHaveLength(2);
    const page1Ids = new Set(page1.page.map((d) => d._id));
    for (const doc of page2.page) {
      expect(page1Ids.has(doc._id)).toBe(false);
    }
    db.rollbackWrites();
  });

  it("last page reports isDone", () => {
    const db = freshDb();
    db.insert("items", { n: 1 });
    db.insert("items", { n: 2 });
    db.commit();

    db.startTransaction();
    const page = db.paginate({
      query: fullScan("items"),
      cursor: null,
      pageSize: 10,
    });

    expect(page.page).toHaveLength(2);
    expect(page.isDone).toBe(true);
    expect(page.continueCursor).toBe("_end_cursor");
    db.rollbackWrites();
  });

  it("paginating empty table returns empty page and isDone", () => {
    const db = freshDb();
    db.commit();

    db.startTransaction();
    const page = db.paginate({
      query: fullScan("empty"),
      cursor: null,
      pageSize: 10,
    });

    expect(page.page).toHaveLength(0);
    expect(page.isDone).toBe(true);
    db.rollbackWrites();
  });
});

// ===========================================================================
// 6. Search queries
// ===========================================================================

describe("Integration: Search Queries", () => {
  function searchDb(): Database {
    const db = new Database(messagesSchema());
    db.startTransaction();
    db.insert("messages", { body: "the quick brown fox", author: "alice" });
    db.insert("messages", { body: "the lazy dog", author: "bob" });
    db.insert("messages", { body: "quick quick fox", author: "alice" });
    db.insert("messages", { body: "nothing relevant", author: "charlie" });
    db.commit();
    return db;
  }

  it("text search returns documents matching search terms", () => {
    const db = searchDb();
    db.startTransaction();

    const results = collectQuery(db, {
      source: {
        type: "Search",
        indexName: "messages.search_body",
        filters: [{ type: "Search", fieldPath: "body", value: "quick" }],
      },
      operators: [],
    });

    expect(results).toHaveLength(2);
    expect(
      results.every(
        (r) => typeof r.body === "string" && r.body.includes("quick"),
      ),
    ).toBe(true);
    db.rollbackWrites();
  });

  it("search with equality filter narrows results", () => {
    const db = searchDb();
    db.startTransaction();

    const results = collectQuery(db, {
      source: {
        type: "Search",
        indexName: "messages.search_body",
        filters: [
          { type: "Search", fieldPath: "body", value: "quick" },
          { type: "Eq", fieldPath: "author", value: "alice" },
        ],
      },
      operators: [],
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.author === "alice")).toBe(true);
    db.rollbackWrites();
  });

  it("applies post-search operator filters before enforcing limit", () => {
    const db = new Database(messagesSchema());
    db.startTransaction();
    db.insert("messages", { body: "quick quick fox", author: "alice" });
    db.insert("messages", { body: "quick fox", author: "bob" });
    db.commit();

    db.startTransaction();
    const results = collectQuery(db, {
      source: {
        type: "Search",
        indexName: "messages.search_body",
        filters: [{ type: "Search", fieldPath: "body", value: "quick" }],
      },
      operators: [
        { filter: { $eq: [{ $field: "author" }, { $literal: "bob" }] } },
        { limit: 1 },
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.author).toBe("bob");
    db.rollbackWrites();
  });

  it("search with no matches returns empty", () => {
    const db = searchDb();
    db.startTransaction();

    const results = collectQuery(db, {
      source: {
        type: "Search",
        indexName: "messages.search_body",
        filters: [{ type: "Search", fieldPath: "body", value: "zzzzzzzzz" }],
      },
      operators: [],
    });

    expect(results).toHaveLength(0);
    db.rollbackWrites();
  });

  it("prefix matching works (search term is prefix of a word)", () => {
    const db = searchDb();
    db.startTransaction();

    const results = collectQuery(db, {
      source: {
        type: "Search",
        indexName: "messages.search_body",
        filters: [{ type: "Search", fieldPath: "body", value: "qui" }],
      },
      operators: [],
    });

    expect(results).toHaveLength(2);
    db.rollbackWrites();
  });

  it("only applies prefix matching to the final query term", () => {
    const db = searchDb();
    db.startTransaction();

    const results = collectQuery(db, {
      source: {
        type: "Search",
        indexName: "messages.search_body",
        filters: [{ type: "Search", fieldPath: "body", value: "qui fo" }],
      },
      operators: [],
    });

    expect(results).toHaveLength(0);
    db.rollbackWrites();
  });

  it("uses pending-write search overlay for same-table updates", () => {
    const db = searchDb();
    db.startTransaction();
    const target = collectQuery(db, {
      source: {
        type: "Search",
        indexName: "messages.search_body",
        filters: [{ type: "Search", fieldPath: "body", value: "lazy" }],
      },
      operators: [],
    })[0]!;

    db.patch("messages", target._id as DocumentId, {
      body: "the quick brown fox jumps",
    });

    const results = collectQuery(db, {
      source: {
        type: "Search",
        indexName: "messages.search_body",
        filters: [{ type: "Search", fieldPath: "body", value: "quick" }],
      },
      operators: [],
    });

    expect(results).toHaveLength(3);
    expect(results.some((r) => r._id === target._id)).toBe(true);
    db.rollbackWrites();
  });

  it("keeps overlay search results capped to the requested limit", () => {
    const db = searchDb();
    db.startTransaction();

    db.insert("messages", { body: "quick overlay alpha", author: "dana" });
    db.insert("messages", { body: "quick overlay beta", author: "erin" });

    const results = collectQuery(db, {
      source: {
        type: "Search",
        indexName: "messages.search_body",
        filters: [{ type: "Search", fieldPath: "body", value: "quick" }],
      },
      operators: [{ limit: 1 }],
    });

    expect(results).toHaveLength(1);
    db.rollbackWrites();
  });
});

describe("Integration: Vector Search", () => {
  function vectorDb(): Database {
    const db = new Database(vectorSchema());
    db.startTransaction();
    db.putDocument("embeddings", {
      _id: "alpha",
      _creationTime: 1,
      category: "news",
      status: "active",
      embedding: [1, 0],
    });
    db.putDocument("embeddings", {
      _id: "beta",
      _creationTime: 2,
      category: "notes",
      status: "draft",
      embedding: [0.9, 0.1],
    });
    db.putDocument("embeddings", {
      _id: "gamma",
      _creationTime: 3,
      category: "archive",
      status: "inactive",
      embedding: [0, 1],
    });
    db.commit();
    return db;
  }

  it("supports Convex-style or(eq(), eq()) filters", () => {
    const db = vectorDb();

    const results = db.vectorSearch(
      "embeddings.by_embedding",
      [1, 0],
      vectorOr(vectorEq("category", "news"), vectorEq("status", "draft")),
      10,
    );

    expect(results.map((result) => result._id)).toEqual(["alpha", "beta"]);
  });

  it("rebuilds committed vector index state after replace and delete", () => {
    const db = vectorDb();

    db.startTransaction();
    db.replace("embeddings", "beta" as DocumentId, {
      category: "notes",
      status: "active",
      embedding: [1, 0],
    });
    db.delete("embeddings", "alpha" as DocumentId);
    db.commit();

    const results = db.vectorSearch(
      "embeddings.by_embedding",
      [1, 0],
      vectorEq("status", "active"),
      10,
    );

    expect(results.map((result) => result._id)).toEqual(["beta"]);
  });

  it("uses pending-write vector overlay for same-table updates", () => {
    const db = vectorDb();

    db.startTransaction();
    db.replace("embeddings", "gamma" as DocumentId, {
      category: "archive",
      status: "active",
      embedding: [1, 0],
    });

    const results = db.vectorSearch(
      "embeddings.by_embedding",
      [1, 0],
      vectorEq("status", "active"),
      10,
    );

    expect(results.map((result) => result._id)).toEqual(["alpha", "gamma"]);
    db.rollbackWrites();
  });
});

// ===========================================================================
// 7. Transaction semantics — rollback on error
// ===========================================================================

describe("Integration: Transaction Rollback", () => {
  it("failed mutation does not persist writes", () => {
    const db = freshDb();
    const id = db.insert("tasks", { title: "before-error" });
    db.commit();

    db.startTransaction();
    db.insert("tasks", { title: "should-not-persist" });
    db.patch("tasks", id, { title: "mutated" });
    db.rollbackWrites();

    db.startTransaction();
    const doc = db.get("tasks", id)!;
    expect(doc.title).toBe("before-error");

    const all = collectQuery(db, fullScan("tasks"));
    expect(all).toHaveLength(1);
    db.rollbackWrites();
  });

  it("nested child rollback preserves parent writes", () => {
    const db = freshDb();

    const parentId = db.insert("tasks", { title: "parent" });

    db.startTransaction();
    db.insert("tasks", { title: "child-will-fail" });
    db.rollbackWrites();

    expect(db.get("tasks", parentId)).not.toBeNull();

    db.commit();

    db.startTransaction();
    const all = collectQuery(db, fullScan("tasks"));
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe("parent");
    db.rollbackWrites();
  });

  it("nested child commit merges into parent, both survive outer commit", () => {
    const db = freshDb();

    const id1 = db.insert("tasks", { title: "parent" });

    db.startTransaction();
    const id2 = db.insert("tasks", { title: "child" });
    db.commit();

    db.commit();

    db.startTransaction();
    expect(db.get("tasks", id1)).not.toBeNull();
    expect(db.get("tasks", id2)).not.toBeNull();
    db.rollbackWrites();
  });
});

// ===========================================================================
// 8. MVCC timestamp tracking
// ===========================================================================

describe("Integration: MVCC Timestamps", () => {
  it("starts at 0", () => {
    const db = new Database(null);
    expect(db.timestamp).toBe(0);
  });

  it("increments on each mutation commit with writes", () => {
    const db = freshDb();
    db.insert("tasks", { title: "a" });
    db.commit();
    expect(db.timestamp).toBe(1);

    db.startTransaction();
    db.insert("tasks", { title: "b" });
    db.commit();
    expect(db.timestamp).toBe(2);
  });

  it("does not increment on read-only commit", () => {
    const db = freshDb();
    db.insert("tasks", { title: "a" });
    db.commit();
    expect(db.timestamp).toBe(1);

    db.startTransaction();
    db.commit();
    expect(db.timestamp).toBe(1);
  });

  it("does not increment on rollback", () => {
    const db = freshDb();
    db.insert("tasks", { title: "a" });
    db.rollbackWrites();
    expect(db.timestamp).toBe(0);
  });

  it("commit returns tablesWritten accurately", () => {
    const db = freshDb();
    db.insert("tasks", { title: "a" });
    db.insert("users", { name: "alice" });
    const { tablesWritten } = db.commit();

    expect(tablesWritten.size).toBe(2);
    expect(tablesWritten.has("tasks")).toBe(true);
    expect(tablesWritten.has("users")).toBe(true);
  });

  it("read-only commit returns empty tablesWritten", () => {
    const db = freshDb();
    const { tablesWritten } = db.commit();
    expect(tablesWritten.size).toBe(0);
  });
});

// ===========================================================================
// 9. Subscription invalidation flow
// ===========================================================================

describe("Integration: Subscription Invalidation", () => {
  it("mutation commit triggers subscription callback for written tables", () => {
    const db = new Database(null);
    const subs = new SubscriptionManager();

    const messagesCallback = vi.fn();
    const usersCallback = vi.fn();
    const unrelatedCallback = vi.fn();

    subs.subscribe("q-messages", new Set(["messages"]), messagesCallback);
    subs.subscribe("q-users", new Set(["users"]), usersCallback);
    subs.subscribe("q-other", new Set(["other"]), unrelatedCallback);

    db.startTransaction();
    db.insert("messages", { body: "hello", author: "alice" });
    const { tablesWritten } = db.commit();

    subs.invalidate(tablesWritten);

    expect(messagesCallback).toHaveBeenCalledOnce();
    expect(usersCallback).not.toHaveBeenCalled();
    expect(unrelatedCallback).not.toHaveBeenCalled();
  });

  it("mutation writing multiple tables invalidates all matching subs", () => {
    const db = new Database(null);
    const subs = new SubscriptionManager();

    const cb1 = vi.fn();
    const cb2 = vi.fn();

    subs.subscribe("q1", new Set(["messages", "users"]), cb1);
    subs.subscribe("q2", new Set(["users"]), cb2);

    db.startTransaction();
    db.insert("messages", { body: "hi" });
    db.insert("users", { name: "bob" });
    const { tablesWritten } = db.commit();
    subs.invalidate(tablesWritten);

    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it("rollback does not produce tablesWritten (no invalidation)", () => {
    const db = new Database(null);
    const subs = new SubscriptionManager();
    const cb = vi.fn();
    subs.subscribe("q1", new Set(["tasks"]), cb);

    db.startTransaction();
    db.insert("tasks", { title: "will-be-rolled-back" });
    db.rollbackWrites();

    expect(cb).not.toHaveBeenCalled();
  });

  it("unsubscribe prevents callback after invalidation", () => {
    const subs = new SubscriptionManager();
    const cb = vi.fn();

    const unsub = subs.subscribe("q1", new Set(["tasks"]), cb);
    unsub();

    subs.invalidate(new Set(["tasks"]));
    expect(cb).not.toHaveBeenCalled();
  });

  it("clear removes all subscriptions", () => {
    const subs = new SubscriptionManager();
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    subs.subscribe("q1", new Set(["a"]), cb1);
    subs.subscribe("q2", new Set(["b"]), cb2);
    subs.clear();

    subs.invalidate(new Set(["a", "b"]));
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 10. Complex filter expressions
// ===========================================================================

describe("Integration: Complex Filters", () => {
  it("$and filter", () => {
    const db = freshDb();
    db.insert("items", { kind: "fruit", color: "red" });
    db.insert("items", { kind: "fruit", color: "green" });
    db.insert("items", { kind: "vegetable", color: "green" });
    db.commit();

    db.startTransaction();
    const results = collectQuery(db, {
      source: { type: "FullTableScan", tableName: "items", order: "asc" },
      operators: [
        {
          filter: {
            $and: [
              { $eq: [{ $field: "kind" }, { $literal: "fruit" }] },
              { $eq: [{ $field: "color" }, { $literal: "green" }] },
            ],
          },
        },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("fruit");
    expect(results[0]!.color).toBe("green");
    db.rollbackWrites();
  });

  it("$or filter", () => {
    const db = freshDb();
    db.insert("items", { kind: "apple" });
    db.insert("items", { kind: "banana" });
    db.insert("items", { kind: "cherry" });
    db.commit();

    db.startTransaction();
    const results = collectQuery(db, {
      source: { type: "FullTableScan", tableName: "items", order: "asc" },
      operators: [
        {
          filter: {
            $or: [
              { $eq: [{ $field: "kind" }, { $literal: "apple" }] },
              { $eq: [{ $field: "kind" }, { $literal: "cherry" }] },
            ],
          },
        },
      ],
    });
    expect(results).toHaveLength(2);
    db.rollbackWrites();
  });

  it("$not filter", () => {
    const db = freshDb();
    db.insert("items", { kind: "apple" });
    db.insert("items", { kind: "banana" });
    db.commit();

    db.startTransaction();
    const results = collectQuery(db, {
      source: { type: "FullTableScan", tableName: "items", order: "asc" },
      operators: [
        {
          filter: {
            $not: { $eq: [{ $field: "kind" }, { $literal: "apple" }] },
          },
        },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("banana");
    db.rollbackWrites();
  });

  it("$neq filter", () => {
    const db = freshDb();
    db.insert("items", { n: 1 });
    db.insert("items", { n: 2 });
    db.insert("items", { n: 3 });
    db.commit();

    db.startTransaction();
    const results = collectQuery(db, {
      source: { type: "FullTableScan", tableName: "items", order: "asc" },
      operators: [{ filter: { $neq: [{ $field: "n" }, { $literal: 2 }] } }],
    });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.n)).toEqual([1, 3]);
    db.rollbackWrites();
  });

  it("comparison filters ($gt, $gte, $lt, $lte)", () => {
    const db = freshDb();
    for (let i = 1; i <= 5; i++) {
      db.insert("items", { n: i });
    }
    db.commit();

    db.startTransaction();

    const gt = collectQuery(db, {
      source: { type: "FullTableScan", tableName: "items", order: "asc" },
      operators: [{ filter: { $gt: [{ $field: "n" }, { $literal: 3 }] } }],
    });
    expect(gt).toHaveLength(2);

    const gte = collectQuery(db, {
      source: { type: "FullTableScan", tableName: "items", order: "asc" },
      operators: [{ filter: { $gte: [{ $field: "n" }, { $literal: 3 }] } }],
    });
    expect(gte).toHaveLength(3);

    const lt = collectQuery(db, {
      source: { type: "FullTableScan", tableName: "items", order: "asc" },
      operators: [{ filter: { $lt: [{ $field: "n" }, { $literal: 3 }] } }],
    });
    expect(lt).toHaveLength(2);

    const lte = collectQuery(db, {
      source: { type: "FullTableScan", tableName: "items", order: "asc" },
      operators: [{ filter: { $lte: [{ $field: "n" }, { $literal: 3 }] } }],
    });
    expect(lte).toHaveLength(3);

    db.rollbackWrites();
  });
});

// ===========================================================================
// 11. Reads through write stack (snapshot isolation)
// ===========================================================================

describe("Integration: Snapshot Isolation", () => {
  it("uncommitted writes are visible within the same transaction", () => {
    const db = freshDb();
    const id = db.insert("tasks", { title: "in-flight" });

    const doc = db.get("tasks", id);
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe("in-flight");
    db.rollbackWrites();
  });

  it("writes are not visible to a later transaction if rolled back", () => {
    const db = freshDb();
    const id = db.insert("tasks", { title: "ephemeral" });
    db.rollbackWrites();

    db.startTransaction();
    expect(db.get("tasks", id)).toBeNull();
    db.rollbackWrites();
  });

  it("queries see pending writes in the same transaction", () => {
    const db = freshDb();
    db.insert("items", { n: 1 });
    db.insert("items", { n: 2 });

    const results = collectQuery(db, fullScan("items"));
    expect(results).toHaveLength(2);
    db.commit();
  });

  it("delete is visible to reads within the same transaction", () => {
    const db = freshDb();
    const id = db.insert("tasks", { title: "a" });
    db.commit();

    db.startTransaction();
    db.delete("tasks", id);

    const results = collectQuery(db, fullScan("tasks"));
    expect(results).toHaveLength(0);
    db.commit();
  });
});

// ===========================================================================
// 12. Edge cases and error handling
// ===========================================================================

describe("Integration: Error Cases", () => {
  it("write outside transaction throws", () => {
    const db = new Database(null);
    expect(() => db.insert("tasks", { title: "fail" })).toThrow(
      /outside of transaction/,
    );
  });

  it("commit without transaction throws", () => {
    const db = new Database(null);
    expect(() => db.commit()).toThrow(/already committed or rolled back/);
  });

  it("rollback without transaction throws", () => {
    const db = new Database(null);
    expect(() => db.rollbackWrites()).toThrow(
      /already committed or rolled back/,
    );
  });

  it("patch on non-existent document throws", () => {
    const db = freshDb();
    expect(() => db.patch("tasks", MISSING_ID, { x: 1 })).toThrow(
      /non-existent/,
    );
    db.rollbackWrites();
  });

  it("delete on non-existent document throws", () => {
    const db = freshDb();
    expect(() => db.delete("tasks", MISSING_ID)).toThrow(/non-existent/);
    db.rollbackWrites();
  });

  it("replace on non-existent document throws", () => {
    const db = freshDb();
    expect(() => db.replace("tasks", MISSING_ID, { title: "new" })).toThrow(
      /non-existent/,
    );
    db.rollbackWrites();
  });

  it("patch with mismatched _id throws", () => {
    const db = freshDb();
    const id = db.insert("tasks", { title: "a" });
    expect(() => db.patch("tasks", id, { _id: MISSING_ID })).toThrow(
      /does not match/,
    );
    db.rollbackWrites();
  });

  it("replace with mismatched _id throws", () => {
    const db = freshDb();
    const id = db.insert("tasks", { title: "a" });
    expect(() =>
      db.replace("tasks", id, { _id: MISSING_ID, title: "b" }),
    ).toThrow(/does not match/);
    db.rollbackWrites();
  });

  it("get with wrong table name throws", () => {
    const db = freshDb();
    const id = db.insert("tasks", { title: "a" });
    expect(() => db.get("users", id)).toThrow(/expected ID in table/);
    db.rollbackWrites();
  });

  it("queryNext with invalid queryId throws", () => {
    const db = freshDb();
    expect(() => db.queryNext(999999)).toThrow(/Bad queryId/);
    db.rollbackWrites();
  });
});

// ===========================================================================
// 13. _creationTime monotonicity
// ===========================================================================

describe("Integration: _creationTime", () => {
  it("_creationTime values are monotonically increasing", () => {
    const db = freshDb();
    const ids: DocumentId[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(db.insert("items", { n: i }));
    }

    const times = ids.map((id) => db.get("items", id)!._creationTime);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    }
    db.commit();
  });
});

// ===========================================================================
// 14. ID format
// ===========================================================================

describe("Integration: ID Format", () => {
  it("generated IDs are UUIDs", () => {
    const db = freshDb();
    const id1 = db.insert("tasks", { title: "a" });
    const id2 = db.insert("users", { name: "b" });

    expect(id1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(id2).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    db.commit();
  });

  it("IDs are globally unique across tables", () => {
    const db = freshDb();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      ids.add(db.insert("tasks", { n: i }));
      ids.add(db.insert("users", { n: i }));
    }
    expect(ids.size).toBe(40);
    db.commit();
  });
});
