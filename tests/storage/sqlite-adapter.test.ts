import { createSqlitePersistenceAdapter } from "@embedded/persistence/sqlite/factory";
import { describe, expect, it, vi } from "@tests/testkit";

const ADAPTER_META_TABLE = "_convex_sqlite_adapter_meta";
const TABLE_ROUTING_TABLE = "_convex_sqlite_table_routing";

function createMockDriver(options?: {
  existingTables?: string[];
  routes?: Record<string, string>;
  customQuery?: (sql: string, params?: unknown[]) => Promise<unknown[]>;
}) {
  const existingTables = new Set(options?.existingTables ?? []);
  const routes = new Map(Object.entries(options?.routes ?? {}));

  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (
      sql === "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    ) {
      const tableName = String(params?.[0]);
      return existingTables.has(tableName) ? [{ name: tableName }] : [];
    }
    if (
      sql === `SELECT schema_version FROM ${ADAPTER_META_TABLE} WHERE id = 1`
    ) {
      return [];
    }
    if (sql === "PRAGMA table_info(documents)") {
      return [
        { name: "id" },
        { name: "table_name" },
        { name: "creation_time" },
        { name: "identity_key" },
        { name: "data" },
      ];
    }
    if (
      sql ===
      `SELECT physical_table_name FROM ${TABLE_ROUTING_TABLE} WHERE table_name = ?`
    ) {
      const route = routes.get(String(params?.[0]));
      return route ? [{ physical_table_name: route }] : [];
    }
    if (
      sql ===
      `SELECT table_name, physical_table_name FROM ${TABLE_ROUTING_TABLE}`
    ) {
      return Array.from(routes.entries()).map(
        ([table_name, physical_table_name]) => ({
          table_name,
          physical_table_name,
        }),
      );
    }
    if (
      sql ===
      "SELECT DISTINCT table_name FROM documents WHERE table_name IS NOT NULL AND table_name != ''"
    ) {
      return [];
    }
    return (await options?.customQuery?.(sql, params)) ?? [];
  });

  const execute = vi.fn(async () => undefined);
  const executeBatch = vi.fn(
    async (statements: Array<{ sql: string; params?: unknown[] }>) => {
      for (const statement of statements) {
        if (
          statement.sql.includes(
            `INSERT OR REPLACE INTO ${TABLE_ROUTING_TABLE}`,
          )
        ) {
          routes.set(
            String(statement.params?.[0]),
            String(statement.params?.[1]),
          );
        }
      }
    },
  );

  return {
    driver: { query, execute, executeBatch },
    query,
    executeBatch,
  };
}

describe("createSqlitePersistenceAdapter", () => {
  it("stores projected creation_time and identity_key in a routed physical table", async () => {
    const { driver, executeBatch } = createMockDriver();
    const adapter = await createSqlitePersistenceAdapter({ driver });

    await adapter.commit({
      puts: [
        {
          tableName: "tasks",
          doc: {
            _id: "task-1" as any,
            _creationTime: 42,
            __identityKey: "user-1",
            title: "hello",
          },
        },
      ],
      deletes: [],
      meta: { timestamp: 1, lastCreationTime: 42 },
    });

    const migrationStatements = executeBatch.mock.calls[0]?.[0] as Array<{
      sql: string;
      params?: unknown[];
    }>;
    expect(migrationStatements[0]?.sql).toContain(
      'CREATE TABLE IF NOT EXISTS "documents__tasks"',
    );
    expect(migrationStatements[3]?.sql).toContain(TABLE_ROUTING_TABLE);
    expect(migrationStatements[4]?.sql).toContain(
      'INSERT OR REPLACE INTO "documents__tasks"',
    );

    const writeStatements = executeBatch.mock.calls[1]?.[0] as Array<{
      sql: string;
      params?: unknown[];
    }>;
    expect(writeStatements[0]?.sql).toContain(
      'INSERT OR REPLACE INTO "documents__tasks" (id, creation_time, identity_key, data)',
    );
    expect(writeStatements[0]?.params).toEqual([
      "task-1",
      42,
      "user-1",
      JSON.stringify({
        _id: "task-1",
        _creationTime: 42,
        __identityKey: "user-1",
        title: "hello",
      }),
    ]);
  });

  it("routes reads through the per-table physical table when present", async () => {
    const taskDoc = {
      _id: "task-1",
      _creationTime: 42,
      title: "hello",
    };
    const { driver, query } = createMockDriver({
      existingTables: [ADAPTER_META_TABLE, "documents", "meta", "blobs"],
      routes: { tasks: "documents__tasks" },
      customQuery: async (sql: string) => {
        if (
          sql ===
          'SELECT data FROM "documents__tasks" ORDER BY creation_time ASC, id ASC'
        ) {
          return [{ data: JSON.stringify(taskDoc) }];
        }
        if (sql === 'SELECT data FROM "documents__tasks" WHERE id = ?') {
          return [{ data: JSON.stringify(taskDoc) }];
        }
        if (sql === 'SELECT COUNT(*) AS count FROM "documents__tasks"') {
          return [{ count: 1 }];
        }
        return [];
      },
    });
    const adapter = await createSqlitePersistenceAdapter({ driver });

    await expect(adapter.listDocuments("tasks")).resolves.toEqual([taskDoc]);
    await expect(adapter.getDocument("tasks", "task-1")).resolves.toEqual(
      taskDoc,
    );
    await expect(adapter.countDocuments("tasks")).resolves.toBe(1);

    expect(query).not.toHaveBeenCalledWith(
      "SELECT data FROM documents WHERE table_name = ? ORDER BY creation_time ASC, id ASC",
      ["tasks"],
    );
  });

  it("uses table-qualified deletes for legacy shared rows", async () => {
    const { driver, executeBatch } = createMockDriver({
      existingTables: [ADAPTER_META_TABLE, "documents", "meta", "blobs"],
    });
    const adapter = await createSqlitePersistenceAdapter({ driver });

    await adapter.commit({
      puts: [],
      deletes: [{ id: "task-1", tableName: "tasks" }],
      meta: { timestamp: 2, lastCreationTime: 42 },
    });

    const statements = executeBatch.mock.calls.at(-1)?.[0] as Array<{
      sql: string;
      params?: unknown[];
    }>;
    const allStatements = executeBatch.mock.calls.flatMap(
      (call) =>
        call[0] as Array<{
          sql: string;
          params?: unknown[];
        }>,
    );
    expect(
      allStatements.some((statement) =>
        statement.sql.includes('CREATE TABLE IF NOT EXISTS "documents__tasks"'),
      ),
    ).toBe(true);
    expect(statements).toContainEqual({
      sql: 'DELETE FROM "documents__tasks" WHERE id = ?',
      params: ["task-1"],
    });
  });

  it("preserves vector or filter semantics in SQL candidate reads", async () => {
    const taskDoc = {
      _id: "task-1",
      _creationTime: 42,
      status: "active",
      priority: 2,
      embedding: [1, 0],
    };
    let lastSql = "";
    let lastParams: unknown[] | undefined;
    const { driver } = createMockDriver({
      existingTables: [ADAPTER_META_TABLE, "documents", "meta", "blobs"],
      routes: { tasks: "documents__tasks" },
      customQuery: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith('SELECT data FROM "documents__tasks" WHERE')) {
          lastSql = sql;
          lastParams = params;
          return [{ data: JSON.stringify(taskDoc) }];
        }
        return [];
      },
    });
    const adapter = await createSqlitePersistenceAdapter({ driver });

    const results = await adapter.readVectorCandidates({
      tableName: "tasks",
      indexName: "by_embedding",
      definition: {
        indexDescriptor: "by_embedding",
        vectorField: "embedding",
        dimensions: 2,
        filterFields: ["status", "priority"],
      },
      filter: {
        $or: [
          { $eq: [{ $field: "status" }, { $literal: "active" }] },
          { $eq: [{ $field: "priority" }, { $literal: 3 }] },
        ],
      },
      activeIdentityKey: null,
    });

    expect(results).toEqual([taskDoc]);
    expect(lastSql).toContain(" OR ");
    expect(lastSql).not.toContain(" AND json_extract(data, '$.priority') = ?");
    expect(lastParams).toEqual(["active", 3]);
  });

  it("writes adapter-owned search side-table rows on applyCommit", async () => {
    const { driver, executeBatch } = createMockDriver();
    const adapter = await createSqlitePersistenceAdapter({ driver });

    await adapter.applyCommit(
      {
        puts: [
          {
            tableName: "tasks",
            doc: {
              _id: "task-1" as any,
              _creationTime: 42,
              __identityKey: "user-1",
              title: "hello world",
              status: "active",
            },
          },
        ],
        deletes: [],
        meta: { timestamp: 1, lastCreationTime: 42 },
      },
      {
        materializedTables: [],
        tableSearchIndexes: {
          tasks: [
            {
              indexDescriptor: "by_title",
              searchField: "title",
              filterFields: ["status"],
            },
          ],
        },
      },
    );

    const allWriteStatements = executeBatch.mock.calls.flatMap(
      (call) =>
        call[0] as Array<{
          sql: string;
          params?: unknown[];
        }>,
    );
    expect(
      allWriteStatements.some((statement) =>
        statement.sql.includes(
          'INSERT OR REPLACE INTO "internal__search_entries"',
        ),
      ),
    ).toBe(true);
    expect(
      allWriteStatements.some((statement) =>
        statement.sql.includes(
          'INSERT OR REPLACE INTO "internal__search_filter_buckets"',
        ),
      ),
    ).toBe(true);
  });

  it("writes adapter-owned vector side-table rows on applyCommit", async () => {
    const { driver, executeBatch } = createMockDriver();
    const adapter = await createSqlitePersistenceAdapter({ driver });

    await adapter.applyCommit(
      {
        puts: [
          {
            tableName: "tasks",
            doc: {
              _id: "task-1" as any,
              _creationTime: 42,
              status: "active",
              priority: 2,
              embedding: [1, 0],
            },
          },
        ],
        deletes: [],
        meta: { timestamp: 1, lastCreationTime: 42 },
      },
      {
        materializedTables: [],
        tableVectorIndexes: {
          tasks: [
            {
              indexDescriptor: "by_embedding",
              vectorField: "embedding",
              dimensions: 2,
              filterFields: ["status", "priority"],
            },
          ],
        },
      },
    );

    const allWriteStatements = executeBatch.mock.calls.flatMap(
      (call) =>
        call[0] as Array<{
          sql: string;
          params?: unknown[];
        }>,
    );
    expect(
      allWriteStatements.some((statement) =>
        statement.sql.includes(
          'INSERT OR REPLACE INTO "internal__vector_entries"',
        ),
      ),
    ).toBe(true);
    expect(
      allWriteStatements.some((statement) =>
        statement.sql.includes(
          'INSERT OR REPLACE INTO "internal__vector_filter_buckets"',
        ),
      ),
    ).toBe(true);
  });

  it("migrates legacy shared table rows into physical tables before routed reads", async () => {
    const { driver, executeBatch } = createMockDriver({
      existingTables: [
        ADAPTER_META_TABLE,
        TABLE_ROUTING_TABLE,
        "documents",
        "meta",
        "blobs",
      ],
      customQuery: async (sql: string) => {
        if (
          sql ===
          "SELECT DISTINCT table_name FROM documents WHERE table_name IS NOT NULL AND table_name != ''"
        ) {
          return [{ table_name: "tasks" }];
        }
        if (
          sql ===
          'SELECT data FROM "documents__tasks" ORDER BY creation_time ASC, id ASC'
        ) {
          return [];
        }
        return [];
      },
    });

    const adapter = await createSqlitePersistenceAdapter({ driver });
    await adapter.listDocuments("tasks");

    expect(executeBatch.mock.calls.length).toBeGreaterThan(0);
    const migrationStatements = executeBatch.mock.calls.at(-1)?.[0] as Array<{
      sql: string;
      params?: unknown[];
    }>;
    expect(
      migrationStatements.some((statement) =>
        statement.sql.includes('CREATE TABLE IF NOT EXISTS "documents__tasks"'),
      ),
    ).toBe(true);
    expect(
      migrationStatements.some((statement) =>
        statement.sql.includes(TABLE_ROUTING_TABLE),
      ),
    ).toBe(true);
    expect(
      migrationStatements.some((statement) =>
        statement.sql.includes('INSERT OR REPLACE INTO "documents__tasks"'),
      ),
    ).toBe(true);
    expect(migrationStatements).toContainEqual({
      sql: "DELETE FROM documents WHERE table_name = ?",
      params: ["tasks"],
    });
  });
});
