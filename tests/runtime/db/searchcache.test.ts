import { QueryEngine } from "@embedded/runtime/db/query";
import type { ParsedSchema } from "@embedded/runtime/db/schema";
import type {
  SerializedQuery,
  StoredDocument,
  VectorSearchExpression,
} from "@embedded/runtime/db/types";
import { describe, expect, it } from "@tests/testkit";

const searchSchema: ParsedSchema = {
  schemaValidation: false,
  tables: new Map([
    [
      "tasks",
      {
        indexes: [],
        vectorIndexes: [],
        searchIndexes: [
          {
            indexDescriptor: "search_body",
            searchField: "body",
            filterFields: [],
          },
        ],
        documentType: { type: "any" },
      },
    ],
  ]),
};

const vectorSchema: ParsedSchema = {
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
            filterFields: [],
          },
        ],
        searchIndexes: [],
        documentType: { type: "any" },
      },
    ],
  ]),
};

interface Store {
  docs: StoredDocument[];
  iterateCalls: number;
  version: number;
}

function makeStore(docs: StoredDocument[]): Store {
  return { docs, iterateCalls: 0, version: 0 };
}

function makeEngine(schema: ParsedSchema, store: Store): QueryEngine {
  return new QueryEngine(
    schema,
    (_tableName, callback) => {
      store.iterateCalls += 1;
      for (const doc of store.docs) {
        callback(doc);
      }
    },
    () => store.docs.length,
    () => null,
    () => null,
    undefined,
    undefined,
    undefined,
    () => store.version,
  );
}

function searchQuery(value: string): SerializedQuery {
  return {
    source: {
      type: "Search",
      indexName: "tasks.search_body",
      filters: [{ type: "Search", fieldPath: "body", value }],
    },
    operators: [],
  };
}

function doc(id: string, fields: Record<string, unknown>): StoredDocument {
  return {
    _id: id as StoredDocument["_id"],
    _creationTime: Number(id.replace(/\D/g, "")) || 1,
    ...fields,
  } as StoredDocument;
}

async function runSearch(
  engine: QueryEngine,
  value: string,
): Promise<string[]> {
  const queryId = engine.startQueryAsync(searchQuery(value));
  const ids: string[] = [];
  for (;;) {
    const next = await engine.queryNextAsync(queryId);
    if (next.done) break;
    if (next.value !== null) ids.push(next.value._id as string);
  }
  engine.queryCleanup(queryId);
  return ids;
}

describe("QueryEngine search-index cache", () => {
  it("reuses the built index across identical searches with no writes", async () => {
    const store = makeStore([
      doc("1", { title: "a", body: "hello world" }),
      doc("2", { title: "b", body: "goodbye world" }),
    ]);
    const engine = makeEngine(searchSchema, store);

    const first = await runSearch(engine, "hello");
    expect(first).toEqual(["1"]);
    const buildsAfterFirst = store.iterateCalls;
    expect(buildsAfterFirst).toBe(1);

    await runSearch(engine, "hello");
    await runSearch(engine, "world");
    expect(store.iterateCalls).toBe(buildsAfterFirst);
  });

  it("rebuilds and reflects new data after a write bumps the version", async () => {
    const store = makeStore([doc("1", { title: "a", body: "hello world" })]);
    const engine = makeEngine(searchSchema, store);

    expect(await runSearch(engine, "fresh")).toEqual([]);
    expect(store.iterateCalls).toBe(1);

    store.docs = [...store.docs, doc("2", { title: "b", body: "fresh news" })];
    store.version += 1;

    expect(await runSearch(engine, "fresh")).toEqual(["2"]);
    expect(store.iterateCalls).toBe(2);
  });

  it("does not cache when no version is tracked", async () => {
    const store = makeStore([doc("1", { title: "a", body: "hello world" })]);
    const engine = new QueryEngine(
      searchSchema,
      (_tableName, callback) => {
        store.iterateCalls += 1;
        for (const d of store.docs) callback(d);
      },
      () => store.docs.length,
    );

    await runSearch(engine, "hello");
    await runSearch(engine, "hello");
    expect(store.iterateCalls).toBe(2);
  });
});

function vectorEq(fieldPath: string, value: unknown): VectorSearchExpression {
  return { $eq: [{ $field: fieldPath }, { $literal: value as never }] };
}

describe("QueryEngine vector-index cache", () => {
  it("reuses the built vector index across identical searches", () => {
    const store = makeStore([
      doc("1", { title: "a", embedding: [1, 0] }),
      doc("2", { title: "b", embedding: [0, 1] }),
    ]);
    const engine = makeEngine(vectorSchema, store);

    const first = engine.vectorSearch("tasks.by_embedding", [1, 0], null, 5);
    expect(first[0]?._id).toBe("1");
    expect(store.iterateCalls).toBe(1);

    engine.vectorSearch("tasks.by_embedding", [1, 0], null, 5);
    engine.vectorSearch("tasks.by_embedding", [0, 1], null, 5);
    expect(store.iterateCalls).toBe(1);
  });

  it("rebuilds and reflects new vectors after a version bump", () => {
    const store = makeStore([doc("1", { title: "a", embedding: [1, 0] })]);
    const engine = makeEngine(vectorSchema, store);

    expect(engine.vectorSearch("tasks.by_embedding", [0, 1], null, 5)).toEqual([
      { _id: "1", _score: 0 },
    ]);
    expect(store.iterateCalls).toBe(1);

    store.docs = [...store.docs, doc("2", { title: "b", embedding: [0, 1] })];
    store.version += 1;

    const after = engine.vectorSearch("tasks.by_embedding", [0, 1], null, 5);
    expect(after[0]?._id).toBe("2");
    expect(store.iterateCalls).toBe(2);
  });

  it("applies filters against the cached index", () => {
    const store = makeStore([
      doc("1", { title: "a", embedding: [1, 0], kind: "x" }),
      doc("2", { title: "b", embedding: [1, 0], kind: "y" }),
    ]);
    const engine = makeEngine(
      {
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
                  filterFields: ["kind"],
                },
              ],
              searchIndexes: [],
              documentType: { type: "any" },
            },
          ],
        ]),
      },
      store,
    );

    const results = engine.vectorSearch(
      "tasks.by_embedding",
      [1, 0],
      vectorEq("kind", "y"),
      5,
    );
    expect(results.map((r) => r._id)).toEqual(["2"]);
    engine.vectorSearch("tasks.by_embedding", [1, 0], vectorEq("kind", "x"), 5);
    expect(store.iterateCalls).toBe(1);
  });
});
