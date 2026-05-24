import type { TableSchema } from "@embedded/runtime/db/schema";
import type { DocumentId } from "@embedded/runtime/db/types";
import type {
  SqliteDriver,
  SqliteStatement,
} from "@embedded/storage/sqlite/driver";
import {
  buildUserTableSpec,
  createSqliteStorage,
} from "@embedded/storage/sqlite/factory";
import { describe, expect, it, vi, type Mock } from "@tests/testkit";

const ADAPTER_META_TABLE = "_convex_sqlite_adapter_meta";
const TABLE_ROUTING_TABLE = "_convex_sqlite_table_routing";

type QueryRow = Record<string, unknown>;
type QueryMock = Mock<
  (sql: string, params?: readonly unknown[]) => Promise<QueryRow[]>
>;
type ExecuteBatchMock = Mock<
  (statements: readonly SqliteStatement[]) => Promise<void>
>;

interface MockDriver {
  driver: SqliteDriver;
  query: QueryMock;
  executeBatch: ExecuteBatchMock;
}

function createMockDriver(options?: {
  existingTables?: string[];
  routes?: Record<string, string>;
  customQuery?: (
    sql: string,
    params?: readonly unknown[],
  ) => Promise<QueryRow[]>;
}): MockDriver {
  const existingTables = new Set(options?.existingTables ?? []);
  const routes = new Map(Object.entries(options?.routes ?? {}));

  const query: QueryMock = vi.fn(
    async (sql: string, params?: readonly unknown[]): Promise<QueryRow[]> => {
      if (
        sql ===
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
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
    },
  );

  const execute = vi.fn(async (): Promise<void> => undefined);
  const executeBatch: ExecuteBatchMock = vi.fn(
    async (statements: readonly SqliteStatement[]): Promise<void> => {
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

  const driver: SqliteDriver = {
    query: query as unknown as SqliteDriver["query"],
    execute,
    executeBatch,
  };

  return { driver, query, executeBatch };
}

function statementsAt(
  executeBatch: ExecuteBatchMock,
  callIndex: number,
): readonly SqliteStatement[] {
  return executeBatch.mock.calls[callIndex]?.[0] ?? [];
}

function allStatements(
  executeBatch: ExecuteBatchMock,
): readonly SqliteStatement[] {
  return executeBatch.mock.calls.flatMap((call) => call[0]);
}

function tasksTableSchema(): TableSchema {
  return {
    indexes: [{ indexDescriptor: "by_priority", fields: ["priority"] }],
    vectorIndexes: [],
    searchIndexes: [],
    documentType: {
      type: "object",
      value: {
        title: { fieldType: { type: "string" }, optional: false },
        priority: { fieldType: { type: "number" }, optional: false },
        tags: {
          fieldType: { type: "array", value: { type: "string" } },
          optional: false,
        },
        meta: {
          fieldType: {
            type: "union",
            value: [{ type: "string" }, { type: "null" }],
          },
          optional: true,
        },
      },
    },
  };
}

describe("createSqliteStorage", () => {
  it("stores projected creation_time and identity_key in a routed physical table", async () => {
    const { driver, executeBatch } = createMockDriver();
    const adapter = await createSqliteStorage({ driver });

    await adapter.commit({
      puts: [
        {
          tableName: "tasks",
          doc: {
            _id: "task-1" as DocumentId,
            _creationTime: 42,
            __identityKey: "user-1",
            title: "hello",
          },
        },
      ],
      deletes: [],
      meta: { timestamp: 1, lastCreationTime: 42 },
    });

    const migrationStatements = statementsAt(executeBatch, 1);
    expect(migrationStatements[0]?.sql).toContain(
      'CREATE TABLE IF NOT EXISTS "documents__tasks"',
    );
    expect(migrationStatements[3]?.sql).toContain(TABLE_ROUTING_TABLE);

    const writeStatements = statementsAt(executeBatch, 2);
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
    const adapter = await createSqliteStorage({ driver });

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

  it("scopes user table SQL reads to the active identity", async () => {
    const taskDoc = {
      _id: "task-1",
      _creationTime: 42,
      __identityKey: "user-1",
      title: "hello",
    };
    const seen: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const { driver } = createMockDriver({
      existingTables: [ADAPTER_META_TABLE, "documents", "meta", "blobs"],
      routes: { tasks: "documents__tasks" },
      customQuery: async (sql: string, params?: readonly unknown[]) => {
        seen.push({ sql, params });
        if (sql.startsWith('SELECT data FROM "documents__tasks"')) {
          return [{ data: JSON.stringify(taskDoc) }];
        }
        if (
          sql.startsWith('SELECT COUNT(*) AS count FROM "documents__tasks"')
        ) {
          return [{ count: 1 }];
        }
        return [];
      },
    });
    const adapter = await createSqliteStorage({ driver });
    const readOptions = { activeIdentityKey: "user-1" };

    await expect(adapter.listDocuments("tasks", readOptions)).resolves.toEqual([
      taskDoc,
    ]);
    await expect(
      adapter.getDocument("tasks", "task-1", readOptions),
    ).resolves.toEqual(taskDoc);
    await expect(adapter.countDocuments("tasks", readOptions)).resolves.toBe(1);
    await expect(
      adapter.query({
        source: { type: "FullTableScan", tableName: "tasks", order: "asc" },
        filters: [],
        limit: null,
        activeIdentityKey: "user-1",
      }),
    ).resolves.toEqual([taskDoc]);

    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sql: expect.stringContaining("WHERE identity_key = ?"),
          params: ["user-1"],
        }),
        expect.objectContaining({
          sql: expect.stringContaining("WHERE id = ? AND identity_key = ?"),
          params: ["task-1", "user-1"],
        }),
      ]),
    );
  });

  it("uses table-qualified deletes for legacy shared rows", async () => {
    const { driver, executeBatch } = createMockDriver({
      existingTables: [ADAPTER_META_TABLE, "documents", "meta", "blobs"],
    });
    const adapter = await createSqliteStorage({ driver });

    await adapter.commit({
      puts: [],
      deletes: [{ id: "task-1", tableName: "tasks" }],
      meta: { timestamp: 2, lastCreationTime: 42 },
    });

    expect(
      allStatements(executeBatch).some((statement) =>
        statement.sql.includes('CREATE TABLE IF NOT EXISTS "documents__tasks"'),
      ),
    ).toBe(true);
    expect(
      statementsAt(executeBatch, executeBatch.mock.calls.length - 1),
    ).toContainEqual({
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
    let lastParams: readonly unknown[] | undefined;
    const { driver } = createMockDriver({
      existingTables: [ADAPTER_META_TABLE, "documents", "meta", "blobs"],
      routes: { tasks: "documents__tasks" },
      customQuery: async (sql: string, params?: readonly unknown[]) => {
        if (sql.startsWith('SELECT data FROM "documents__tasks" WHERE')) {
          lastSql = sql;
          lastParams = params;
          return [{ data: JSON.stringify(taskDoc) }];
        }
        return [];
      },
    });
    const adapter = await createSqliteStorage({ driver });

    const results = await adapter.vectorSearch({
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
    const adapter = await createSqliteStorage({ driver });

    await adapter.applyCommit(
      {
        puts: [
          {
            tableName: "tasks",
            doc: {
              _id: "task-1" as DocumentId,
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

    const statements = allStatements(executeBatch);
    expect(
      statements.some((statement) =>
        statement.sql.includes(
          'INSERT OR REPLACE INTO "internal__search_entries"',
        ),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.sql.includes(
          'INSERT OR REPLACE INTO "internal__search_filter_buckets"',
        ),
      ),
    ).toBe(true);
  });

  it("writes adapter-owned vector side-table rows on applyCommit", async () => {
    const { driver, executeBatch } = createMockDriver();
    const adapter = await createSqliteStorage({ driver });

    await adapter.applyCommit(
      {
        puts: [
          {
            tableName: "tasks",
            doc: {
              _id: "task-1" as DocumentId,
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

    const statements = allStatements(executeBatch);
    expect(
      statements.some((statement) =>
        statement.sql.includes(
          'INSERT OR REPLACE INTO "internal__vector_entries"',
        ),
      ),
    ).toBe(true);
    expect(
      statements.some((statement) =>
        statement.sql.includes(
          'INSERT OR REPLACE INTO "internal__vector_filter_buckets"',
        ),
      ),
    ).toBe(true);
  });

  it("writes per-column SQL when userTableSpecs is provided", async () => {
    const { driver, executeBatch } = createMockDriver();
    const userTableSpecs = new Map([
      ["tasks", buildUserTableSpec("tasks", tasksTableSchema())],
    ]);
    const adapter = await createSqliteStorage({ driver, userTableSpecs });

    await adapter.commit({
      puts: [
        {
          tableName: "tasks",
          doc: {
            _id: "task-1" as DocumentId,
            _creationTime: 42,
            __identityKey: "user-1",
            title: "ship it",
            priority: 7,
            tags: ["urgent", "demo"],
            meta: null,
          },
        },
      ],
      deletes: [],
      meta: { timestamp: 1, lastCreationTime: 42 },
    });

    const statements = allStatements(executeBatch);
    const insertStatement = statements.find((statement) =>
      statement.sql.includes('INSERT OR REPLACE INTO "documents__tasks"'),
    );
    expect(insertStatement?.sql).toBe(
      'INSERT OR REPLACE INTO "documents__tasks" ("id", "creation_time", "title", "priority", "tags", "meta", "identity_key") VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    expect(insertStatement?.params).toEqual([
      "task-1",
      42,
      "ship it",
      7,
      JSON.stringify(["urgent", "demo"]),
      null,
      "user-1",
    ]);

    expect(
      statements.some((statement) =>
        statement.sql.includes(
          'INSERT OR REPLACE INTO "documents__tasks" (id, creation_time, identity_key, data)',
        ),
      ),
    ).toBe(false);
  });

  it("round-trips a doc through the columnar reads path", async () => {
    const taskDoc = {
      _id: "task-1",
      _creationTime: 42,
      __identityKey: "user-1",
      title: "ship it",
      priority: 7,
      tags: ["urgent", "demo"],
      meta: null,
    };

    const userTableSpecs = new Map([
      ["tasks", buildUserTableSpec("tasks", tasksTableSchema())],
    ]);

    const { driver, query } = createMockDriver({
      existingTables: [
        ADAPTER_META_TABLE,
        "documents",
        "meta",
        "blobs",
        "documents__tasks",
      ],
      routes: { tasks: "documents__tasks" },
      customQuery: async (sql: string) => {
        if (
          sql.startsWith(
            'SELECT id, creation_time, "title", "priority", "tags", "meta", "identity_key" FROM "documents__tasks"',
          )
        ) {
          return [
            {
              id: "task-1",
              creation_time: 42,
              title: "ship it",
              priority: 7,
              tags: JSON.stringify(["urgent", "demo"]),
              meta: null,
              identity_key: "user-1",
            },
          ];
        }
        return [];
      },
    });
    const adapter = await createSqliteStorage({ driver, userTableSpecs });

    await expect(adapter.listDocuments("tasks")).resolves.toEqual([taskDoc]);
    await expect(adapter.getDocument("tasks", "task-1")).resolves.toEqual(
      taskDoc,
    );

    const sqlsCalled = query.mock.calls.map((call) => call[0]);
    expect(
      sqlsCalled.some((s) =>
        s.startsWith('SELECT data FROM "documents__tasks"'),
      ),
    ).toBe(false);
  });
});
