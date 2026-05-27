import { openNodeStorage } from "@embedded/node/sqlite/adapter";
import { createDatabase, type Database } from "@embedded/runtime/db/database";
import type {
  DocumentId,
  SerializedQuery,
  SerializedRangeExpression,
} from "@embedded/runtime/db/types";
import { embeddedTable } from "@embedded/server";
import { register } from "@embedded/server/fields";
import { runMigrations } from "@embedded/server/migration";
import type {
  MigrationRuntimeAdapter,
  SystemIndexRange,
} from "@embedded/shared/migrations/migrate";
import type { SqliteAdapter } from "@embedded/storage/sqlite/adapter";
import { temporaryDatabasePath, uniqueSuffix } from "@tests/helpers/storage";
import { describe, expect, it, type TestFixtures } from "@tests/testkit";
import { v } from "convex/values";

async function readRowsByIndex(
  db: Database,
  input: { tableName: string; indexName: string; range: SystemIndexRange[] },
): Promise<Array<Record<string, unknown>>> {
  const range: SerializedRangeExpression[] = input.range.map((entry) => ({
    type: "Eq",
    fieldPath: entry.fieldPath,
    value: entry.value as SerializedRangeExpression["value"],
  }));
  const query: SerializedQuery = {
    source: {
      type: "IndexRange",
      indexName: `${input.tableName}.${input.indexName}`,
      range,
      order: "asc",
    },
    operators: [],
  };
  const qid = db.startQueryAsync(query);

  const rows: Array<Record<string, unknown>> = [];
  try {
    for (;;) {
      const next = await db.queryNextAsync(qid);
      if (next.done) return rows;
      rows.push(next.value as Record<string, unknown>);
    }
  } finally {
    db.queryCleanup(qid);
  }
}

function createSqliteMigrationAdapter(
  db: Database,
  storage: SqliteAdapter,
): MigrationRuntimeAdapter {
  const writeInTransaction = async <T>(work: () => Promise<T>): Promise<T> => {
    db.startTransaction();
    try {
      const result = await work();
      await db.commitAsync();
      return result;
    } catch (error) {
      db.rollbackWrites();
      throw error;
    }
  };

  return {
    systemReadByIndex: (input) =>
      readRowsByIndex(db, {
        tableName: input.table,
        indexName: input.indexName,
        range: input.range,
      }),
    systemInsert: (table, doc) =>
      writeInTransaction(async () => db.insert(table, doc)),
    systemPatch: (id, fields) =>
      writeInTransaction(async () => {
        db.patch(undefined, id as DocumentId, fields);
      }),
    systemDelete: (id) =>
      writeInTransaction(async () => {
        db.delete(undefined, id as DocumentId);
      }),
    tableList: (table) => db.listDocumentsAsync(table),
    tableGet: async (table, id) => {
      const docs = await db.listDocumentsAsync(table);
      return docs.find((doc) => doc._id === id) ?? null;
    },
    tableInsert: (table, doc) =>
      writeInTransaction(async () => db.insert(table, doc)),
    tablePatch: (_table, id, fields) =>
      writeInTransaction(async () => {
        db.patch(undefined, id as DocumentId, fields);
      }),
    tableReplace: (_table, id, fields) =>
      writeInTransaction(async () => {
        db.replace(undefined, id as DocumentId, fields);
      }),
    tableDelete: (_table, id) =>
      writeInTransaction(async () => {
        db.delete(undefined, id as DocumentId);
      }),
    applySchemaOps: (table, ops) => storage.applySchemaOps(table, ops),
  };
}

async function openTrackedDatabase(
  track: TestFixtures["track"],
  dbPath: string,
): Promise<{ db: Database; storage: SqliteAdapter }> {
  const storage = track(await openNodeStorage({ filename: dbPath }));
  const db = createDatabase(null);
  db.setStorage(storage);
  await db.hydrate();
  return { db, storage };
}

const tasks = embeddedTable(
  "tasks_v2",
  {
    title: register(v.string()),
  },
  {
    migrations: {
      2: async ({ db }) => {
        await db.patchMissing({ priority: "medium" });
      },
    },
  },
);

describe("Phase 2 migrations end-to-end with SQLite", () => {
  it("advances the stored version on first run", async ({ track }) => {
    const dbPath = temporaryDatabasePath(uniqueSuffix("p2-version-advance"));
    const { db, storage } = await openTrackedDatabase(track, dbPath);

    const result = await runMigrations({
      table: "tasks_v2",
      schema: tasks.schema,
      adapter: createSqliteMigrationAdapter(db, storage),
    });

    expect(result).toBe(true);
    await db.waitForPersistence();
  });

  it("skips migration after the version persists across a restart", async ({
    track,
  }) => {
    const dbPath = temporaryDatabasePath(uniqueSuffix("p2-version-restart"));

    const first = await openTrackedDatabase(track, dbPath);
    await runMigrations({
      table: "tasks_v2",
      schema: tasks.schema,
      adapter: createSqliteMigrationAdapter(first.db, first.storage),
    });
    await first.db.waitForPersistence();
    await first.storage.close();

    const second = await openTrackedDatabase(track, dbPath);
    const result = await runMigrations({
      table: "tasks_v2",
      schema: tasks.schema,
      adapter: createSqliteMigrationAdapter(second.db, second.storage),
    });

    expect(result).toBe(false);
    await second.db.waitForPersistence();
  });
});
