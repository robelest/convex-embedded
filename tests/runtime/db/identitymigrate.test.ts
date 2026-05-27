import { openNodeStorage } from "@embedded/node/sqlite/adapter";
import { createDatabase } from "@embedded/runtime/db/database";
import type { ParsedSchema } from "@embedded/runtime/db/schema";
import type { StorageAdapter } from "@embedded/storage/adapter";
import { buildUserTableSpecs } from "@embedded/storage/sqlite/factory";
import { temporaryDatabasePath, uniqueSuffix } from "@tests/helpers/storage";
import { afterEach, describe, expect, it } from "@tests/testkit";

function tasksSchema(): ParsedSchema {
  return {
    schemaValidation: false,
    tables: new Map([
      [
        "tasks",
        {
          indexes: [{ indexDescriptor: "by_status", fields: ["status"] }],
          vectorIndexes: [],
          searchIndexes: [],
          documentType: {
            type: "object",
            value: {
              status: { fieldType: { type: "string" }, optional: false },
            },
          },
        },
      ],
    ]),
  } as unknown as ParsedSchema;
}

async function openSharedStorage(): Promise<StorageAdapter> {
  return openNodeStorage({
    filename: temporaryDatabasePath(uniqueSuffix("identity-migrate")),
    userTableSpecs: buildUserTableSpecs(tasksSchema()),
  });
}

/**
 * Write a doc under `writeIdentity`, then read it back from a SECOND Database
 * that shares the same storage but starts with a cold in-memory cache — so the
 * row exists only in SQLite (never in `_documents`), matching the cold-load
 * remote-merge case.
 */
describe("anonymous→identity migration reaches SQLite user tables", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  it("re-stamps null-identity rows that live only in SQLite (cold cache)", async () => {
    const schema = tasksSchema();
    const storage = await openSharedStorage();
    cleanups.push(async () => {
      await storage.close?.();
    });

    const writer = createDatabase(schema);
    writer.setStorage(storage);
    writer.setActiveIdentityKey(null);
    writer.startTransaction();
    const id = writer.insert("tasks", { status: "active" });
    await writer.commitAsync();

    const reader = createDatabase(schema);
    reader.setStorage(storage);
    reader.setActiveIdentityKey("user-1");

    expect(
      (await reader.listDocumentsAsync("tasks")).map((d) => d._id),
    ).not.toContain(id);

    await reader.reStampAnonymousUserTablesInStorage("user-1");

    expect(
      (await reader.listDocumentsAsync("tasks")).map((d) => d._id),
    ).toContain(id);
  });

  it("does not steal rows already owned by a different identity", async () => {
    const schema = tasksSchema();
    const storage = await openSharedStorage();
    cleanups.push(async () => {
      await storage.close?.();
    });

    const writer = createDatabase(schema);
    writer.setStorage(storage);
    writer.setActiveIdentityKey("user-2");
    writer.startTransaction();
    const id = writer.insert("tasks", { status: "active" });
    await writer.commitAsync();

    const reader = createDatabase(schema);
    reader.setStorage(storage);
    reader.setActiveIdentityKey("user-1");
    await reader.reStampAnonymousUserTablesInStorage("user-1");

    expect(
      (await reader.listDocumentsAsync("tasks")).map((d) => d._id),
    ).not.toContain(id);

    reader.setActiveIdentityKey("user-2");
    expect(
      (await reader.listDocumentsAsync("tasks")).map((d) => d._id),
    ).toContain(id);
  });
});
