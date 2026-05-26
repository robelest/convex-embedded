import { Database } from "@embedded/runtime/db/database";
import { evaluateFieldPath, evaluateFilter } from "@embedded/runtime/db/query";
import type { ParsedSchema } from "@embedded/runtime/db/schema";
import type {
  GenericDocument,
  QueryId,
  QueryOperator,
  SerializedQuery,
  VectorSearchExpression,
} from "@embedded/runtime/db/types";
import { describe, expect, it } from "@tests/testkit";

function seedDb(
  table: string,
  docs: ReadonlyArray<Record<string, unknown>>,
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

function drainQuery(db: Database, queryId: QueryId): GenericDocument[] {
  const rows: GenericDocument[] = [];
  for (;;) {
    const next = db.queryNext(queryId);
    if (next.done) break;
    if (next.value !== null) rows.push(next.value);
  }
  return rows;
}

function fullScan(
  tableName: string,
  order: "asc" | "desc" = "asc",
  operators: QueryOperator[] = [],
): SerializedQuery {
  return {
    source: { type: "FullTableScan", tableName, order },
    operators,
  };
}

const eqFilter = (field: string, value: unknown): QueryOperator => ({
  filter: { $eq: [{ $field: field }, { $literal: value as never }] },
});

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
  return { $eq: [{ $field: fieldPath }, { $literal: value as never }] };
}

function vectorOr(
  ...expressions: VectorSearchExpression[]
): VectorSearchExpression {
  return { $or: expressions };
}

describe.concurrent("QueryEngine — full table scan", () => {
  it("returns all docs sorted by _creationTime ascending", () => {
    const db = seedDb("tasks", [
      { title: "first" },
      { title: "second" },
      { title: "third" },
    ]);

    db.startTransaction();
    const results = drainQuery(db, db.startQuery(fullScan("tasks", "asc")));
    db.commit();

    expect(results.map((doc) => doc.title)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("returns an empty array for an empty table", () => {
    const db = new Database(null);

    db.startTransaction();
    const results = drainQuery(db, db.startQuery(fullScan("tasks", "asc")));
    db.commit();

    expect(results).toHaveLength(0);
  });

  it("reverses the order when desc is requested", () => {
    const db = seedDb("tasks", [
      { title: "first" },
      { title: "second" },
      { title: "third" },
    ]);

    db.startTransaction();
    const results = drainQuery(db, db.startQuery(fullScan("tasks", "desc")));
    db.commit();

    expect(results.map((doc) => doc.title)).toEqual([
      "third",
      "second",
      "first",
    ]);
  });
});

describe.concurrent("QueryEngine — filter operator", () => {
  it("$eq selects matching docs", () => {
    const db = seedDb("tasks", [
      { title: "a", status: "active" },
      { title: "b", status: "done" },
      { title: "c", status: "active" },
    ]);

    db.startTransaction();
    const results = drainQuery(
      db,
      db.startQuery(fullScan("tasks", "asc", [eqFilter("status", "active")])),
    );
    db.commit();

    expect(results).toHaveLength(2);
    expect(results.every((doc) => doc.status === "active")).toBe(true);
  });

  it("$neq excludes matching docs", () => {
    const db = seedDb("tasks", [
      { title: "a", status: "active" },
      { title: "b", status: "done" },
    ]);

    db.startTransaction();
    const results = drainQuery(
      db,
      db.startQuery(
        fullScan("tasks", "asc", [
          { filter: { $neq: [{ $field: "status" }, { $literal: "done" }] } },
        ]),
      ),
    );
    db.commit();

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("active");
  });
});

describe.concurrent("QueryEngine — limit operator", () => {
  it("caps the number of results", () => {
    const db = seedDb("tasks", [
      { title: "a" },
      { title: "b" },
      { title: "c" },
      { title: "d" },
      { title: "e" },
    ]);

    db.startTransaction();
    const results = drainQuery(
      db,
      db.startQuery(fullScan("tasks", "asc", [{ limit: 3 }])),
    );
    db.commit();

    expect(results.map((doc) => doc.title)).toEqual(["a", "b", "c"]);
  });

  it("applies the filter before the limit", () => {
    const db = seedDb("tasks", [
      { title: "a", status: "active" },
      { title: "b", status: "done" },
      { title: "c", status: "active" },
      { title: "d", status: "active" },
      { title: "e", status: "active" },
    ]);

    db.startTransaction();
    const results = drainQuery(
      db,
      db.startQuery(
        fullScan("tasks", "asc", [eqFilter("status", "active"), { limit: 2 }]),
      ),
    );
    db.commit();

    expect(results.map((doc) => doc.title)).toEqual(["a", "c"]);
  });
});

describe.concurrent("QueryEngine — vector search", () => {
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
    expect(results[0]?._score).toBeGreaterThanOrEqual(results[1]?._score ?? 0);
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
  });

  it("breaks score ties by _id ascending", () => {
    const db = new Database(schemaWithVectorIndex);
    db.startTransaction();
    db.writeDocument("tasks", {
      _id: "bbb",
      _creationTime: 1,
      title: "second",
      status: "active",
      priority: 1,
      embedding: [1, 0],
    });
    db.writeDocument("tasks", {
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
    db.writeDocument("tasks", {
      _id: "bbb",
      _creationTime: 1,
      title: "second",
      status: "active",
      priority: 1,
      embedding: [0, 1],
    });
    db.writeDocument("tasks", {
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

  it("includes pending writes so read-your-own-writes works", () => {
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
    db.rollbackWrites();

    expect(results).toHaveLength(1);
  });
});

describe.concurrent("QueryEngine — index range scan", () => {
  it("Eq range filters on the indexed field", () => {
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
    const results = drainQuery(
      db,
      db.startQuery({
        source: {
          type: "IndexRange",
          indexName: "tasks.by_status",
          range: [{ type: "Eq", fieldPath: "status", value: "active" }],
          order: "asc",
        },
        operators: [],
      }),
    );
    db.commit();

    expect(results).toHaveLength(2);
    expect(results.every((doc) => doc.status === "active")).toBe(true);
  });

  it("Gt range filters on the indexed field", () => {
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
    const results = drainQuery(
      db,
      db.startQuery({
        source: {
          type: "IndexRange",
          indexName: "tasks.by_status",
          range: [{ type: "Gt", fieldPath: "status", value: "beta" }],
          order: "asc",
        },
        operators: [],
      }),
    );
    db.commit();

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("gamma");
  });
});

describe.concurrent("QueryEngine — search", () => {
  function searchQuery(
    filters: Array<
      | { type: "Search"; fieldPath: string; value: string }
      | { type: "Eq"; fieldPath: string; value: string }
    >,
  ): SerializedQuery {
    return {
      source: { type: "Search", indexName: "tasks.search_body", filters },
      operators: [],
    };
  }

  it("matches documents with prefix matching on the final term", () => {
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
    const results = drainQuery(
      db,
      db.startQuery(
        searchQuery([{ type: "Search", fieldPath: "body", value: "hel" }]),
      ),
    );
    db.commit();

    const titles = results
      .map((doc) => doc.title)
      .filter((title): title is string => typeof title === "string")
      .sort((a, b) => a.localeCompare(b));
    expect(titles).toEqual(["a", "b"]);
  });

  it("only prefix-matches the final query term", () => {
    const db = seedDb(
      "tasks",
      [
        { title: "a", body: "quick brown fox" },
        { title: "b", body: "quick fox jumps" },
      ],
      schemaWithIndex,
    );

    db.startTransaction();
    const results = drainQuery(
      db,
      db.startQuery(
        searchQuery([{ type: "Search", fieldPath: "body", value: "qui fo" }]),
      ),
    );
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
    const results = drainQuery(
      db,
      db.startQuery(
        searchQuery([
          { type: "Search", fieldPath: "body", value: "hello wor" },
        ]),
      ),
    );
    db.commit();

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("a");
  });

  it("orders equal-scoring matches newest first", () => {
    const db = seedDb(
      "tasks",
      [
        { title: "older", body: "quick fox" },
        { title: "newer", body: "quick fox" },
      ],
      schemaWithIndex,
    );

    db.startTransaction();
    const results = drainQuery(
      db,
      db.startQuery(
        searchQuery([
          { type: "Search", fieldPath: "body", value: "quick fox" },
        ]),
      ),
    );
    db.commit();

    expect(results.map((doc) => doc.title)).toEqual(["newer", "older"]);
  });

  it("narrows search results with an Eq filter", () => {
    const db = seedDb(
      "tasks",
      [
        { title: "a", body: "hello world", status: "active" },
        { title: "b", body: "hello there", status: "done" },
      ],
      schemaWithIndex,
    );

    db.startTransaction();
    const results = drainQuery(
      db,
      db.startQuery(
        searchQuery([
          { type: "Search", fieldPath: "body", value: "hello" },
          { type: "Eq", fieldPath: "status", value: "active" },
        ]),
      ),
    );
    db.commit();

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("a");
  });

  it("throws when searching on the wrong field for the index", () => {
    const db = seedDb(
      "tasks",
      [{ title: "a", body: "hello world", status: "active" }],
      schemaWithIndex,
    );

    db.startTransaction();
    expect(() =>
      db.startQuery(
        searchQuery([{ type: "Search", fieldPath: "title", value: "hello" }]),
      ),
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
      db.startQuery(
        searchQuery([
          { type: "Search", fieldPath: "body", value: "hello" },
          { type: "Eq", fieldPath: "title", value: "a" },
        ]),
      ),
    ).toThrow(/does not allow equality filter on "title"/);
    db.rollbackWrites();
  });
});

describe.concurrent("QueryEngine — pagination", () => {
  it("walks pages with cursor-based pagination", async () => {
    const db = seedDb("tasks", [
      { title: "a" },
      { title: "b" },
      { title: "c" },
      { title: "d" },
      { title: "e" },
    ]);
    db.startTransaction();

    const page1 = await db.paginateAsync({
      query: fullScan("tasks", "asc"),
      cursor: null,
      pageSize: 2,
    });
    expect(page1.page.map((doc) => doc.title)).toEqual(["a", "b"]);
    expect(page1.isDone).toBe(false);

    const page2 = await db.paginateAsync({
      query: fullScan("tasks", "asc"),
      cursor: page1.continueCursor,
      pageSize: 2,
    });
    expect(page2.page.map((doc) => doc.title)).toEqual(["c", "d"]);

    const page3 = await db.paginateAsync({
      query: fullScan("tasks", "asc"),
      cursor: page2.continueCursor,
      pageSize: 2,
    });
    expect(page3.page.map((doc) => doc.title)).toEqual(["e"]);
    expect(page3.isDone).toBe(true);

    db.commit();
  });

  it("returns all results in one page when pageSize covers the table", async () => {
    const db = seedDb("tasks", [{ title: "a" }, { title: "b" }]);
    db.startTransaction();

    const result = await db.paginateAsync({
      query: fullScan("tasks", "asc"),
      cursor: null,
      pageSize: 10,
    });
    db.commit();

    expect(result.page).toHaveLength(2);
    expect(result.isDone).toBe(true);
  });
});

describe.concurrent("QueryEngine — count", () => {
  it("returns the document count for a table", () => {
    const db = seedDb("tasks", [
      { title: "a" },
      { title: "b" },
      { title: "c" },
    ]);

    db.startTransaction();
    const count = db.count("tasks");
    db.commit();

    expect(count).toBe(3);
  });

  it("returns 0 for an empty table", () => {
    const db = new Database(null);

    db.startTransaction();
    const count = db.count("tasks");
    db.commit();

    expect(count).toBe(0);
  });
});

describe.concurrent("QueryEngine — ordering", () => {
  it("ascending order is monotonically non-decreasing by _creationTime", () => {
    const db = seedDb("tasks", [
      { title: "first" },
      { title: "second" },
      { title: "third" },
    ]);

    db.startTransaction();
    const results = drainQuery(db, db.startQuery(fullScan("tasks", "asc")));
    db.commit();

    const times = results.map((doc) => doc._creationTime);
    expect(times).toEqual([...times].sort((a, b) => Number(a) - Number(b)));
  });

  it("descending order is monotonically non-increasing by _creationTime", () => {
    const db = seedDb("tasks", [
      { title: "first" },
      { title: "second" },
      { title: "third" },
    ]);

    db.startTransaction();
    const results = drainQuery(db, db.startQuery(fullScan("tasks", "desc")));
    db.commit();

    const times = results.map((doc) => doc._creationTime);
    expect(times).toEqual([...times].sort((a, b) => Number(b) - Number(a)));
  });
});

describe.concurrent("evaluateFieldPath", () => {
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

describe.concurrent("evaluateFilter", () => {
  const doc: GenericDocument = { name: "alice", age: 30, active: true };

  describe("$field", () => {
    it("extracts a field value", () => {
      expect(evaluateFilter(doc, { $field: "name" })).toBe("alice");
    });
  });

  describe("$literal", () => {
    it("returns a literal number", () => {
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
        evaluateFilter(doc, { $eq: [{ $field: "name" }, { $literal: "bob" }] }),
      ).toBe(false);
    });

    it("compares null values without throwing", () => {
      expect(
        evaluateFilter(
          { name: "alice", nickname: null },
          { $eq: [{ $field: "nickname" }, { $literal: null }] },
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

  describe("comparison operators", () => {
    const cases: ReadonlyArray<{
      label: string;
      filter: Parameters<typeof evaluateFilter>[1];
      expected: boolean;
    }> = [
      {
        label: "$gt true when left > right",
        filter: { $gt: [{ $field: "age" }, { $literal: 20 }] },
        expected: true,
      },
      {
        label: "$gt false when left <= right",
        filter: { $gt: [{ $field: "age" }, { $literal: 30 }] },
        expected: false,
      },
      {
        label: "$lt true when left < right",
        filter: { $lt: [{ $field: "age" }, { $literal: 40 }] },
        expected: true,
      },
      {
        label: "$lt false when left >= right",
        filter: { $lt: [{ $field: "age" }, { $literal: 30 }] },
        expected: false,
      },
      {
        label: "$gte true when equal",
        filter: { $gte: [{ $field: "age" }, { $literal: 30 }] },
        expected: true,
      },
      {
        label: "$gte true when greater",
        filter: { $gte: [{ $field: "age" }, { $literal: 20 }] },
        expected: true,
      },
      {
        label: "$lte true when equal",
        filter: { $lte: [{ $field: "age" }, { $literal: 30 }] },
        expected: true,
      },
      {
        label: "$lte false when greater",
        filter: { $lte: [{ $field: "age" }, { $literal: 20 }] },
        expected: false,
      },
    ];

    it.for(cases)("$label", ({ filter, expected }) => {
      expect(evaluateFilter(doc, filter)).toBe(expected);
    });
  });

  describe("$and", () => {
    it("returns true when all conditions hold", () => {
      expect(
        evaluateFilter(doc, {
          $and: [
            { $eq: [{ $field: "name" }, { $literal: "alice" }] },
            { $gt: [{ $field: "age" }, { $literal: 20 }] },
          ],
        }),
      ).toBe(true);
    });

    it("returns false when one condition fails", () => {
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
    it("returns true when at least one condition holds", () => {
      expect(
        evaluateFilter(doc, {
          $or: [
            { $eq: [{ $field: "name" }, { $literal: "bob" }] },
            { $eq: [{ $field: "name" }, { $literal: "alice" }] },
          ],
        }),
      ).toBe(true);
    });

    it("returns false when no condition holds", () => {
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
      expect(
        evaluateFilter(doc, {
          $not: { $eq: [{ $field: "name" }, { $literal: "alice" }] },
        }),
      ).toBe(false);
    });

    it("negates a false condition to true", () => {
      expect(
        evaluateFilter(doc, {
          $not: { $eq: [{ $field: "name" }, { $literal: "bob" }] },
        }),
      ).toBe(true);
    });
  });

  describe("arithmetic operators", () => {
    const cases: ReadonlyArray<{
      label: string;
      filter: Parameters<typeof evaluateFilter>[1];
      expected: number;
    }> = [
      {
        label: "$add",
        filter: { $add: [{ $field: "age" }, { $literal: 10 }] },
        expected: 40,
      },
      {
        label: "$sub",
        filter: { $sub: [{ $field: "age" }, { $literal: 5 }] },
        expected: 25,
      },
      {
        label: "$mul",
        filter: { $mul: [{ $field: "age" }, { $literal: 2 }] },
        expected: 60,
      },
      {
        label: "$div",
        filter: { $div: [{ $field: "age" }, { $literal: 3 }] },
        expected: 10,
      },
      {
        label: "$mod",
        filter: { $mod: [{ $field: "age" }, { $literal: 7 }] },
        expected: 2,
      },
    ];

    it.for(cases)("$label computes the result", ({ filter, expected }) => {
      expect(evaluateFilter(doc, filter)).toBe(expected);
    });
  });
});
