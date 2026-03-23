import { Database } from "@embedded/core/database";
import type { ParsedSchema } from "@embedded/core/schema";
import { bench, describe } from "vite-plus/test";

const schemaWithIndex: ParsedSchema = {
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

function seedDb(docCount: number): Database {
  const db = new Database(schemaWithIndex);
  db.startTransaction();
  for (let i = 0; i < docCount; i += 1) {
    db.insert("tasks", {
      title: `task-${i}`,
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

describe("query engine", () => {
  const db = seedDb(10_000);

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
});
