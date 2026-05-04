import { openNodeStorage } from "@embedded/node/sqlite/adapter";
import { Database } from "@embedded/runtime/db/database";
import { embeddedTable } from "@embedded/server";
import { register } from "@embedded/server/fields";
import { runMigrations } from "@embedded/server/migration";
import {
  type MigrationRuntimeAdapter,
  type SystemIndexRange,
} from "@embedded/shared/migrations/migrate";
import { afterEach, describe, expect, it } from "@tests/testkit";
import { v } from "convex/values";

import { temporaryDatabasePath, uniqueSuffix } from "../../helpers/live";

const adaptersToClose: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const adapter of adaptersToClose.splice(0)) {
    await adapter.close();
  }
});

async function readRowsByIndex(
  db: Database,
  input: { tableName: string; indexName: string; range: SystemIndexRange[] },
): Promise<Array<Record<string, unknown>>> {
  const qid = db.startQueryAsync({
    source: {
      type: "IndexRange",
      indexName: `${input.tableName}.${input.indexName}`,
      range: input.range.map((entry) => ({
        type: "Eq",
        fieldPath: entry.fieldPath,
        value: entry.value,
      })),
      order: "asc",
    } as never,
    operators: [],
  });

  const rows: Array<Record<string, unknown>> = [];
  try {
    while (true) {
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
  storage: { applySchemaOps?: (t: string, ops: readonly never[]) => Promise<void> },
): MigrationRuntimeAdapter {
  const txWrite = async <T>(work: () => Promise<T>): Promise<T> => {
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
      txWrite(async () => db.insert(table, doc) as unknown as string),
    systemPatch: (id, fields) =>
      txWrite(async () => {
        db.patch(undefined, id as never, fields);
      }),
    systemDelete: (id) =>
      txWrite(async () => {
        db.delete(undefined, id as never);
      }),
    tableList: (table) => db.listDocumentsAsync(table),
    tableGet: async (table, id) => {
      const docs = await db.listDocumentsAsync(table);
      return (
        (docs as Array<Record<string, unknown>>).find(
          (doc) => doc._id === id,
        ) ?? null
      );
    },
    tableInsert: (table, doc) =>
      txWrite(async () => db.insert(table, doc) as unknown as string),
    tablePatch: (_table, id, fields) =>
      txWrite(async () => {
        db.patch(undefined, id as never, fields);
      }),
    tableReplace: (_table, id, fields) =>
      txWrite(async () => {
        db.replace(undefined, id as never, fields);
      }),
    tableDelete: (_table, id) =>
      txWrite(async () => {
        db.delete(undefined, id as never);
      }),
    applySchemaOps: async (table, ops) => {
      if (typeof storage.applySchemaOps === "function") {
        await storage.applySchemaOps(table, ops as readonly never[]);
      }
    },
  };
}

describe("Phase 2 migrations end-to-end with SQLite", () => {
  it("advances stored version and persists across restart", async () => {
    const dbPath = temporaryDatabasePath(uniqueSuffix("p2-version-restart"));

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

    {
      const storage = await openNodeStorage({ filename: dbPath });
      const db = new Database(null);
      db.setStorage(storage);
      await db.hydrate();

      const adapter = createSqliteMigrationAdapter(db, storage);
      const result = await runMigrations({
        table: "tasks_v2",
        schema: (tasks as unknown as { schema: any }).schema,
        adapter,
      });
      expect(result).toBe(true);

      await db.waitForPersistence();
      await storage.close();
    }

    {
      const storage = await openNodeStorage({ filename: dbPath });
      adaptersToClose.push(storage);
      const db = new Database(null);
      db.setStorage(storage);
      await db.hydrate();

      const adapter = createSqliteMigrationAdapter(db, storage);
      const result = await runMigrations({
        table: "tasks_v2",
        schema: (tasks as unknown as { schema: any }).schema,
        adapter,
      });
      expect(result).toBe(false);
      await db.waitForPersistence();
    }
  });

  it("ctx.step survives interruption: re-run skips completed steps", async () => {
    const dbPath = temporaryDatabasePath(uniqueSuffix("p2-step-resume"));

    let runCount = 0;
    let firstStepRanThisInvocation = false;
    const tasks = embeddedTable(
      "step_resume",
      { title: register(v.string()) },
      {
        migrations: {
          2: async ({ step }) => {
            firstStepRanThisInvocation = false;
            await step("first", async () => {
              runCount += 1;
              firstStepRanThisInvocation = true;
            });
            if (firstStepRanThisInvocation) {
              throw new Error("interrupted after first step");
            }
            await step("second", async () => {
              runCount += 1;
            });
          },
        },
      },
    );

    {
      const storage = await openNodeStorage({ filename: dbPath });
      const db = new Database(null);
      db.setStorage(storage);
      await db.hydrate();

      const adapter = createSqliteMigrationAdapter(db, storage);
      await expect(
        runMigrations({
          table: "step_resume",
          schema: (tasks as unknown as { schema: any }).schema,
          adapter,
        }),
      ).rejects.toThrow("interrupted");
      const stepRows = await readRowsByIndex(db, {
        tableName: "_resolve_schema_steps",
        indexName: "by_table_version_step",
        range: [
          { fieldPath: "table", value: "step_resume" },
          { fieldPath: "version", value: 2 },
          { fieldPath: "stepName", value: "first" },
        ],
      });
      expect(stepRows).toHaveLength(1);
      await db.waitForPersistence();
      await storage.close();
    }

    {
      const storage = await openNodeStorage({ filename: dbPath });
      adaptersToClose.push(storage);
      const db = new Database(null);
      db.setStorage(storage);
      await db.hydrate();

      const adapter = createSqliteMigrationAdapter(db, storage);
      await runMigrations({
        table: "step_resume",
        schema: (tasks as unknown as { schema: any }).schema,
        adapter,
      });

      expect(runCount).toBe(2);

      const versionRows = await readRowsByIndex(db, {
        tableName: "_resolve_schema_versions",
        indexName: "by_table",
        range: [{ fieldPath: "table", value: "step_resume" }],
      });
      expect(versionRows[0]?.version).toBe(2);

      const stepRows = await readRowsByIndex(db, {
        tableName: "_resolve_schema_steps",
        indexName: "by_table_version_step",
        range: [
          { fieldPath: "table", value: "step_resume" },
          { fieldPath: "version", value: 2 },
        ],
      });
      expect(stepRows).toHaveLength(0);
    }
  });
});
