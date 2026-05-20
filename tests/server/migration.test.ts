import { embeddedTable } from "@embedded/server";
import { register } from "@embedded/server/fields";
import {
  migration,
  runMigrations,
  type MigrationRuntimeAdapter,
} from "@embedded/server/migration";
import { describe, expect, it, vi } from "@tests/testkit";
import { v } from "convex/values";

function createInMemoryAdapter(): MigrationRuntimeAdapter & {
  rows: Record<string, Array<Record<string, unknown>>>;
  schemaOps: Array<{ table: string; ops: unknown[] }>;
} {
  const rows: Record<string, Array<Record<string, unknown>>> = {};
  const schemaOps: Array<{ table: string; ops: unknown[] }> = [];
  let nextId = 1;
  const allocId = () => `id_${nextId++}`;

  const adapter: MigrationRuntimeAdapter = {
    systemReadByIndex: async ({ table, range }) => {
      const tableRows = rows[table] ?? [];
      return tableRows.filter((row) =>
        range.every((entry) => row[entry.fieldPath] === entry.value),
      );
    },
    systemInsert: async (table, doc) => {
      const id = allocId();
      const row = { _id: id, _creationTime: Date.now(), ...doc };
      rows[table] ??= [];
      rows[table].push(row);
      return id;
    },
    systemPatch: async (id, fields) => {
      for (const tableRows of Object.values(rows)) {
        const row = tableRows.find((r) => r._id === id);
        if (row) Object.assign(row, fields);
      }
    },
    systemDelete: async (id) => {
      for (const [table, tableRows] of Object.entries(rows)) {
        rows[table] = tableRows.filter((r) => r._id !== id);
      }
    },
    tableList: async (table) => rows[table] ?? [],
    tableGet: async (table, id) =>
      (rows[table] ?? []).find((r) => r._id === id) ?? null,
    tableInsert: async (table, doc) => {
      const id = allocId();
      const row = { _id: id, _creationTime: Date.now(), ...doc };
      rows[table] ??= [];
      rows[table].push(row);
      return id;
    },
    tablePatch: async (table, id, fields) => {
      const tableRows = rows[table] ?? [];
      const row = tableRows.find((r) => r._id === id);
      if (row) Object.assign(row, fields);
    },
    tableReplace: async (table, id, fields) => {
      const tableRows = rows[table] ?? [];
      const idx = tableRows.findIndex((r) => r._id === id);
      if (idx >= 0) tableRows[idx] = { ...fields };
    },
    tableDelete: async (table, id) => {
      rows[table] = (rows[table] ?? []).filter((r) => r._id !== id);
    },
    applySchemaOps: async (table, ops) => {
      schemaOps.push({ table, ops: [...ops] });
    },
  };

  return Object.assign(adapter, { rows, schemaOps });
}

describe("migration constants", () => {
  it("VERSION_TABLE is _resolve_schema_versions", () => {
    expect(migration.VERSION_TABLE).toBe("_resolve_schema_versions");
  });
});

describe("embeddedTable migrations option", () => {
  it("derives version 1 when no migrations provided", () => {
    const tasks = embeddedTable("tasks_v1", {
      title: register(v.string()),
    });
    expect(
      (tasks as unknown as { schema: { version: number } }).schema.version,
    ).toBe(1);
  });

  it("derives version from max migration key", () => {
    const tasks = embeddedTable(
      "tasks_v3",
      {
        title: register(v.string()),
      },
      {
        migrations: {
          2: async () => undefined,
          3: async () => undefined,
        },
      },
    );
    expect(
      (tasks as unknown as { schema: { version: number } }).schema.version,
    ).toBe(3);
  });
});

describe("runMigrations", () => {
  it("returns false when already at target version", async () => {
    const adapter = createInMemoryAdapter();
    adapter.rows["_resolve_schema_versions"] = [
      { _id: "v1", _creationTime: 0, table: "tasks", version: 1 },
    ];

    const tasks = embeddedTable("tasks_already_v1", {
      title: register(v.string()),
    });

    const result = await runMigrations({
      table: "tasks",
      schema: (tasks as unknown as { schema: any }).schema,
      adapter,
    });

    expect(result).toBe(false);
  });

  it("initializes to version 1 on first run", async () => {
    const adapter = createInMemoryAdapter();
    const tasks = embeddedTable("tasks_init", {
      title: register(v.string()),
    });

    const result = await runMigrations({
      table: "tasks",
      schema: (tasks as unknown as { schema: any }).schema,
      adapter,
    });

    expect(result).toBe(true);
    const versionRows = adapter.rows["_resolve_schema_versions"] ?? [];
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0]?.version).toBe(1);
  });

  it("runs each version step in sequence with the new ctx shape", async () => {
    const adapter = createInMemoryAdapter();
    adapter.rows["_resolve_schema_versions"] = [
      { _id: "v1", _creationTime: 0, table: "tasks", version: 1 },
    ];

    const calls: number[] = [];
    const tasks = embeddedTable(
      "tasks_seq",
      {
        title: register(v.string()),
      },
      {
        migrations: {
          2: async (ctx) => {
            calls.push(2);
            expect(ctx.table).toBe("tasks");
            expect(ctx.schema.fromVersion).toBe(1);
            expect(ctx.schema.toVersion).toBe(2);
          },
          3: async (ctx) => {
            calls.push(3);
            expect(ctx.schema.fromVersion).toBe(2);
            expect(ctx.schema.toVersion).toBe(3);
          },
        },
      },
    );

    await runMigrations({
      table: "tasks",
      schema: (tasks as unknown as { schema: any }).schema,
      adapter,
    });

    expect(calls).toEqual([2, 3]);
    expect(adapter.rows["_resolve_schema_versions"]?.[0]?.version).toBe(3);
  });

  it("emits SchemaOps via ctx.schema.addColumn / addIndex", async () => {
    const adapter = createInMemoryAdapter();
    adapter.rows["_resolve_schema_versions"] = [
      { _id: "v1", _creationTime: 0, table: "tasks", version: 1 },
    ];

    const tasks = embeddedTable(
      "tasks_ddl",
      {
        title: register(v.string()),
      },
      {
        migrations: {
          2: async ({ schema: s }) => {
            await s.addColumn("priority", v.string());
            await s.addIndex("by_priority", ["priority"]);
          },
        },
      },
    );

    await runMigrations({
      table: "tasks",
      schema: (tasks as unknown as { schema: any }).schema,
      adapter,
    });

    expect(adapter.schemaOps).toHaveLength(2);
    expect(adapter.schemaOps[0]).toEqual({
      table: "tasks",
      ops: [
        {
          type: "addColumn",
          column: "priority",
          sqlType: "TEXT",
          defaultSql: undefined,
        },
      ],
    });
    expect(adapter.schemaOps[1]).toEqual({
      table: "tasks",
      ops: [
        {
          type: "addIndex",
          name: "by_priority",
          fields: ["priority"],
          unique: undefined,
        },
      ],
    });
  });

  it("throws when stored version exceeds target", async () => {
    const adapter = createInMemoryAdapter();
    adapter.rows["_resolve_schema_versions"] = [
      { _id: "v1", _creationTime: 0, table: "tasks", version: 5 },
    ];

    const tasks = embeddedTable("tasks_too_new", {
      title: register(v.string()),
    });

    await expect(
      runMigrations({
        table: "tasks",
        schema: (tasks as unknown as { schema: any }).schema,
        adapter,
      }),
    ).rejects.toThrow("Forward-only");
  });

  it("ctx.db helpers operate on the table being migrated", async () => {
    const adapter = createInMemoryAdapter();
    adapter.rows["tasks"] = [
      { _id: "t1", _creationTime: 0, title: "alpha" },
      { _id: "t2", _creationTime: 0, title: "beta" },
    ];
    adapter.rows["_resolve_schema_versions"] = [
      { _id: "v1", _creationTime: 0, table: "tasks", version: 1 },
    ];

    const tasks = embeddedTable(
      "tasks_db_ops",
      { title: register(v.string()) },
      {
        migrations: {
          2: async ({ db }) => {
            await db.patchMissing({ priority: "medium" });
          },
        },
      },
    );

    await runMigrations({
      table: "tasks",
      schema: (tasks as unknown as { schema: any }).schema,
      adapter,
    });

    const taskRows = adapter.rows["tasks"];
    expect(taskRows?.[0]?.priority).toBe("medium");
    expect(taskRows?.[1]?.priority).toBe("medium");
  });

  it("handleRecovery action=reset wipes table data and advances version", async () => {
    const adapter = createInMemoryAdapter();
    adapter.rows["tasks"] = [
      { _id: "t1", _creationTime: 0, title: "alpha" },
      { _id: "t2", _creationTime: 0, title: "beta" },
    ];
    adapter.rows["_resolve_schema_versions"] = [
      { _id: "v1", _creationTime: 0, table: "tasks", version: 1 },
    ];

    const tasks = embeddedTable(
      "tasks_recovery_reset",
      { title: register(v.string()) },
      {
        migrations: {
          2: async () => {
            throw new Error("intentional v2 failure");
          },
        },
      },
    );

    const result = await runMigrations({
      table: "tasks",
      schema: (tasks as unknown as { schema: any }).schema,
      adapter,
      onMigrationError: async (_error, ctx) => {
        expect(ctx.currentVersion).toBe(1);
        expect(ctx.targetVersion).toBe(2);
        return { action: "reset" };
      },
    });

    expect(result).toBe(true);
    expect(adapter.rows["tasks"]).toEqual([]);
    expect(adapter.rows["_resolve_schema_versions"]?.[0]?.version).toBe(2);
  });

  it("handleRecovery action=retry leaves stored version unchanged", async () => {
    const adapter = createInMemoryAdapter();
    adapter.rows["_resolve_schema_versions"] = [
      { _id: "v1", _creationTime: 0, table: "tasks", version: 1 },
    ];

    const tasks = embeddedTable(
      "tasks_recovery_retry",
      { title: register(v.string()) },
      {
        migrations: {
          2: async () => {
            throw new Error("intentional v2 failure");
          },
        },
      },
    );

    await runMigrations({
      table: "tasks",
      schema: (tasks as unknown as { schema: any }).schema,
      adapter,
      onMigrationError: async () => ({ action: "retry" }),
    });

    expect(adapter.rows["_resolve_schema_versions"]?.[0]?.version).toBe(1);
  });

  it("handleRecovery action=custom invokes the supplied handler", async () => {
    const adapter = createInMemoryAdapter();
    adapter.rows["_resolve_schema_versions"] = [
      { _id: "v1", _creationTime: 0, table: "tasks", version: 1 },
    ];

    const customHandler = vi.fn(async () => undefined);
    const tasks = embeddedTable(
      "tasks_recovery_custom",
      { title: register(v.string()) },
      {
        migrations: {
          2: async () => {
            throw new Error("intentional v2 failure");
          },
        },
      },
    );

    await runMigrations({
      table: "tasks",
      schema: (tasks as unknown as { schema: any }).schema,
      adapter,
      onMigrationError: async () => ({
        action: "custom",
        handler: customHandler,
      }),
    });

    expect(customHandler).toHaveBeenCalledTimes(1);
    expect(adapter.rows["_resolve_schema_versions"]?.[0]?.version).toBe(1);
  });

  it("cleans up duplicate version rows on advance", async () => {
    const adapter = createInMemoryAdapter();
    adapter.rows["_resolve_schema_versions"] = [
      { _id: "v1a", _creationTime: 0, table: "tasks", version: 1 },
      { _id: "v1b", _creationTime: 0, table: "tasks", version: 1 },
    ];

    const tasks = embeddedTable(
      "tasks_dedupe",
      { title: register(v.string()) },
      {
        migrations: {
          2: async () => undefined,
        },
      },
    );

    await runMigrations({
      table: "tasks",
      schema: (tasks as unknown as { schema: any }).schema,
      adapter,
    });

    const versionRows = adapter.rows["_resolve_schema_versions"] ?? [];
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0]?.version).toBe(2);
  });
});
