import {
  Database,
  type DatabaseCommitResult,
} from "@embedded/runtime/db/database";
import type { DocumentId } from "@embedded/runtime/db/types";
import type { StorageAdapter } from "@embedded/storage/adapter";
import { OpaqueTestAdapter, mockAdapter } from "@tests/helpers/adapter";
import { describe, expect, it, vi } from "@tests/testkit";
import type { GenericDocument } from "convex/server";

async function persistedDb(storage: StorageAdapter): Promise<Database> {
  const db = new Database(null, storage);
  await db.hydrate();
  return db;
}

function* drainQuery(
  db: Database,
  queryId: number,
): Generator<GenericDocument> {
  let next = db.queryNext(queryId);
  while (!next.done) {
    if (next.value !== null) {
      yield next.value;
    }
    next = db.queryNext(queryId);
  }
}

function scanTable(db: Database, tableName: string): GenericDocument[] {
  db.startTransaction();
  const queryId = db.startQuery({
    source: { type: "FullTableScan", tableName, order: null },
    operators: [],
  });
  const rows = Array.from(drainQuery(db, queryId));
  db.queryCleanup(queryId);
  db.rollbackWrites();
  return rows;
}

async function insertAndCommit(
  db: Database,
  table: string,
  fields: Record<string, unknown> = {},
): Promise<{ id: DocumentId; commit: DatabaseCommitResult }> {
  db.startTransaction();
  const id = db.insert(table, fields);
  const commit = db.commit();
  await commit.persisted;
  return { id, commit };
}

describe("Database storage", () => {
  describe("round-trip", () => {
    it("documents survive a simulated restart", async ({ storage }) => {
      const session1 = await persistedDb(storage);
      await insertAndCommit(session1, "tasks", { text: "buy milk" });
      await insertAndCommit(session1, "tasks", { text: "walk dog" });

      const session2 = await persistedDb(storage);
      const rows = scanTable(session2, "tasks");

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.text)).toEqual(
        expect.arrayContaining(["buy milk", "walk dog"]),
      );
    });

    it("metadata counters survive a restart", async ({ storage }) => {
      const session1 = await persistedDb(storage);
      await insertAndCommit(session1, "tasks", { text: "a" });
      await insertAndCommit(session1, "tasks", { text: "b" });

      const meta = await storage.getMetadata();
      expect(meta?.timestamp).toBe(2);

      const session2 = await persistedDb(storage);
      expect(session2.timestamp).toBe(2);

      const { id } = await insertAndCommit(session2, "tasks", { text: "c" });
      expect(id).toBeDefined();
      expect(session2.timestamp).toBe(3);
    });
  });

  describe("deletes", () => {
    it("deleted documents are not restored on hydration", async ({
      storage,
    }) => {
      const session1 = await persistedDb(storage);
      const { id } = await insertAndCommit(session1, "tasks", { text: "temp" });

      session1.startTransaction();
      session1.delete("tasks", id);
      await session1.commit().persisted;

      const session2 = await persistedDb(storage);
      session2.startTransaction();
      const doc = session2.get("tasks", id);
      session2.rollbackWrites();

      expect(doc).toBeNull();
    });
  });

  describe("mutations", () => {
    it("patched documents persist the updated values", async ({ storage }) => {
      const session1 = await persistedDb(storage);
      const { id } = await insertAndCommit(session1, "tasks", {
        text: "original",
        done: false,
      });

      session1.startTransaction();
      session1.patch("tasks", id, { done: true });
      await session1.commit().persisted;

      const session2 = await persistedDb(storage);
      session2.startTransaction();
      const doc = session2.get("tasks", id);
      session2.rollbackWrites();

      expect(doc).not.toBeNull();
      expect(doc?.done).toBe(true);
      expect(doc?.text).toBe("original");
    });
  });

  describe("no storage", () => {
    it("works without a storage adapter", ({ db }) => {
      db.startTransaction();
      db.insert("tasks", { text: "ephemeral" });
      db.commit();

      const rows = scanTable(db, "tasks");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.text).toBe("ephemeral");
    });

    it("hydrate is a no-op without storage", async ({ db }) => {
      await db.hydrate();
      expect(db.timestamp).toBe(0);
    });
  });

  describe("error handling", () => {
    it("storage commit failure does not corrupt in-memory state", async ({
      track,
    }) => {
      const backing = track(new OpaqueTestAdapter());
      const failingStorage = mockAdapter({
        kind: "opaque",
        getDocuments: (table, opts) => backing.getDocuments(table, opts),
        getMetadata: () => backing.getMetadata(),
        write: vi.fn().mockRejectedValue(new Error("disk full")),
        storeBlob: (id, blob) => backing.storeBlob(id, blob),
        deleteBlob: (id) => backing.deleteBlob(id),
        clearAll: () => backing.clearAll(),
      });

      const db = new Database(null, failingStorage);
      vi.spyOn(console, "error").mockImplementation(() => {});

      db.startTransaction();
      const id = db.insert("tasks", { text: "test" });
      db.commit().persisted.catch(() => undefined);

      db.startTransaction();
      const doc = db.get("tasks", id);
      db.rollbackWrites();

      expect(doc?.text).toBe("test");
    });
  });

  describe("clear via storage", () => {
    it("a database built from cleared storage starts empty", async ({
      storage,
    }) => {
      const session1 = await persistedDb(storage);
      await insertAndCommit(session1, "tasks", { text: "hello" });

      await storage.clearAll();

      const session2 = await persistedDb(storage);
      expect(session2.timestamp).toBe(0);
    });
  });
});
