import { describe, it, expect, vi, beforeEach } from "vitest";

import { Database } from "#embedded/core/database";
import {
  createSyncSyscall,
  createAsyncSyscall,
  createJsSyscall,
} from "#embedded/kernel/syscalls";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: Database;
const mockRunUdf = vi.fn();

/** Shorthand for a full-table-scan query descriptor. */
const fullTableScan = (tableName: string) => ({
  source: { type: "FullTableScan", tableName, order: "asc" },
  operators: [],
});

/** Insert a document within a transaction and commit, returning the _id. */
function seedDocument(table: string, value: Record<string, unknown>): string {
  db.startTransaction();
  const _id = db.insert(table, value);
  db.commit();
  return _id as string;
}

beforeEach(() => {
  db = new Database(null);
  mockRunUdf.mockReset();
});

// ---------------------------------------------------------------------------
// createSyncSyscall
// ---------------------------------------------------------------------------

describe("createSyncSyscall", () => {
  it("1.0/queryStream starts a query and returns queryId", () => {
    seedDocument("tasks", { text: "hello" });

    const syncSyscall = createSyncSyscall(db);
    const result = JSON.parse(
      syncSyscall(
        "1.0/queryStream",
        JSON.stringify({ query: fullTableScan("tasks") }),
      ),
    );

    expect(result).toHaveProperty("queryId");
    expect(typeof result.queryId).toBe("number");
  });

  it("1.0/db/normalizeId normalizes an id", () => {
    const docId = seedDocument("users", { name: "Alice" });

    const syncSyscall = createSyncSyscall(db);
    const result = JSON.parse(
      syncSyscall(
        "1.0/db/normalizeId",
        JSON.stringify({ table: "users", idString: docId }),
      ),
    );

    expect(result).toEqual({ id: docId });
  });

  it("throws on unknown sync op", () => {
    const syncSyscall = createSyncSyscall(db);

    expect(() => syncSyscall("1.0/unknownOp", JSON.stringify({}))).toThrow(
      /does not support syscall.*1\.0\/unknownOp/,
    );
  });
});

// ---------------------------------------------------------------------------
// createAsyncSyscall — Document CRUD
// ---------------------------------------------------------------------------

describe("createAsyncSyscall — Document CRUD", () => {
  it("1.0/insert inserts a document and returns its id", async () => {
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, mockRunUdf);
    const result = JSON.parse(
      await asyncSyscall(
        "1.0/insert",
        JSON.stringify({ table: "users", value: { name: "Alice" } }),
      ),
    );
    db.commit();

    expect(result).toHaveProperty("_id");
    expect(typeof result._id).toBe("string");
  });

  it("1.0/get retrieves an inserted document", async () => {
    const docId = seedDocument("users", { name: "Alice" });

    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, mockRunUdf);
    const result = JSON.parse(
      await asyncSyscall(
        "1.0/get",
        JSON.stringify({ table: "users", id: docId }),
      ),
    );
    db.rollbackWrites();

    expect(result).toMatchObject({ name: "Alice" });
  });

  it("1.0/get returns null for missing document", async () => {
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, mockRunUdf);
    const result = JSON.parse(
      await asyncSyscall(
        "1.0/get",
        JSON.stringify({
          table: "users",
          id: "00000000-0000-0000-0000-000000000000",
        }),
      ),
    );
    db.rollbackWrites();

    expect(result).toBeNull();
  });

  it("1.0/shallowMerge patches an existing document", async () => {
    const docId = seedDocument("users", { name: "Alice", age: 30 });

    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, mockRunUdf);
    await asyncSyscall(
      "1.0/shallowMerge",
      JSON.stringify({ table: "users", id: docId, value: { age: 31 } }),
    );
    db.commit();

    // Read back to confirm
    db.startTransaction();
    const doc = db.get("users", docId as any);
    db.rollbackWrites();

    expect(doc).toMatchObject({ name: "Alice", age: 31 });
  });

  it("1.0/replace replaces an existing document", async () => {
    const docId = seedDocument("users", { name: "Alice", age: 30 });

    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, mockRunUdf);
    await asyncSyscall(
      "1.0/replace",
      JSON.stringify({ table: "users", id: docId, value: { name: "Bob" } }),
    );
    db.commit();

    // Read back to confirm the old field "age" is gone
    db.startTransaction();
    const doc = db.get("users", docId as any);
    db.rollbackWrites();

    expect(doc).toMatchObject({ name: "Bob" });
    expect(doc).not.toHaveProperty("age");
  });

  it("1.0/remove deletes a document", async () => {
    const docId = seedDocument("users", { name: "Alice" });

    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, mockRunUdf);
    await asyncSyscall(
      "1.0/remove",
      JSON.stringify({ table: "users", id: docId }),
    );
    db.commit();

    // Confirm deletion
    db.startTransaction();
    const doc = db.get("users", docId as any);
    db.rollbackWrites();

    expect(doc).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createAsyncSyscall — Query ops
// ---------------------------------------------------------------------------

describe("createAsyncSyscall — Query ops", () => {
  it("1.0/queryStreamNext iterates query results", async () => {
    seedDocument("tasks", { text: "a" });
    seedDocument("tasks", { text: "b" });

    const syncSyscall = createSyncSyscall(db);
    const { queryId } = JSON.parse(
      syncSyscall(
        "1.0/queryStream",
        JSON.stringify({ query: fullTableScan("tasks") }),
      ),
    );

    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, mockRunUdf);

    const r1 = JSON.parse(
      await asyncSyscall("1.0/queryStreamNext", JSON.stringify({ queryId })),
    );
    const r2 = JSON.parse(
      await asyncSyscall("1.0/queryStreamNext", JSON.stringify({ queryId })),
    );
    const r3 = JSON.parse(
      await asyncSyscall("1.0/queryStreamNext", JSON.stringify({ queryId })),
    );
    db.rollbackWrites();

    // First two have values, third signals done
    expect(r1.done).toBe(false);
    expect(r2.done).toBe(false);
    expect(r3.done).toBe(true);
  });

  it("1.0/queryPage paginates results", async () => {
    seedDocument("tasks", { text: "a" });
    seedDocument("tasks", { text: "b" });
    seedDocument("tasks", { text: "c" });

    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, mockRunUdf);

    const result = JSON.parse(
      await asyncSyscall(
        "1.0/queryPage",
        JSON.stringify({
          query: fullTableScan("tasks"),
          cursor: null,
          pageSize: 2,
        }),
      ),
    );
    db.rollbackWrites();

    expect(result.page).toHaveLength(2);
    expect(result.isDone).toBe(false);
    expect(result.continueCursor).toBeDefined();
  });

  it("1.0/count counts documents in a table", async () => {
    seedDocument("tasks", { text: "a" });
    seedDocument("tasks", { text: "b" });
    seedDocument("tasks", { text: "c" });

    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, mockRunUdf);

    const result = JSON.parse(
      await asyncSyscall("1.0/count", JSON.stringify({ table: "tasks" })),
    );
    db.rollbackWrites();

    expect(result).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// createAsyncSyscall — Auth
// ---------------------------------------------------------------------------

describe("createAsyncSyscall — Auth", () => {
  it("1.0/getUserIdentity returns null when no identity configured", async () => {
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, mockRunUdf);

    const result = JSON.parse(
      await asyncSyscall("1.0/getUserIdentity", JSON.stringify({})),
    );
    db.rollbackWrites();

    expect(result).toBeNull();
  });

  it("1.0/getUserIdentity returns the identity when configured", async () => {
    const identity = { subject: "user-123", issuer: "https://example.com" };

    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, mockRunUdf, {
      getIdentity: async () => identity,
    });

    const result = JSON.parse(
      await asyncSyscall("1.0/getUserIdentity", JSON.stringify({})),
    );
    db.rollbackWrites();

    expect(result).toEqual(identity);
  });
});

// ---------------------------------------------------------------------------
// createAsyncSyscall — Error
// ---------------------------------------------------------------------------

describe("createAsyncSyscall — Error", () => {
  it("throws on unknown async op", async () => {
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, mockRunUdf);

    await expect(
      asyncSyscall("1.0/unknownAsyncOp", JSON.stringify({})),
    ).rejects.toThrow(/does not support async syscall.*1\.0\/unknownAsyncOp/);

    db.rollbackWrites();
  });
});

// ---------------------------------------------------------------------------
// createJsSyscall — Storage
// ---------------------------------------------------------------------------

describe("createJsSyscall — Storage", () => {
  it("storage/storeBlob stores and storage/getBlob retrieves a blob", async () => {
    db.startTransaction();
    const jsSyscall = createJsSyscall(db);

    const blob = new Blob(["hello world"], { type: "text/plain" });
    const storageId = await jsSyscall("storage/storeBlob", { blob });
    db.commit();

    db.startTransaction();
    const retrieved = (await jsSyscall("storage/getBlob", {
      storageId: storageId as string,
    })) as Blob;
    db.rollbackWrites();

    expect(retrieved).toBeInstanceOf(Blob);
    expect(await retrieved.text()).toBe("hello world");
  });

  it("throws on unknown js op", async () => {
    const jsSyscall = createJsSyscall(db);

    await expect(jsSyscall("storage/unknownOp", {})).rejects.toThrow(
      /does not support js syscall.*storage\/unknownOp/,
    );
  });
});
