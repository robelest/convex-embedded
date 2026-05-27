import {
  createQueryEngine,
  type QueryEngine,
} from "@embedded/runtime/db/query";
import type { ParsedSchema } from "@embedded/runtime/db/schema";
import type {
  SerializedQuery,
  StoredDocument,
} from "@embedded/runtime/db/types";
import { bench, describe } from "@tests/testkit";

import { makeRows, sizeByLabel } from "./helpers";

const medium = sizeByLabel("medium");

const searchSchema: ParsedSchema = {
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

const docs: StoredDocument[] = makeRows(medium.docs).map((row, index) => ({
  _id: `doc-${index}` as StoredDocument["_id"],
  _creationTime: index + 1,
  ...row,
  embedding: [Math.cos(index), Math.sin(index)],
})) as unknown as StoredDocument[];

function makeEngine(version: () => number | null): QueryEngine {
  return createQueryEngine(
    searchSchema,
    (_tableName, callback) => {
      for (const doc of docs) callback(doc);
    },
    () => docs.length,
    () => null,
    () => null,
    undefined,
    undefined,
    undefined,
    version,
  );
}

const searchQuery: SerializedQuery = {
  source: {
    type: "Search",
    indexName: "tasks.search_body",
    filters: [{ type: "Search", fieldPath: "body", value: "fox" }],
  },
  operators: [],
};

async function runSearch(engine: QueryEngine): Promise<void> {
  const queryId = engine.startQueryAsync(searchQuery);
  for (;;) {
    const next = await engine.queryNextAsync(queryId);
    if (next.done) break;
  }
  engine.queryCleanup(queryId);
}

const warmSearchEngine = makeEngine(() => 0);
let coldVersion = 0;
const coldSearchEngine = makeEngine(() => {
  coldVersion += 1;
  return coldVersion;
});

const warmVectorEngine = makeEngine(() => 0);
let coldVectorVersion = 0;
const coldVectorEngine = makeEngine(() => {
  coldVectorVersion += 1;
  return coldVectorVersion;
});

describe("search/vector index cache (engine fallback, 10k docs)", () => {
  bench("search — cache warm (reuse index)", async () => {
    await runSearch(warmSearchEngine);
  });

  bench("search — rebuild per query (before)", async () => {
    await runSearch(coldSearchEngine);
  });

  bench("vector — cache warm (reuse index)", () => {
    warmVectorEngine.vectorSearch("tasks.by_embedding", [1, 0], null, 10);
  });

  bench("vector — rebuild per query (before)", () => {
    coldVectorEngine.vectorSearch("tasks.by_embedding", [1, 0], null, 10);
  });
});
