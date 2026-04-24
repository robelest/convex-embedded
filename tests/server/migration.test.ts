import { runMigrations, migration } from "@resolve/server/migration";
import { define, register as registerField } from "@resolve/server/schema";
import { describe, it, expect } from "@tests/testkit";
import { v } from "convex/values";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock Convex context
// ---------------------------------------------------------------------------

function createMockCtx() {
  const tables: Record<string, any[]> = {};

  return {
    db: {
      query: (tableName: string) => {
        const data = tables[tableName] ?? [];
        return {
          withIndex: (indexName: string, builder: any) => ({
            collect: async () => {
              if (indexName !== "by_table") {
                throw new Error(`Unexpected index ${indexName}`);
              }

              const predicate = builder({
                eq: (fieldName: string, value: unknown) => ({
                  fieldName,
                  value,
                }),
              }) as {
                fieldName: string;
                value: unknown;
              };

              return data.filter(
                (row) => row[predicate.fieldName] === predicate.value,
              );
            },
          }),
          collect: async () => data,
        };
      },
      insert: async (tableName: string, row: any) => {
        tables[tableName] ??= [];
        const id = `id_${Date.now()}_${Math.random()}`;
        tables[tableName].push({ ...row, _id: id });
        return id;
      },
      patch: async (id: string, patches: any) => {
        Object.values(tables)
          .flatMap((rows) => rows as any[])
          .filter((row) => row._id === id)
          .forEach((row) => Object.assign(row, patches));
      },
      delete: async (id: string) => {
        for (const [name, rows] of Object.entries(tables)) {
          tables[name] = (rows as any[]).filter((r) => r._id !== id);
        }
      },
    },
    runMutation: vi.fn(),
    _tables: tables,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migration.VERSION_TABLE", () => {
  it("is _resolve_schema_versions", () => {
    expect(migration.VERSION_TABLE).toBe("_resolve_schema_versions");
  });
});

describe("runMigrations()", () => {
  it("returns false when already at target version", async () => {
    const ctx = createMockCtx();
    const schemaDef = define({
      version: 1,
      shape: { title: registerField(v.string()) },
    });

    // Pre-seed the version table
    ctx._tables["_resolve_schema_versions"] = [
      { _id: "v1", table: "tasks", version: 1 },
    ];

    const result = await runMigrations(ctx as any, {
      table: "tasks",
      schema: schemaDef,
    });

    expect(result).toBe(false);
  });

  it("initializes version to 1 on first run", async () => {
    const ctx = createMockCtx();
    const schemaDef = define({
      version: 1,
      shape: { title: registerField(v.string()) },
    });

    const result = await runMigrations(ctx as any, {
      table: "tasks",
      schema: schemaDef,
    });

    // First run with target v1: initializes to v1 (no actual migrations to run,
    // but returns true because initialization was performed)
    expect(result).toBe(true);

    // Version record should now exist
    expect(ctx._tables["_resolve_schema_versions"]).toBeDefined();
    expect(ctx._tables["_resolve_schema_versions"].length).toBeGreaterThan(0);
  });

  it("runs migration function for each version step", async () => {
    const ctx = createMockCtx();
    const schemaDef = define({
      version: 3,
      shape: { title: registerField(v.string()) },
    });

    // Start at version 1
    ctx._tables["_resolve_schema_versions"] = [
      { _id: "v1", table: "tasks", version: 1 },
    ];

    const migrationV2 = { _name: "migrationV2" } as any;
    const migrationV3 = { _name: "migrationV3" } as any;

    const result = await runMigrations(ctx as any, {
      table: "tasks",
      schema: schemaDef,
      migrations: {
        2: migrationV2,
        3: migrationV3,
      },
    });

    expect(result).toBe(true);
    expect(ctx.runMutation).toHaveBeenCalledTimes(2);
    expect(ctx.runMutation).toHaveBeenCalledWith(migrationV2, {});
    expect(ctx.runMutation).toHaveBeenCalledWith(migrationV3, {});
  });

  it("applies defaults when no migration function exists", async () => {
    const ctx = createMockCtx();
    const schemaDef = define({
      version: 2,
      shape: { title: registerField(v.string()) },
      defaults: { priority: "medium" },
    });

    // Start at version 1
    ctx._tables["_resolve_schema_versions"] = [
      { _id: "v1", table: "tasks", version: 1 },
    ];

    // Pre-seed the tasks table
    ctx._tables["tasks"] = [
      { _id: "t1", title: "Task 1" },
      { _id: "t2", title: "Task 2" },
    ];

    const result = await runMigrations(ctx as any, {
      table: "tasks",
      schema: schemaDef,
      // No migrations provided — should apply defaults
    });

    expect(result).toBe(true);
    // Both tasks should have priority patched
    expect(ctx._tables["tasks"][0].priority).toBe("medium");
    expect(ctx._tables["tasks"][1].priority).toBe("medium");
  });

  it("does not overwrite existing values when applying defaults", async () => {
    const ctx = createMockCtx();
    const schemaDef = define({
      version: 2,
      shape: { title: registerField(v.string()) },
      defaults: { priority: "medium" },
    });

    ctx._tables["_resolve_schema_versions"] = [
      { _id: "v1", table: "tasks", version: 1 },
    ];

    ctx._tables["tasks"] = [{ _id: "t1", title: "Task 1", priority: "high" }];

    await runMigrations(ctx as any, {
      table: "tasks",
      schema: schemaDef,
    });

    // Should not overwrite existing priority
    expect(ctx._tables["tasks"][0].priority).toBe("high");
  });

  it("throws on newer local schema version", async () => {
    const ctx = createMockCtx();
    const schemaDef = define({
      version: 1,
      shape: { title: registerField(v.string()) },
    });

    // Already at version 3
    ctx._tables["_resolve_schema_versions"] = [
      { _id: "v1", table: "tasks", version: 3 },
    ];

    await expect(
      runMigrations(ctx as any, {
        table: "tasks",
        schema: schemaDef,
      }),
    ).rejects.toThrow("Forward-only migrations");
  });

  it("runs local migration steps with document helpers", async () => {
    const ctx = createMockCtx();
    const schemaDef = define({
      version: 2,
      shape: {
        title: registerField(v.string()),
        priority: registerField(v.string()),
      },
      migrate: {
        2: async ({ docs }) => {
          await docs.patchMissing({ priority: "medium" });
        },
      },
    });

    ctx._tables["_resolve_schema_versions"] = [
      { _id: "v1", table: "tasks", version: 1 },
    ];
    ctx._tables["tasks"] = [{ _id: "t1", _creationTime: 1, title: "Task 1" }];

    const local = {
      async transaction<T>(work: () => Promise<T> | T): Promise<T> {
        return await work();
      },
      async list(table: string) {
        return ctx._tables[table] ?? [];
      },
      async patch(_table: string, id: string, fields: Record<string, unknown>) {
        await ctx.db.patch(id, fields);
      },
      async replace(
        _table: string,
        id: string,
        fields: Record<string, unknown>,
      ) {
        const rows = Object.values(ctx._tables)
          .flatMap((rows) => rows as any[])
          .filter((row) => row._id === id);
        rows.forEach((row) => {
          const { _id, _creationTime } = row;
          Object.keys(row).forEach((key) => delete row[key]);
          Object.assign(row, { _id, _creationTime, ...fields });
        });
      },
      async delete(idTable: string, id: string) {
        await ctx.db.delete(id);
      },
    };

    const result = await runMigrations(
      {
        ...(ctx as any),
        local,
      },
      {
        table: "tasks",
        schema: schemaDef,
        migrations: schemaDef.migrate,
      },
    );

    expect(result).toBe(true);
    expect(ctx._tables["tasks"][0].priority).toBe("medium");
  });

  it("uses the highest stored version when duplicate rows exist", async () => {
    const ctx = createMockCtx();
    const schemaDef = define({
      version: 2,
      shape: { title: registerField(v.string()) },
    });

    ctx._tables["_resolve_schema_versions"] = [
      { _id: "v1", table: "tasks", version: 1 },
      { _id: "v2", table: "tasks", version: 2 },
    ];

    const result = await runMigrations(ctx as any, {
      table: "tasks",
      schema: schemaDef,
      migrations: { 2: { _name: "shouldNotRun" } as any },
    });

    expect(result).toBe(false);
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("treats malformed stored versions as missing instead of looping forever", async () => {
    const ctx = createMockCtx();
    const schemaDef = define({
      version: 1,
      shape: { title: registerField(v.string()) },
    });

    ctx._tables["_resolve_schema_versions"] = [
      { _id: "v1", table: "tasks", version: "not-a-number" },
      { _id: "v2", table: "tasks", version: undefined },
    ];

    const result = await Promise.race([
      runMigrations(ctx as any, {
        table: "tasks",
        schema: schemaDef,
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("migration timeout")), 100);
      }),
    ]);

    expect(result).toBe(true);
    expect(ctx._tables["_resolve_schema_versions"]).toEqual([
      expect.objectContaining({ table: "tasks", version: 1 }),
    ]);
  });

  it("deduplicates version rows when storing a new version", async () => {
    const ctx = createMockCtx();
    const schemaDef = define({
      version: 2,
      shape: { title: registerField(v.string()) },
      defaults: { priority: "medium" },
    });

    ctx._tables["_resolve_schema_versions"] = [
      { _id: "v1", table: "tasks", version: 1 },
      { _id: "v2", table: "tasks", version: 1 },
    ];

    await runMigrations(ctx as any, {
      table: "tasks",
      schema: schemaDef,
    });

    expect(ctx._tables["_resolve_schema_versions"]).toEqual([
      expect.objectContaining({ table: "tasks", version: 2 }),
    ]);
  });

  it("falls back to insert when patching stored version fails", async () => {
    const ctx = createMockCtx();
    const schemaDef = define({
      version: 2,
      shape: { title: registerField(v.string()) },
    });

    ctx._tables["_resolve_schema_versions"] = [
      { _id: "v1", table: "tasks", version: 1 },
    ];

    const originalPatch = ctx.db.patch;
    ctx.db.patch = vi.fn(async (id: string, patches: any) => {
      if (id === "v1") {
        throw new Error("patch failed");
      }
      await originalPatch(id, patches);
    });

    await runMigrations(ctx as any, {
      table: "tasks",
      schema: schemaDef,
      migrations: { 2: { _name: "v2Migration" } as any },
    });

    expect(ctx._tables["_resolve_schema_versions"]).toEqual([
      expect.objectContaining({ table: "tasks", version: 2 }),
    ]);
  });

  it("calls onMigrationError when migration fails", async () => {
    const ctx = createMockCtx();
    const schemaDef = define({
      version: 2,
      shape: { title: registerField(v.string()) },
    });

    ctx._tables["_resolve_schema_versions"] = [
      { _id: "v1", table: "tasks", version: 1 },
    ];

    const failingMigration = { _name: "failing" } as any;
    ctx.runMutation.mockRejectedValue(new Error("migration failed"));

    const onMigrationError = vi.fn().mockResolvedValue({ action: "retry" });

    const result = await runMigrations(ctx as any, {
      table: "tasks",
      schema: schemaDef,
      migrations: { 2: failingMigration },
      onMigrationError,
    });

    expect(result).toBe(true);
    expect(onMigrationError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        currentVersion: 1,
        targetVersion: 2,
        canResetSafely: true,
      }),
    );
  });

  it("throws when migration fails and no error handler", async () => {
    const ctx = createMockCtx();
    const schemaDef = define({
      version: 2,
      shape: { title: registerField(v.string()) },
    });

    ctx._tables["_resolve_schema_versions"] = [
      { _id: "v1", table: "tasks", version: 1 },
    ];

    ctx.runMutation.mockRejectedValue(new Error("boom"));

    await expect(
      runMigrations(ctx as any, {
        table: "tasks",
        schema: schemaDef,
        migrations: { 2: { _name: "failing" } as any },
      }),
    ).rejects.toThrow("boom");
  });

  it("recovery action 'reset' wipes table data", async () => {
    const ctx = createMockCtx();
    const schemaDef = define({
      version: 2,
      shape: { title: registerField(v.string()) },
    });

    ctx._tables["_resolve_schema_versions"] = [
      { _id: "v1", table: "tasks", version: 1 },
    ];
    ctx._tables["tasks"] = [
      { _id: "t1", title: "Task 1" },
      { _id: "t2", title: "Task 2" },
    ];

    ctx.runMutation.mockRejectedValue(new Error("migration failed"));

    await runMigrations(ctx as any, {
      table: "tasks",
      schema: schemaDef,
      migrations: { 2: { _name: "failing" } as any },
      onMigrationError: async () => ({ action: "reset" as const }),
    });

    // Tasks should be wiped
    expect(ctx._tables["tasks"]).toHaveLength(0);
  });

  it("uses the local adapter for reset recovery when available", async () => {
    const ctx = createMockCtx();
    const schemaDef = define({
      version: 2,
      shape: { title: registerField(v.string()) },
    });

    ctx._tables["_resolve_schema_versions"] = [
      { _id: "v1", table: "tasks", version: 1 },
    ];
    ctx._tables["tasks"] = [{ _id: "t1", _creationTime: 1, title: "Task 1" }];
    ctx.runMutation.mockRejectedValue(new Error("migration failed"));

    const local = {
      transaction: vi.fn(async (work: () => Promise<unknown>) => await work()),
      list: vi.fn(async (table: string) => ctx._tables[table] ?? []),
      patch: vi.fn(async () => undefined),
      replace: vi.fn(async () => undefined),
      delete: vi.fn(async (table: string, id: string) => {
        ctx._tables[table] = (ctx._tables[table] ?? []).filter(
          (row) => row._id !== id,
        );
      }),
    };

    await runMigrations(
      {
        ...(ctx as any),
        local,
      },
      {
        table: "tasks",
        schema: schemaDef,
        migrations: { 2: { _name: "failing" } as any },
        onMigrationError: async () => ({ action: "reset" as const }),
      },
    );

    expect(local.transaction).toHaveBeenCalled();
    expect(local.delete).toHaveBeenCalledWith("tasks", "t1");
    expect(ctx._tables["tasks"]).toHaveLength(0);
  });
});
