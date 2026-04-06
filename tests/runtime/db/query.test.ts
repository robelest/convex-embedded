import { Database } from "@embedded/runtime/db/database";
import { evaluateFieldPath, evaluateFilter } from "@embedded/runtime/db/query";
import type { ParsedSchema } from "@embedded/runtime/db/schema";
import type {
  SerializedQuery,
  VectorSearchExpression,
} from "@embedded/runtime/db/types";
import { describe, it, expect } from "vite-plus/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a schema-less DB, insert some docs, and commit. */
function seedDb(
  table: string,
  docs: Record<string, any>[],
  schema: ParsedSchema | null = null,
): Database {
  const db = new Database(schema);
  db.startTransaction();
  for (const doc of docs) {
    db.insert(table, doc);
  }
  db.commit();
  return db;
}

/** Yield all results from a streaming query. */
function* iterateQuery(db: Database, queryId: number) {
  let next = db.queryNext(queryId);
  while (!next.done) {
    yield next.value;
    next = db.queryNext(queryId);
  }
}

/** Drain all results from a streaming query. */
const drainQuery = (db: Database, queryId: number): any[] =>
  Array.from(iterateQuery(db, queryId));

/** Build a FullTableScan query. */
function fullScan(
  tableName: string,
  order: "asc" | "desc" = "asc",
  operators: any[] = [],
): SerializedQuery {
  return {
    source: { type: "FullTableScan", tableName, order },
    operators,
  };
}

// Schema with an index on "status" for the "tasks" table.
const schemaWithIndex: ParsedSchema = {
  schemaValidation: false,
  tables: new Map([
    [
      "tasks",
      {
        indexes: [{ indexDescriptor: "by_status", fields: ["status"] }],
        vectorIndexes: [],
        searchIndexes: [
          {
            indexDescriptor: "search_body",
            searchField: "body",
            filterFields: ["status"],
          },
        ],
        documentType: { type: "any" },
      },
    ],
  ]),
};

const schemaWithVectorIndex: ParsedSchema = {
  schemaValidation: false,
  tables: new Map([
    [
      "tasks",
      {
        indexes: [],
        vectorIndexes: [
          {
            indexDescriptor: "by_embedding",
            vectorField: "embedding",
            dimensions: 2,
            filterFields: ["status", "priority"],
          },
        ],
        searchIndexes: [],
        documentType: { type: "any" },
      },
    ],
  ]),
};

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

// ---------------------------------------------------------------------------
// Full table scan
// ---------------------------------------------------------------------------

describe("QueryEngine — full table scan", () => {
  it("returns all docs in a table, sorted by _creationTime asc", () => {
    const db = seedDb("tasks", [
      { title: "first" },
      { title: "second" },
      { title: "third" },
    ]);
    db.startTransaction();
    const qId = db.startQuery(fullScan("tasks", "asc"));
    const results = drainQuery(db, qId);
    db.commit();

    expect(results).toHaveLength(3);
    expect(results[0].title).toBe("first");
    expect(results[1].title).toBe("second");
    expect(results[2].title).toBe("third");
  });

  it("returns empty array for an empty table", () => {
    const db = new Database(null);
    db.startTransaction();
    const qId = db.startQuery(fullScan("tasks", "asc"));
    const results = drainQuery(db, qId);
    db.commit();

    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Full table scan descending
// ---------------------------------------------------------------------------

describe("QueryEngine — full table scan desc", () => {
  it('order "desc" reverses the result order', () => {
    const db = seedDb("tasks", [
      { title: "first" },
      { title: "second" },
      { title: "third" },
    ]);
    db.startTransaction();
    const qId = db.startQuery(fullScan("tasks", "desc"));
    const results = drainQuery(db, qId);
    db.commit();

    expect(results).toHaveLength(3);
    expect(results[0].title).toBe("third");
    expect(results[1].title).toBe("second");
    expect(results[2].title).toBe("first");
  });
});

// ---------------------------------------------------------------------------
// Filter operator
// ---------------------------------------------------------------------------

describe("QueryEngine — filter operator", () => {
  it("$eq filter selects matching docs", () => {
    const db = seedDb("tasks", [
      { title: "a", status: "active" },
      { title: "b", status: "done" },
      { title: "c", status: "active" },
    ]);
    db.startTransaction();
    const qId = db.startQuery(
      fullScan("tasks", "asc", [
        {
          filter: {
            $eq: [{ $field: "status" }, { $literal: "active" }],
          },
        },
      ]),
    );
    const results = drainQuery(db, qId);
    db.commit();

    expect(results).toHaveLength(2);
    expect(results.every((d: any) => d.status === "active")).toBe(true);
  });

  it("$neq filter excludes matching docs", () => {
    const db = seedDb("tasks", [
      { title: "a", status: "active" },
      { title: "b", status: "done" },
    ]);
    db.startTransaction();
    const qId = db.startQuery(
      fullScan("tasks", "asc", [
        {
          filter: {
            $neq: [{ $field: "status" }, { $literal: "done" }],
          },
        },
      ]),
    );
    const results = drainQuery(db, qId);
    db.commit();

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Limit operator
// ---------------------------------------------------------------------------

describe("QueryEngine — limit operator", () => {
  it("limit caps the number of results", () => {
    const db = seedDb("tasks", [
      { title: "a" },
      { title: "b" },
      { title: "c" },
      { title: "d" },
      { title: "e" },
    ]);
    db.startTransaction();
    const qId = db.startQuery(fullScan("tasks", "asc", [{ limit: 3 }]));
    const results = drainQuery(db, qId);
    db.commit();

    expect(results).toHaveLength(3);
    expect(results[0].title).toBe("a");
    expect(results[2].title).toBe("c");
  });
});

// ---------------------------------------------------------------------------
// Combined filter + limit
// ---------------------------------------------------------------------------

describe("QueryEngine — filter + limit", () => {
  it("filter is applied before limit", () => {
    const db = seedDb("tasks", [
      { title: "a", status: "active" },
      { title: "b", status: "done" },
      { title: "c", status: "active" },
      { title: "d", status: "active" },
      { title: "e", status: "active" },
    ]);
    db.startTransaction();
    const qId = db.startQuery(
      fullScan("tasks", "asc", [
        {
          filter: {
            $eq: [{ $field: "status" }, { $literal: "active" }],
          },
        },
        { limit: 2 },
      ]),
    );
    const results = drainQuery(db, qId);
    db.commit();

    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("a");
    expect(results[1].title).toBe("c");
  });
});

// ---------------------------------------------------------------------------
// Vector search
// ---------------------------------------------------------------------------

describe("QueryEngine — vector search", () => {
  it("applies equality filters before scoring", () => {
    const db = seedDb(
      "tasks",
      [
        { title: "active-a", status: "active", priority: 1, embedding: [1, 0] },
        { title: "done-b", status: "done", priority: 2, embedding: [0, 1] },
        {
          title: "active-c",
          status: "active",
          priority: 3,
          embedding: [0.8, 0.2],
        },
      ],
      schemaWithVectorIndex,
    );

    const results = db.vectorSearch(
      "tasks.by_embedding",
      [1, 0],
      vectorEq("status", "active"),
      5,
    );

    expect(results).toHaveLength(2);
    expect(results[0]._score).toBeGreaterThanOrEqual(results[1]._score);
  });

  it("supports or filters across multiple filter fields", () => {
    const db = seedDb(
      "tasks",
      [
        { title: "active", status: "active", priority: 1, embedding: [1, 0] },
        { title: "urgent", status: "done", priority: 3, embedding: [0.9, 0.1] },
        { title: "other", status: "done", priority: 9, embedding: [0.7, 0.3] },
      ],
      schemaWithVectorIndex,
    );

    const results = db.vectorSearch(
      "tasks.by_embedding",
      [1, 0],
      vectorOr(vectorEq("status", "active"), vectorEq("priority", 3)),
      5,
    );

    expect(results).toHaveLength(2);
    expect(results.map((result) => result._id)).toHaveLength(2);
  });

  it("breaks ties by _id ascending", () => {
    const db = new Database(schemaWithVectorIndex);
    db.startTransaction();
    db.putDocument("tasks", {
      _id: "bbb",
      _creationTime: 1,
      title: "second",
      status: "active",
      priority: 1,
      embedding: [1, 0],
    });
    db.putDocument("tasks", {
      _id: "aaa",
      _creationTime: 2,
      title: "first",
      status: "active",
      priority: 1,
      embedding: [1, 0],
    });
    db.commit();

    const results = db.vectorSearch("tasks.by_embedding", [1, 0], null, 5);

    expect(results.map((result) => result._id)).toEqual(["aaa", "bbb"]);
  });

  it("returns zero scores for a zero query vector", () => {
    const db = new Database(schemaWithVectorIndex);
    db.startTransaction();
    db.putDocument("tasks", {
      _id: "bbb",
      _creationTime: 1,
      title: "second",
      status: "active",
      priority: 1,
      embedding: [0, 1],
    });
    db.putDocument("tasks", {
      _id: "aaa",
      _creationTime: 2,
      title: "first",
      status: "active",
      priority: 1,
      embedding: [1, 0],
    });
    db.commit();

    const results = db.vectorSearch("tasks.by_embedding", [0, 0], null, 5);

    expect(results).toEqual([
      { _id: "aaa", _score: 0 },
      { _id: "bbb", _score: 0 },
    ]);
  });

  it("defaults the limit to 10", () => {
    const docs = Array.from({ length: 12 }, (_, index) => ({
      title: `task-${index}`,
      status: "active",
      priority: index,
      embedding: [1, 0],
    }));
    const db = seedDb("tasks", docs, schemaWithVectorIndex);

    const results = db.vectorSearch("tasks.by_embedding", [1, 0], null);

    expect(results).toHaveLength(10);
  });

  it("throws when query dimensions do not match the index", () => {
    const db = seedDb(
      "tasks",
      [{ title: "a", status: "active", priority: 1, embedding: [1, 0] }],
      schemaWithVectorIndex,
    );

    expect(() =>
      db.vectorSearch("tasks.by_embedding", [1, 0, 0], null, 5),
    ).toThrow(/exactly 2 dimensions/);
  });

  it("throws when filtering on a field outside filterFields", () => {
    const db = seedDb(
      "tasks",
      [{ title: "a", status: "active", priority: 1, embedding: [1, 0] }],
      schemaWithVectorIndex,
    );

    expect(() =>
      db.vectorSearch("tasks.by_embedding", [1, 0], vectorEq("title", "a"), 5),
    ).toThrow(/does not allow equality filter on "title"/);
  });

  it("skips stored vectors with the wrong dimensions", () => {
    const db = seedDb(
      "tasks",
      [
        { title: "valid", status: "active", priority: 1, embedding: [1, 0] },
        {
          title: "invalid",
          status: "active",
          priority: 2,
          embedding: [1, 0, 0],
        },
      ],
      schemaWithVectorIndex,
    );

    const results = db.vectorSearch("tasks.by_embedding", [1, 0], null, 5);

    expect(results).toHaveLength(1);
  });

  it("falls back to pending writes so read-your-own-writes still works", () => {
    const db = seedDb(
      "tasks",
      [{ title: "committed", status: "done", priority: 1, embedding: [0, 1] }],
      schemaWithVectorIndex,
    );

    db.startTransaction();
    db.insert("tasks", {
      title: "pending",
      status: "active",
      priority: 2,
      embedding: [1, 0],
    });

    const results = db.vectorSearch(
      "tasks.by_embedding",
      [1, 0],
      vectorEq("status", "active"),
      5,
    );

    expect(results).toHaveLength(1);
    db.rollbackWrites();
  });
});

// ---------------------------------------------------------------------------
// Index range scan
// ---------------------------------------------------------------------------

describe("QueryEngine — index range scan", () => {
  it("Eq range expression filters on the indexed field", () => {
    const db = seedDb(
      "tasks",
      [
        { title: "a", status: "active" },
        { title: "b", status: "done" },
        { title: "c", status: "active" },
      ],
      schemaWithIndex,
    );
    db.startTransaction();
    const qId = db.startQuery({
      source: {
        type: "IndexRange",
        indexName: "tasks.by_status",
        range: [{ type: "Eq", fieldPath: "status", value: "active" }],
        order: "asc",
      },
      operators: [],
    });
    const results = drainQuery(db, qId);
    db.commit();

    expect(results).toHaveLength(2);
    expect(results.every((d: any) => d.status === "active")).toBe(true);
  });

  it("Gt range expression filters correctly", () => {
    const db = seedDb(
      "tasks",
      [
        { title: "a", status: "alpha" },
        { title: "b", status: "beta" },
        { title: "c", status: "gamma" },
      ],
      schemaWithIndex,
    );
    db.startTransaction();
    const qId = db.startQuery({
      source: {
        type: "IndexRange",
        indexName: "tasks.by_status",
        range: [{ type: "Gt", fieldPath: "status", value: "beta" }],
        order: "asc",
      },
      operators: [],
    });
    const results = drainQuery(db, qId);
    db.commit();

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("gamma");
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe("QueryEngine — search", () => {
  it("text search matches documents with prefix matching", () => {
    const db = seedDb(
      "tasks",
      [
        { title: "a", body: "hello world" },
        { title: "b", body: "help me please" },
        { title: "c", body: "goodbye world" },
      ],
      schemaWithIndex,
    );
    db.startTransaction();
    const qId = db.startQuery({
      source: {
        type: "Search",
        indexName: "tasks.search_body",
        filters: [{ type: "Search", fieldPath: "body", value: "hel" }],
      },
      operators: [],
    });
    const results = drainQuery(db, qId);
    db.commit();

    // "hello world" and "help me please" both have words starting with "hel"
    expect(results).toHaveLength(2);
    const titles = results
      .map((d: any) => d.title)
      .sort((a, b) => a.localeCompare(b));
    expect(titles).toEqual(["a", "b"]);
  });

  it("only applies prefix matching to the final query term", () => {
    const db = seedDb(
      "tasks",
      [
        { title: "a", body: "quick brown fox" },
        { title: "b", body: "quick fox jumps" },
      ],
      schemaWithIndex,
    );
    db.startTransaction();
    const qId = db.startQuery({
      source: {
        type: "Search",
        indexName: "tasks.search_body",
        filters: [{ type: "Search", fieldPath: "body", value: "qui fo" }],
      },
      operators: [],
    });
    const results = drainQuery(db, qId);
    db.commit();

    expect(results).toHaveLength(0);
  });

  it("normalizes case and punctuation like Convex search", () => {
    const db = seedDb(
      "tasks",
      [
        { title: "a", body: "Hello, WORLD!" },
        { title: "b", body: "nothing here" },
      ],
      schemaWithIndex,
    );
    db.startTransaction();
    const qId = db.startQuery({
      source: {
        type: "Search",
        indexName: "tasks.search_body",
        filters: [{ type: "Search", fieldPath: "body", value: "hello wor" }],
      },
      operators: [],
    });
    const results = drainQuery(db, qId);
    db.commit();

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("a");
  });

  it("orders equal-scoring matches by newest document first", () => {
    const db = seedDb(
      "tasks",
      [
        { title: "older", body: "quick fox" },
        { title: "newer", body: "quick fox" },
      ],
      schemaWithIndex,
    );
    db.startTransaction();
    const qId = db.startQuery({
      source: {
        type: "Search",
        indexName: "tasks.search_body",
        filters: [{ type: "Search", fieldPath: "body", value: "quick fox" }],
      },
      operators: [],
    });
    const results = drainQuery(db, qId);
    db.commit();

    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("newer");
    expect(results[1].title).toBe("older");
  });

  it("search with Eq filter narrows results", () => {
    const db = seedDb(
      "tasks",
      [
        { title: "a", body: "hello world", status: "active" },
        { title: "b", body: "hello there", status: "done" },
      ],
      schemaWithIndex,
    );
    db.startTransaction();
    const qId = db.startQuery({
      source: {
        type: "Search",
        indexName: "tasks.search_body",
        filters: [
          { type: "Search", fieldPath: "body", value: "hello" },
          { type: "Eq", fieldPath: "status", value: "active" },
        ],
      },
      operators: [],
    });
    const results = drainQuery(db, qId);
    db.commit();

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("a");
  });

  it("throws when searching on the wrong field for the search index", () => {
    const db = seedDb(
      "tasks",
      [{ title: "a", body: "hello world", status: "active" }],
      schemaWithIndex,
    );
    db.startTransaction();

    expect(() =>
      db.startQuery({
        source: {
          type: "Search",
          indexName: "tasks.search_body",
          filters: [{ type: "Search", fieldPath: "title", value: "hello" }],
        },
        operators: [],
      }),
    ).toThrow(/expects searchField "body"/);
    db.rollbackWrites();
  });

  it("throws when using a non-filter field as an Eq search filter", () => {
    const db = seedDb(
      "tasks",
      [{ title: "a", body: "hello world", status: "active" }],
      schemaWithIndex,
    );
    db.startTransaction();

    expect(() =>
      db.startQuery({
        source: {
          type: "Search",
          indexName: "tasks.search_body",
          filters: [
            { type: "Search", fieldPath: "body", value: "hello" },
            { type: "Eq", fieldPath: "title", value: "a" },
          ],
        },
        operators: [],
      }),
    ).toThrow(/does not allow equality filter on "title"/);
    db.rollbackWrites();
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe("QueryEngine — pagination", () => {
  it("returns a page of results with cursor-based pagination", () => {
    const db = seedDb("tasks", [
      { title: "a" },
      { title: "b" },
      { title: "c" },
      { title: "d" },
      { title: "e" },
    ]);
    db.startTransaction();

    // First page.
    const page1 = db.paginate({
      query: fullScan("tasks", "asc"),
      cursor: null,
      pageSize: 2,
    });
    expect(page1.page).toHaveLength(2);
    expect(page1.page[0].title).toBe("a");
    expect(page1.page[1].title).toBe("b");
    expect(page1.isDone).toBe(false);

    // Second page — use continueCursor from first page.
    const page2 = db.paginate({
      query: fullScan("tasks", "asc"),
      cursor: page1.continueCursor,
      pageSize: 2,
    });
    expect(page2.page).toHaveLength(2);
    expect(page2.page[0].title).toBe("c");
    expect(page2.page[1].title).toBe("d");

    // Third page.
    const page3 = db.paginate({
      query: fullScan("tasks", "asc"),
      cursor: page2.continueCursor,
      pageSize: 2,
    });
    expect(page3.page).toHaveLength(1);
    expect(page3.page[0].title).toBe("e");
    expect(page3.isDone).toBe(true);

    db.commit();
  });

  it("returns all results in one page when pageSize >= doc count", () => {
    const db = seedDb("tasks", [{ title: "a" }, { title: "b" }]);
    db.startTransaction();

    const result = db.paginate({
      query: fullScan("tasks", "asc"),
      cursor: null,
      pageSize: 10,
    });
    expect(result.page).toHaveLength(2);
    expect(result.isDone).toBe(true);
    db.commit();
  });
});

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

describe("QueryEngine — count", () => {
  it("returns document count for a table", () => {
    const db = seedDb("tasks", [
      { title: "a" },
      { title: "b" },
      { title: "c" },
    ]);
    db.startTransaction();
    expect(db.count("tasks")).toBe(3);
    db.commit();
  });

  it("returns 0 for an empty table", () => {
    const db = new Database(null);
    db.startTransaction();
    expect(db.count("tasks")).toBe(0);
    db.commit();
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe("QueryEngine — ordering", () => {
  it("ascending order returns docs by _creationTime asc", () => {
    const db = seedDb("tasks", [
      { title: "first" },
      { title: "second" },
      { title: "third" },
    ]);
    db.startTransaction();
    const qId = db.startQuery(fullScan("tasks", "asc"));
    const results = drainQuery(db, qId);
    db.commit();

    for (let i = 1; i < results.length; i++) {
      expect(results[i]._creationTime).toBeGreaterThanOrEqual(
        results[i - 1]._creationTime,
      );
    }
  });

  it("descending order returns docs by _creationTime desc", () => {
    const db = seedDb("tasks", [
      { title: "first" },
      { title: "second" },
      { title: "third" },
    ]);
    db.startTransaction();
    const qId = db.startQuery(fullScan("tasks", "desc"));
    const results = drainQuery(db, qId);
    db.commit();

    for (let i = 1; i < results.length; i++) {
      expect(results[i]._creationTime).toBeLessThanOrEqual(
        results[i - 1]._creationTime,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// evaluateFieldPath
// ---------------------------------------------------------------------------

describe("evaluateFieldPath", () => {
  it("resolves a top-level field", () => {
    expect(evaluateFieldPath("name", { name: "alice" })).toBe("alice");
  });

  it("resolves a nested field path", () => {
    expect(evaluateFieldPath("a.b", { a: { b: 1 } })).toBe(1);
  });

  it("resolves a deeply nested field path", () => {
    expect(evaluateFieldPath("a.b.c", { a: { b: { c: "deep" } } })).toBe(
      "deep",
    );
  });

  it("returns undefined for a missing path", () => {
    expect(evaluateFieldPath("missing", { name: "alice" })).toBeUndefined();
  });

  it("returns undefined for a partially missing nested path", () => {
    expect(evaluateFieldPath("a.b.c", { a: { b: 1 } })).toBeUndefined();
  });

  it("returns undefined when traversing through null", () => {
    expect(evaluateFieldPath("a.b", { a: null })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// evaluateFilter
// ---------------------------------------------------------------------------

describe("evaluateFilter", () => {
  const doc = { name: "alice", age: 30, active: true };

  describe("$field", () => {
    it("extracts a field value", () => {
      expect(evaluateFilter(doc, { $field: "name" })).toBe("alice");
    });
  });

  describe("$literal", () => {
    it("returns a literal value", () => {
      expect(evaluateFilter(doc, { $literal: 42 })).toBe(42);
    });

    it("returns a literal string", () => {
      expect(evaluateFilter(doc, { $literal: "hello" })).toBe("hello");
    });

    it("returns null without throwing", () => {
      expect(evaluateFilter(doc, { $literal: null })).toBeNull();
    });
  });

  describe("$eq", () => {
    it("returns true for equal values", () => {
      expect(
        evaluateFilter(doc, {
          $eq: [{ $field: "name" }, { $literal: "alice" }],
        }),
      ).toBe(true);
    });

    it("returns false for non-equal values", () => {
      expect(
        evaluateFilter(doc, {
          $eq: [{ $field: "name" }, { $literal: "bob" }],
        }),
      ).toBe(false);
    });

    it("compares null values without throwing", () => {
      expect(
        evaluateFilter(
          { name: "alice", nickname: null },
          {
            $eq: [{ $field: "nickname" }, { $literal: null }],
          },
        ),
      ).toBe(true);
    });
  });

  describe("$neq", () => {
    it("returns true for non-equal values", () => {
      expect(
        evaluateFilter(doc, {
          $neq: [{ $field: "name" }, { $literal: "bob" }],
        }),
      ).toBe(true);
    });

    it("returns false for equal values", () => {
      expect(
        evaluateFilter(doc, {
          $neq: [{ $field: "name" }, { $literal: "alice" }],
        }),
      ).toBe(false);
    });
  });

  describe("$gt", () => {
    it("returns true when left > right", () => {
      expect(
        evaluateFilter(doc, {
          $gt: [{ $field: "age" }, { $literal: 20 }],
        }),
      ).toBe(true);
    });

    it("returns false when left <= right", () => {
      expect(
        evaluateFilter(doc, {
          $gt: [{ $field: "age" }, { $literal: 30 }],
        }),
      ).toBe(false);
    });
  });

  describe("$lt", () => {
    it("returns true when left < right", () => {
      expect(
        evaluateFilter(doc, {
          $lt: [{ $field: "age" }, { $literal: 40 }],
        }),
      ).toBe(true);
    });

    it("returns false when left >= right", () => {
      expect(
        evaluateFilter(doc, {
          $lt: [{ $field: "age" }, { $literal: 30 }],
        }),
      ).toBe(false);
    });
  });

  describe("$gte", () => {
    it("returns true when left >= right (equal)", () => {
      expect(
        evaluateFilter(doc, {
          $gte: [{ $field: "age" }, { $literal: 30 }],
        }),
      ).toBe(true);
    });

    it("returns true when left > right", () => {
      expect(
        evaluateFilter(doc, {
          $gte: [{ $field: "age" }, { $literal: 20 }],
        }),
      ).toBe(true);
    });
  });

  describe("$lte", () => {
    it("returns true when left <= right (equal)", () => {
      expect(
        evaluateFilter(doc, {
          $lte: [{ $field: "age" }, { $literal: 30 }],
        }),
      ).toBe(true);
    });

    it("returns false when left > right", () => {
      expect(
        evaluateFilter(doc, {
          $lte: [{ $field: "age" }, { $literal: 20 }],
        }),
      ).toBe(false);
    });
  });

  describe("$and", () => {
    it("returns true when all conditions are true", () => {
      expect(
        evaluateFilter(doc, {
          $and: [
            { $eq: [{ $field: "name" }, { $literal: "alice" }] },
            { $gt: [{ $field: "age" }, { $literal: 20 }] },
          ],
        }),
      ).toBe(true);
    });

    it("returns false when one condition is false", () => {
      expect(
        evaluateFilter(doc, {
          $and: [
            { $eq: [{ $field: "name" }, { $literal: "alice" }] },
            { $gt: [{ $field: "age" }, { $literal: 50 }] },
          ],
        }),
      ).toBe(false);
    });
  });

  describe("$or", () => {
    it("returns true when at least one condition is true", () => {
      expect(
        evaluateFilter(doc, {
          $or: [
            { $eq: [{ $field: "name" }, { $literal: "bob" }] },
            { $eq: [{ $field: "name" }, { $literal: "alice" }] },
          ],
        }),
      ).toBe(true);
    });

    it("returns false when no conditions are true", () => {
      expect(
        evaluateFilter(doc, {
          $or: [
            { $eq: [{ $field: "name" }, { $literal: "bob" }] },
            { $eq: [{ $field: "name" }, { $literal: "charlie" }] },
          ],
        }),
      ).toBe(false);
    });
  });

  describe("$not", () => {
    it("negates a true condition to false", () => {
      // name === "alice" is true, so $not makes it false
      expect(
        evaluateFilter(doc, {
          $not: { $eq: [{ $field: "name" }, { $literal: "alice" }] },
        }),
      ).toBe(false);
    });

    it("negates a false condition to true", () => {
      // name === "bob" is false, so $not makes it true
      expect(
        evaluateFilter(doc, {
          $not: { $eq: [{ $field: "name" }, { $literal: "bob" }] },
        }),
      ).toBe(true);
    });
  });

  describe("arithmetic operators", () => {
    it("$add adds two values", () => {
      expect(
        evaluateFilter(doc, {
          $add: [{ $field: "age" }, { $literal: 10 }],
        }),
      ).toBe(40);
    });

    it("$sub subtracts two values", () => {
      expect(
        evaluateFilter(doc, {
          $sub: [{ $field: "age" }, { $literal: 5 }],
        }),
      ).toBe(25);
    });

    it("$mul multiplies two values", () => {
      expect(
        evaluateFilter(doc, {
          $mul: [{ $field: "age" }, { $literal: 2 }],
        }),
      ).toBe(60);
    });

    it("$div divides two values", () => {
      expect(
        evaluateFilter(doc, {
          $div: [{ $field: "age" }, { $literal: 3 }],
        }),
      ).toBe(10);
    });

    it("$mod computes the modulus", () => {
      expect(
        evaluateFilter(doc, {
          $mod: [{ $field: "age" }, { $literal: 7 }],
        }),
      ).toBe(2); // 30 % 7 = 2
    });
  });
});
