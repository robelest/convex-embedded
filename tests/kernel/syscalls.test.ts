import {
  createSyncSyscall,
  createAsyncSyscall,
  createJsSyscall,
} from "@embedded/kernel/syscalls";
import { Database } from "@embedded/runtime/db/database";
import { describe, it, expect, beforeEach } from "@tests/testkit";
import { ConvexError } from "convex/values";
import { vi } from "vitest";

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

  it("1.0/queryCleanup releases a streamed query", () => {
    seedDocument("tasks", { text: "hello" });

    const syncSyscall = createSyncSyscall(db);
    const { queryId } = JSON.parse(
      syncSyscall(
        "1.0/queryStream",
        JSON.stringify({ query: fullTableScan("tasks") }),
      ),
    );

    syncSyscall("1.0/queryCleanup", JSON.stringify({ queryId }));

    expect(() => db.queryNext(queryId)).toThrow(/Bad queryId/);
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

  it("throws on unknown remote op", () => {
    const syncSyscall = createSyncSyscall(db);

    try {
      syncSyscall("1.0/unknownOp", JSON.stringify({}));
      throw new Error("expected sync syscall to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConvexError);
      expect((error as ConvexError<any>).data.code).toBe(
        "LOCAL_SYSCALL_UNSUPPORTED",
      );
      expect((error as Error).message).toMatch(
        /Local execution does not support syscall.*1\.0\/unknownOp.*route\.remote\(\)/,
      );
    }
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

    const error = await asyncSyscall(
      "1.0/unknownAsyncOp",
      JSON.stringify({}),
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<any>).data.code).toBe(
      "LOCAL_SYSCALL_UNSUPPORTED",
    );
    expect((error as Error).message).toMatch(
      /Local execution does not support async syscall.*1\.0\/unknownAsyncOp.*route\.remote\(\)/,
    );

    db.rollbackWrites();
  });

  it("fails closed for unsupported nested udf types", async () => {
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, mockRunUdf);

    const error = await asyncSyscall(
      "1.0/runUdf",
      JSON.stringify({
        udfType: "action",
        name: "messages:send",
        args: {},
      }),
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<any>).data.code).toBe(
      "NESTED_UDF_TYPE_UNSUPPORTED",
    );
    expect((error as Error).message).toMatch(
      /does not support nested udf type.*action.*route\.remote\(\)/,
    );

    db.rollbackWrites();
  });

  it("fails closed when storage getUrl has no local surface", async () => {
    db.startTransaction();
    const storageId = db.insert("_storage", {
      sha256: "abc",
      size: 3,
      contentType: "text/plain",
    });
    db.commit();

    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, mockRunUdf);

    await expect(
      asyncSyscall(
        "1.0/storageGetUrl",
        JSON.stringify({ storageId: storageId as string }),
      ),
    ).rejects.toThrow(/Local storage getUrl is not available in this runtime/);

    db.rollbackWrites();
  });

  it("fails closed when upload URLs have no local surface", async () => {
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, mockRunUdf);

    await expect(
      asyncSyscall("1.0/storageGenerateUploadUrl", JSON.stringify({})),
    ).rejects.toThrow(
      /Local storage generateUploadUrl is not available in this runtime/,
    );

    db.rollbackWrites();
  });

  it("uses the configured storage surface for getUrl and upload URLs", async () => {
    db.startTransaction();
    const storageId = db.insert("_storage", {
      sha256: "abc",
      size: 3,
      contentType: "text/plain",
    });
    db.commit();

    db.startTransaction();
    const surface = {
      getUrl: vi.fn(async (id: string) => `blob:${id}`),
      generateUploadUrl: vi.fn(
        async () =>
          "http://convex-embedded.local/__convex_embedded/upload/token",
      ),
    };
    const asyncSyscall = createAsyncSyscall(db, mockRunUdf, {
      getStorageSurface: () => surface,
    });

    const urlResult = JSON.parse(
      await asyncSyscall(
        "1.0/storageGetUrl",
        JSON.stringify({ storageId: storageId as string }),
      ),
    );
    const uploadResult = JSON.parse(
      await asyncSyscall("1.0/storageGenerateUploadUrl", JSON.stringify({})),
    );

    expect(urlResult).toBe(`blob:${storageId}`);
    expect(uploadResult).toBe(
      "http://convex-embedded.local/__convex_embedded/upload/token",
    );
    expect(surface.getUrl).toHaveBeenCalledWith(storageId);
    expect(surface.generateUploadUrl).toHaveBeenCalled();

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

  it("storage/storeBlob does NOT enqueue a pending-upload row by default", async () => {
    db.startTransaction();
    const jsSyscall = createJsSyscall(db);

    await jsSyscall("storage/storeBlob", {
      blob: new Blob(["x"], { type: "text/plain" }),
    });
    db.commit();

    db.startTransaction();
    const qid = db.startQuery({
      source: {
        type: "FullTableScan",
        tableName: "_resolve_pending_uploads",
        order: "asc",
      },
      operators: [],
    });
    const rows: unknown[] = [];
    while (true) {
      const next = db.queryNext(qid);
      if (next.done) break;
      rows.push(next.value);
    }
    db.queryCleanup(qid);
    db.rollbackWrites();

    expect(rows).toHaveLength(0);
  });

  it("storage/storeBlob enqueues a pending-upload row when shouldQueueUploads returns true", async () => {
    db.startTransaction();
    const jsSyscall = createJsSyscall(db, undefined, {
      getIdentityKey: () => "user-1",
      shouldQueueUploads: () => true,
    });

    const storageId = (await jsSyscall("storage/storeBlob", {
      blob: new Blob(["hi"], { type: "image/png" }),
    })) as string;
    db.commit();

    db.startTransaction();
    const qid = db.startQuery({
      source: {
        type: "FullTableScan",
        tableName: "_resolve_pending_uploads",
        order: "asc",
      },
      operators: [],
    });
    const rows: Array<Record<string, unknown>> = [];
    while (true) {
      const next = db.queryNext(qid);
      if (next.done) break;
      rows.push(next.value as Record<string, unknown>);
    }
    db.queryCleanup(qid);
    db.rollbackWrites();

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.localStorageId).toBe(storageId);
    expect(row.contentType).toBe("image/png");
    expect(row.size).toBe(2);
    expect(row.identityKey).toBe("user-1");
    expect(row.state).toBe("pending");
    expect(typeof row.sha256).toBe("string");
  });

  it("throws on unknown js op", async () => {
    const jsSyscall = createJsSyscall(db);

    const error = await jsSyscall("storage/unknownOp", {}).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<any>).data.code).toBe(
      "LOCAL_SYSCALL_UNSUPPORTED",
    );
    expect((error as Error).message).toMatch(
      /Local execution does not support js syscall.*storage\/unknownOp.*route\.remote\(\)/,
    );
  });
});
