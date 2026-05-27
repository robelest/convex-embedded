import { openNodeStorage } from "@embedded/node/sqlite/adapter";
import { createDatabase } from "@embedded/runtime/db/database";
import { temporaryDatabasePath, uniqueSuffix } from "@tests/helpers/storage";
import { describe, expect, it } from "@tests/testkit";

const ROW_COUNT = 130_000;
const SEED_BATCH = 5_000;

describe("SQLite adapter materialization at large table sizes", () => {
  it("returns every document from a table larger than the spread-arg limit", async ({
    track,
  }) => {
    const dbPath = temporaryDatabasePath(uniqueSuffix("large-table"));
    const storage = track(await openNodeStorage({ filename: dbPath }));
    const db = createDatabase(null);
    db.setStorage(storage);
    await db.hydrate();

    for (let start = 0; start < ROW_COUNT; start += SEED_BATCH) {
      const end = Math.min(start + SEED_BATCH, ROW_COUNT);
      db.startTransaction();
      for (let index = start; index < end; index += 1) {
        db.insert("tasks", { title: `task-${index}` });
      }
      await db.commitAsync();
    }
    await db.waitForPersistence();

    const all = await storage.getDocuments();

    expect(all).toHaveLength(ROW_COUNT);
  }, 120_000);
});
