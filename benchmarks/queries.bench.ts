import { afterAll, bench, describe } from "@tests/testkit";

import {
  closeTrackedResources,
  drainQueryAsync,
  fullScanQuery,
  indexRangeQuery,
  seededSqliteDb,
  sizeByLabel,
} from "./helpers";

const medium = sizeByLabel("medium");
const seeded = await seededSqliteDb(medium, { withIndex: true });
const db = seeded.db;

afterAll(closeTrackedResources);

const byStatusActive = indexRangeQuery("tasks.by_status", [
  { type: "Eq", fieldPath: "status", value: "active" },
]);

const byAssignee = indexRangeQuery("tasks.by_assignee", [
  { type: "Eq", fieldPath: "assignee", value: "user-7" },
]);

const byPriorityRange = indexRangeQuery("tasks.by_priority", [
  { type: "Gte", fieldPath: "priority", value: 8 },
]);

const fullScanActive = fullScanQuery("tasks");

describe("query engine (real indexed SQLite, 10k docs)", () => {
  bench("indexed range Eq(status=active)", async () => {
    await drainQueryAsync(db, byStatusActive);
  });

  bench("indexed range Eq(assignee) point-ish", async () => {
    await drainQueryAsync(db, byAssignee);
  });

  bench("indexed range Gte(priority>=8)", async () => {
    await drainQueryAsync(db, byPriorityRange);
  });

  bench("indexed range + take 20 (paginate slice)", async () => {
    const qid = db.startQueryAsync({
      source: byStatusActive.source,
      operators: [{ limit: 20 }],
    });
    try {
      for (let count = 0; count < 20; count += 1) {
        const next = await db.queryNextAsync(qid);
        if (next.done) break;
      }
    } finally {
      db.queryCleanup(qid);
    }
  });

  bench("full table scan + filter(active) (contrast)", async () => {
    await drainQueryAsync(db, fullScanActive);
  });
});
