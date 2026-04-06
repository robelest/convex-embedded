import { Database } from "@embedded/runtime/db/database";
import type { ParsedSchema } from "@embedded/runtime/db/schema";
import { bench, describe } from "vite-plus/test";

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
      "embeddings",
      {
        indexes: [],
        vectorIndexes: [
          {
            indexDescriptor: "by_embedding",
            vectorField: "embedding",
            dimensions: 128,
            filterFields: ["status", "bucket"],
          },
        ],
        searchIndexes: [],
        documentType: { type: "any" },
      },
    ],
  ]),
};

function seedDb(docCount: number): Database {
  const db = new Database(schemaWithIndex);
  db.startTransaction();
  for (let i = 0; i < docCount; i += 1) {
    db.insert("tasks", {
      title: `task-${i}`,
      body: i % 2 === 0 ? `quick brown fox ${i}` : `lazy dog ${i}`,
      status: i % 3 === 0 ? "active" : i % 3 === 1 ? "queued" : "done",
      priority: i % 10,
    });
  }
  db.commit();
  return db;
}

function drainQuery(db: Database, queryId: number): unknown[] {
  const results: unknown[] = [];
  for (;;) {
    const next = db.queryNext(queryId);
    if (next.done) {
      return results;
    }
    results.push(next.value);
  }
}

function vectorEq(fieldPath: string, value: string | number) {
  return {
    $eq: [{ $field: fieldPath }, { $literal: value }],
  } as const;
}

function vectorOr(...filters: ReadonlyArray<ReturnType<typeof vectorEq>>) {
  return { $or: filters } as const;
}

function makeEmbedding(index: number, dimensions: number): number[] {
  return Array.from(
    { length: dimensions },
    (_, dimension) => ((index + dimension) % 17) / 17,
  );
}

function seedVectorDb(docCount: number): Database {
  const db = new Database(schemaWithVectorIndex);
  db.startTransaction();
  for (let i = 0; i < docCount; i += 1) {
    db.putDocument("embeddings", {
      _id: `embedding-${i}`,
      _creationTime: i + 1,
      status: i % 2 === 0 ? "active" : "draft",
      bucket: i % 8,
      embedding: makeEmbedding(i, 128),
    });
  }
  db.commit();
  return db;
}

function withPendingWrite<T>(db: Database, run: () => T, setup: () => void): T {
  db.startTransaction();
  setup();
  try {
    return run();
  } finally {
    db.rollbackWrites();
  }
}

describe("query engine", () => {
  const db = seedDb(10_000);
  const vectorDb = seedVectorDb(10_000);
  const queryVector = makeEmbedding(3, 128);

  bench("full table scan + filter(active)", () => {
    db.startTransaction();
    const queryId = db.startQuery({
      source: { type: "FullTableScan", tableName: "tasks", order: "asc" },
      operators: [
        {
          filter: {
            $eq: [{ $field: "status" }, { $literal: "active" }],
          },
        },
      ],
    });
    drainQuery(db, queryId);
    db.rollbackWrites();
  });

  bench("full table scan + filter(active) + limit 20", () => {
    db.startTransaction();
    const queryId = db.startQuery({
      source: { type: "FullTableScan", tableName: "tasks", order: "asc" },
      operators: [
        {
          filter: {
            $eq: [{ $field: "status" }, { $literal: "active" }],
          },
        },
        { limit: 20 },
      ],
    });
    drainQuery(db, queryId);
    db.rollbackWrites();
  });

  bench("secondary index range Eq(active)", () => {
    db.startTransaction();
    const queryId = db.startQuery({
      source: {
        type: "IndexRange",
        indexName: "tasks.by_status",
        range: [{ type: "Eq", fieldPath: "status", value: "active" }],
        order: "asc",
      },
      operators: [],
    });
    drainQuery(db, queryId);
    db.rollbackWrites();
  });

  bench("secondary index range Gt(queued)", () => {
    db.startTransaction();
    const queryId = db.startQuery({
      source: {
        type: "IndexRange",
        indexName: "tasks.by_status",
        range: [{ type: "Gt", fieldPath: "status", value: "queued" }],
        order: "asc",
      },
      operators: [],
    });
    drainQuery(db, queryId);
    db.rollbackWrites();
  });

  bench("text search quick prefix", () => {
    db.startTransaction();
    const queryId = db.startQuery({
      source: {
        type: "Search",
        indexName: "tasks.search_body",
        filters: [{ type: "Search", fieldPath: "body", value: "quick bro" }],
      },
      operators: [],
    });
    drainQuery(db, queryId);
    db.rollbackWrites();
  });

  bench("text search quick prefix + limit 20", () => {
    db.startTransaction();
    const queryId = db.startQuery({
      source: {
        type: "Search",
        indexName: "tasks.search_body",
        filters: [{ type: "Search", fieldPath: "body", value: "quick bro" }],
      },
      operators: [{ limit: 20 }],
    });
    drainQuery(db, queryId);
    db.rollbackWrites();
  });

  bench("text search quick prefix + filter", () => {
    db.startTransaction();
    const queryId = db.startQuery({
      source: {
        type: "Search",
        indexName: "tasks.search_body",
        filters: [
          { type: "Search", fieldPath: "body", value: "quick bro" },
          { type: "Eq", fieldPath: "status", value: "active" },
        ],
      },
      operators: [],
    });
    drainQuery(db, queryId);
    db.rollbackWrites();
  });

  bench("full scan same-table pending write", () => {
    withPendingWrite(
      db,
      () => {
        const queryId = db.startQuery({
          source: { type: "FullTableScan", tableName: "tasks", order: "asc" },
          operators: [
            {
              filter: {
                $eq: [{ $field: "status" }, { $literal: "active" }],
              },
            },
          ],
        });
        drainQuery(db, queryId);
      },
      () => {
        db.insert("tasks", {
          title: "pending-task",
          body: "quick brown fox pending",
          status: "queued",
          priority: 99,
        });
      },
    );
  });

  bench("full scan same-table pending write + limit 20", () => {
    withPendingWrite(
      db,
      () => {
        const queryId = db.startQuery({
          source: { type: "FullTableScan", tableName: "tasks", order: "asc" },
          operators: [
            {
              filter: {
                $eq: [{ $field: "status" }, { $literal: "active" }],
              },
            },
            { limit: 20 },
          ],
        });
        drainQuery(db, queryId);
      },
      () => {
        db.insert("tasks", {
          title: "pending-task",
          body: "quick brown fox pending",
          status: "queued",
          priority: 99,
        });
      },
    );
  });

  bench("full scan unrelated pending write", () => {
    withPendingWrite(
      vectorDb,
      () => {
        const queryId = db.startQuery({
          source: { type: "FullTableScan", tableName: "tasks", order: "asc" },
          operators: [
            {
              filter: {
                $eq: [{ $field: "status" }, { $literal: "active" }],
              },
            },
          ],
        });
        drainQuery(db, queryId);
      },
      () => {
        vectorDb.putDocument("embeddings", {
          _id: "pending-embedding",
          _creationTime: 20_001,
          status: "draft",
          bucket: 1,
          embedding: makeEmbedding(7, 128),
        });
      },
    );
  });

  bench("text search same-table pending write", () => {
    withPendingWrite(
      db,
      () => {
        const queryId = db.startQuery({
          source: {
            type: "Search",
            indexName: "tasks.search_body",
            filters: [{ type: "Search", fieldPath: "body", value: "quick" }],
          },
          operators: [],
        });
        drainQuery(db, queryId);
      },
      () => {
        db.insert("tasks", {
          title: "pending-search",
          body: "quick pending overlay document",
          status: "queued",
          priority: 100,
        });
      },
    );
  });

  bench("text search same-table pending write + limit 20", () => {
    withPendingWrite(
      db,
      () => {
        const queryId = db.startQuery({
          source: {
            type: "Search",
            indexName: "tasks.search_body",
            filters: [{ type: "Search", fieldPath: "body", value: "quick" }],
          },
          operators: [{ limit: 20 }],
        });
        drainQuery(db, queryId);
      },
      () => {
        db.insert("tasks", {
          title: "pending-search",
          body: "quick pending overlay document",
          status: "queued",
          priority: 100,
        });
      },
    );
  });

  bench("text search unrelated pending write", () => {
    withPendingWrite(
      vectorDb,
      () => {
        const queryId = db.startQuery({
          source: {
            type: "Search",
            indexName: "tasks.search_body",
            filters: [{ type: "Search", fieldPath: "body", value: "quick" }],
          },
          operators: [],
        });
        drainQuery(db, queryId);
      },
      () => {
        vectorDb.putDocument("embeddings", {
          _id: "pending-search-unrelated",
          _creationTime: 20_003,
          status: "draft",
          bucket: 3,
          embedding: makeEmbedding(9, 128),
        });
      },
    );
  });

  bench("vector search same-table pending write", () => {
    withPendingWrite(
      vectorDb,
      () => {
        vectorDb.vectorSearch("embeddings.by_embedding", queryVector, null, 10);
      },
      () => {
        vectorDb.putDocument("embeddings", {
          _id: "pending-embedding",
          _creationTime: 20_002,
          status: "draft",
          bucket: 2,
          embedding: makeEmbedding(8, 128),
        });
      },
    );
  });

  bench("vector search unrelated pending write", () => {
    withPendingWrite(
      db,
      () => {
        vectorDb.vectorSearch("embeddings.by_embedding", queryVector, null, 10);
      },
      () => {
        db.insert("tasks", {
          title: "pending-task",
          body: "lazy dog pending",
          status: "done",
          priority: 7,
        });
      },
    );
  });

  bench("vector search top-10", () => {
    vectorDb.vectorSearch("embeddings.by_embedding", queryVector, null, 10);
  });

  bench("vector search filtered top-10", () => {
    vectorDb.vectorSearch(
      "embeddings.by_embedding",
      queryVector,
      vectorOr(vectorEq("status", "active"), vectorEq("bucket", 3)),
      10,
    );
  });

  bench("vector search filtered top-50", () => {
    vectorDb.vectorSearch(
      "embeddings.by_embedding",
      queryVector,
      vectorEq("status", "active"),
      50,
    );
  });
});
