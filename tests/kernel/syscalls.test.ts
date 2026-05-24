import {
  createAsyncSyscall,
  createJsSyscall,
  createSyncSyscall,
  type RunUdfFn,
} from "@embedded/kernel/syscalls";
import type { Database } from "@embedded/runtime/db/database";
import type {
  DocumentId,
  GenericDocument,
  SerializedQuery,
} from "@embedded/runtime/db/types";
import type { StorageSurface } from "@embedded/runtime/storage";
import { describe, expect, it, vi } from "@tests/testkit";
import { ConvexError } from "convex/values";

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function errorData(error: unknown): { code: string } {
  expect(error).toBeInstanceOf(ConvexError);
  return (error as ConvexError<{ code: string }>).data;
}

function fullTableScan(tableName: string): SerializedQuery {
  return {
    source: { type: "FullTableScan", tableName, order: "asc" },
    operators: [],
  };
}

function seedDocument(
  db: Database,
  table: string,
  value: Record<string, unknown>,
): DocumentId {
  db.startTransaction();
  const id = db.insert(table, value);
  db.commit();
  return id;
}

function drainTable(db: Database, tableName: string): GenericDocument[] {
  const queryId = db.startQuery(fullTableScan(tableName));
  const rows: GenericDocument[] = [];
  for (;;) {
    const next = db.queryNext(queryId);
    if (next.done) break;
    if (next.value !== null) rows.push(next.value);
  }
  db.queryCleanup(queryId);
  return rows;
}

describe("createSyncSyscall", () => {
  it("1.0/queryStream starts a query and returns a numeric queryId", ({
    db,
  }) => {
    seedDocument(db, "tasks", { text: "hello" });
    const syncSyscall = createSyncSyscall(db);

    const result = parseJson<{ queryId: number }>(
      syncSyscall(
        "1.0/queryStream",
        JSON.stringify({ query: fullTableScan("tasks") }),
      ),
    );

    expect(typeof result.queryId).toBe("number");
  });

  it("1.0/queryCleanup releases a streamed query", ({ db }) => {
    seedDocument(db, "tasks", { text: "hello" });
    const syncSyscall = createSyncSyscall(db);
    const { queryId } = parseJson<{ queryId: number }>(
      syncSyscall(
        "1.0/queryStream",
        JSON.stringify({ query: fullTableScan("tasks") }),
      ),
    );

    syncSyscall("1.0/queryCleanup", JSON.stringify({ queryId }));

    expect(() => db.queryNext(queryId)).toThrow(/Bad queryId/);
  });

  it("1.0/db/normalizeId normalizes an id", ({ db }) => {
    const docId = seedDocument(db, "users", { name: "Alice" });
    const syncSyscall = createSyncSyscall(db);

    const result = parseJson<{ id: string }>(
      syncSyscall(
        "1.0/db/normalizeId",
        JSON.stringify({ table: "users", idString: docId }),
      ),
    );

    expect(result).toEqual({ id: docId });
  });

  it("throws a remote-routed ConvexError on an unknown remote op", ({ db }) => {
    const syncSyscall = createSyncSyscall(db);

    let thrown: unknown;
    try {
      syncSyscall("1.0/unknownOp", JSON.stringify({}));
    } catch (error) {
      thrown = error;
    }

    expect(errorData(thrown).code).toBe("LOCAL_SYSCALL_UNSUPPORTED");
    expect((thrown as Error).message).toMatch(
      /Local execution does not support syscall.*1\.0\/unknownOp.*route\.remote\(\)/,
    );
  });
});

describe("createAsyncSyscall — document CRUD", () => {
  it("1.0/insert inserts a document and returns its id", async ({ db }) => {
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, vi.fn<RunUdfFn>());

    const result = parseJson<{ _id: string }>(
      await asyncSyscall(
        "1.0/insert",
        JSON.stringify({ table: "users", value: { name: "Alice" } }),
      ),
    );
    db.commit();

    expect(typeof result._id).toBe("string");
  });

  it("1.0/get retrieves an inserted document", async ({ db }) => {
    const docId = seedDocument(db, "users", { name: "Alice" });
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, vi.fn<RunUdfFn>());

    const result = parseJson<GenericDocument | null>(
      await asyncSyscall(
        "1.0/get",
        JSON.stringify({ table: "users", id: docId }),
      ),
    );
    db.rollbackWrites();

    expect(result).toMatchObject({ name: "Alice" });
  });

  it("1.0/get returns null for a missing document", async ({ db }) => {
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, vi.fn<RunUdfFn>());

    const result = parseJson<GenericDocument | null>(
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

  it("1.0/shallowMerge patches an existing document", async ({ db }) => {
    const docId = seedDocument(db, "users", { name: "Alice", age: 30 });
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, vi.fn<RunUdfFn>());

    await asyncSyscall(
      "1.0/shallowMerge",
      JSON.stringify({ table: "users", id: docId, value: { age: 31 } }),
    );
    db.commit();

    db.startTransaction();
    const doc = db.get("users", docId);
    db.rollbackWrites();

    expect(doc).toMatchObject({ name: "Alice", age: 31 });
  });

  it("1.0/replace replaces an existing document", async ({ db }) => {
    const docId = seedDocument(db, "users", { name: "Alice", age: 30 });
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, vi.fn<RunUdfFn>());

    await asyncSyscall(
      "1.0/replace",
      JSON.stringify({ table: "users", id: docId, value: { name: "Bob" } }),
    );
    db.commit();

    db.startTransaction();
    const doc = db.get("users", docId);
    db.rollbackWrites();

    expect(doc).toMatchObject({ name: "Bob" });
    expect(doc).not.toHaveProperty("age");
  });

  it("1.0/remove deletes a document", async ({ db }) => {
    const docId = seedDocument(db, "users", { name: "Alice" });
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, vi.fn<RunUdfFn>());

    await asyncSyscall(
      "1.0/remove",
      JSON.stringify({ table: "users", id: docId }),
    );
    db.commit();

    db.startTransaction();
    const doc = db.get("users", docId);
    db.rollbackWrites();

    expect(doc).toBeNull();
  });
});

describe("createAsyncSyscall — query ops", () => {
  it("1.0/queryStreamNext iterates query results to completion", async ({
    db,
  }) => {
    seedDocument(db, "tasks", { text: "a" });
    seedDocument(db, "tasks", { text: "b" });
    const syncSyscall = createSyncSyscall(db);
    const { queryId } = parseJson<{ queryId: number }>(
      syncSyscall(
        "1.0/queryStream",
        JSON.stringify({ query: fullTableScan("tasks") }),
      ),
    );

    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, vi.fn<RunUdfFn>());
    const next = async () =>
      parseJson<{ done: boolean }>(
        await asyncSyscall("1.0/queryStreamNext", JSON.stringify({ queryId })),
      );
    const r1 = await next();
    const r2 = await next();
    const r3 = await next();
    db.rollbackWrites();

    expect(r1.done).toBe(false);
    expect(r2.done).toBe(false);
    expect(r3.done).toBe(true);
  });

  it("1.0/queryPage paginates results", async ({ db }) => {
    seedDocument(db, "tasks", { text: "a" });
    seedDocument(db, "tasks", { text: "b" });
    seedDocument(db, "tasks", { text: "c" });
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, vi.fn<RunUdfFn>());

    const result = parseJson<{
      page: GenericDocument[];
      isDone: boolean;
      continueCursor: string | null;
    }>(
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

  it("1.0/count counts documents in a table", async ({ db }) => {
    seedDocument(db, "tasks", { text: "a" });
    seedDocument(db, "tasks", { text: "b" });
    seedDocument(db, "tasks", { text: "c" });
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, vi.fn<RunUdfFn>());

    const result = parseJson<number>(
      await asyncSyscall("1.0/count", JSON.stringify({ table: "tasks" })),
    );
    db.rollbackWrites();

    expect(result).toBe(3);
  });
});

describe("createAsyncSyscall — auth", () => {
  it("1.0/getUserIdentity returns null when no identity is configured", async ({
    db,
  }) => {
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, vi.fn<RunUdfFn>());

    const result = parseJson<unknown>(
      await asyncSyscall("1.0/getUserIdentity", JSON.stringify({})),
    );
    db.rollbackWrites();

    expect(result).toBeNull();
  });

  it("1.0/getUserIdentity returns the configured identity", async ({ db }) => {
    const identity = { subject: "user-123", issuer: "https://example.com" };
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, vi.fn<RunUdfFn>(), {
      getIdentity: async () => identity,
    });

    const result = parseJson<typeof identity>(
      await asyncSyscall("1.0/getUserIdentity", JSON.stringify({})),
    );
    db.rollbackWrites();

    expect(result).toEqual(identity);
  });
});

describe("createAsyncSyscall — errors and dispatch", () => {
  it("throws a remote-routed ConvexError on an unknown async op", async ({
    db,
  }) => {
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, vi.fn<RunUdfFn>());

    const error = await asyncSyscall(
      "1.0/unknownAsyncOp",
      JSON.stringify({}),
    ).catch((err: unknown) => err);
    db.rollbackWrites();

    expect(errorData(error).code).toBe("LOCAL_SYSCALL_UNSUPPORTED");
    expect((error as Error).message).toMatch(
      /Local execution does not support async syscall.*1\.0\/unknownAsyncOp.*route\.remote\(\)/,
    );
  });

  it("dispatches a nested action call via runUdf", async ({ db }) => {
    db.startTransaction();
    const runUdf = vi.fn<RunUdfFn>().mockResolvedValueOnce({ delivered: true });
    const asyncSyscall = createAsyncSyscall(db, runUdf);

    const result = parseJson<{ delivered: boolean }>(
      await asyncSyscall(
        "1.0/runUdf",
        JSON.stringify({ udfType: "action", name: "messages:send", args: {} }),
      ),
    );
    db.rollbackWrites();

    expect(runUdf).toHaveBeenCalledWith(
      "action",
      expect.objectContaining({ udfPath: "messages:send" }),
      {},
    );
    expect(result).toEqual({ delivered: true });
  });

  it("fails closed for an unknown nested udf type", async ({ db }) => {
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, vi.fn<RunUdfFn>());

    const error = await asyncSyscall(
      "1.0/runUdf",
      JSON.stringify({
        udfType: "httpAction",
        name: "messages:webhook",
        args: {},
      }),
    ).catch((err: unknown) => err);
    db.rollbackWrites();

    expect(errorData(error).code).toBe("NESTED_UDF_TYPE_UNSUPPORTED");
    expect((error as Error).message).toMatch(
      /does not support nested udf type.*httpAction/,
    );
  });

  it("fails closed when storage getUrl has no local surface", async ({
    db,
  }) => {
    db.startTransaction();
    const storageId = db.insert("_storage", {
      sha256: "abc",
      size: 3,
      contentType: "text/plain",
    });
    db.commit();

    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, vi.fn<RunUdfFn>());

    await expect(
      asyncSyscall(
        "1.0/storageGetUrl",
        JSON.stringify({ storageId: String(storageId) }),
      ),
    ).rejects.toThrow(/Local storage getUrl is not available in this runtime/);

    db.rollbackWrites();
  });

  it("fails closed when upload URLs have no local surface", async ({ db }) => {
    db.startTransaction();
    const asyncSyscall = createAsyncSyscall(db, vi.fn<RunUdfFn>());

    await expect(
      asyncSyscall("1.0/storageGenerateUploadUrl", JSON.stringify({})),
    ).rejects.toThrow(
      /Local storage generateUploadUrl is not available in this runtime/,
    );

    db.rollbackWrites();
  });

  it("uses the configured storage surface for getUrl and upload URLs", async ({
    db,
  }) => {
    db.startTransaction();
    const storageId = db.insert("_storage", {
      sha256: "abc",
      size: 3,
      contentType: "text/plain",
    });
    db.commit();

    db.startTransaction();
    const getUrl = vi.fn<StorageSurface["getUrl"]>(async (id) => `blob:${id}`);
    const generateUploadUrl = vi.fn<StorageSurface["generateUploadUrl"]>(
      async () => "http://convex-embedded.local/__convex_embedded/upload/token",
    );
    const surface: StorageSurface = { getUrl, generateUploadUrl };
    const asyncSyscall = createAsyncSyscall(db, vi.fn<RunUdfFn>(), {
      getStorageSurface: () => surface,
    });

    const urlResult = parseJson<string>(
      await asyncSyscall(
        "1.0/storageGetUrl",
        JSON.stringify({ storageId: String(storageId) }),
      ),
    );
    const uploadResult = parseJson<string>(
      await asyncSyscall("1.0/storageGenerateUploadUrl", JSON.stringify({})),
    );
    db.rollbackWrites();

    expect(urlResult).toBe(`blob:${storageId}`);
    expect(uploadResult).toBe(
      "http://convex-embedded.local/__convex_embedded/upload/token",
    );
    expect(getUrl).toHaveBeenCalledWith(String(storageId));
    expect(generateUploadUrl).toHaveBeenCalled();
  });
});

describe("createJsSyscall — storage", () => {
  it("storeBlob stores a blob that getBlob retrieves", async ({ db }) => {
    db.startTransaction();
    const jsSyscall = createJsSyscall(db);
    const storageId = await jsSyscall("storage/storeBlob", {
      blob: new Blob(["hello world"], { type: "text/plain" }),
    });
    db.commit();

    db.startTransaction();
    const retrieved = await jsSyscall("storage/getBlob", {
      storageId: String(storageId),
    });
    db.rollbackWrites();

    expect(retrieved).toBeInstanceOf(Blob);
    expect(await (retrieved as Blob).text()).toBe("hello world");
  });

  it("storeBlob does not enqueue a pending-upload row by default", async ({
    db,
  }) => {
    db.startTransaction();
    const jsSyscall = createJsSyscall(db);
    await jsSyscall("storage/storeBlob", {
      blob: new Blob(["x"], { type: "text/plain" }),
    });
    db.commit();

    db.startTransaction();
    const rows = drainTable(db, "_resolve_pending_uploads");
    db.rollbackWrites();

    expect(rows).toHaveLength(0);
  });

  it("storeBlob enqueues a pending-upload row when shouldQueueUploads is true", async ({
    db,
  }) => {
    db.startTransaction();
    const jsSyscall = createJsSyscall(db, undefined, {
      getIdentityKey: () => "user-1",
      shouldQueueUploads: () => true,
    });
    const storageId = await jsSyscall("storage/storeBlob", {
      blob: new Blob(["hi"], { type: "image/png" }),
    });
    db.commit();

    db.startTransaction();
    const rows = drainTable(db, "_resolve_pending_uploads");
    db.rollbackWrites();

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.localStorageId).toBe(String(storageId));
    expect(row?.contentType).toBe("image/png");
    expect(row?.size).toBe(2);
    expect(row?.identityKey).toBe("user-1");
    expect(row?.state).toBe("pending");
    expect(typeof row?.sha256).toBe("string");
  });

  it("throws a remote-routed ConvexError on an unknown js op", async ({
    db,
  }) => {
    const jsSyscall = createJsSyscall(db);

    const error = await jsSyscall("storage/unknownOp", {}).catch(
      (err: unknown) => err,
    );

    expect(errorData(error).code).toBe("LOCAL_SYSCALL_UNSUPPORTED");
    expect((error as Error).message).toMatch(
      /Local execution does not support js syscall.*storage\/unknownOp.*route\.remote\(\)/,
    );
  });
});
