import { v } from "convex/values";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { runMigrations, migration } from "#resolve/server/migration";
import { define, register as registerField } from "#resolve/server/schema";

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
          filter: (fn: any) => ({
            collect: async () => {
              // Simple mock filter — just return all (filter is a no-op mock)
              return data;
            },
          }),
          collect: async () => data,
        };
      },
      insert: async (tableName: string, row: any) => {
        if (!tables[tableName]) tables[tableName] = [];
        const id = `id_${Date.now()}_${Math.random()}`;
        tables[tableName].push({ ...row, _id: id });
        return id;
      },
      patch: async (id: string, patches: any) => {
        for (const rows of Object.values(tables)) {
          const row = (rows as any[]).find((r) => r._id === id);
          if (row) Object.assign(row, patches);
        }
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

  it("returns false on downgrade", async () => {
    const ctx = createMockCtx();
    const schemaDef = define({
      version: 1,
      shape: { title: registerField(v.string()) },
    });

    // Already at version 3
    ctx._tables["_resolve_schema_versions"] = [
      { _id: "v1", table: "tasks", version: 3 },
    ];

    const result = await runMigrations(ctx as any, {
      table: "tasks",
      schema: schemaDef,
    });

    expect(result).toBe(false);
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
});
