import { describe, it, expect, vi } from "vitest";

import { Database } from "#embedded/core/database";
import type { StorageAdapter } from "#embedded/storage/adapter";
import { ephemeralStorage } from "#embedded/storage/memory";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a Database backed by a ephemeralStorage adapter, hydrate it,
 * and return both.
 */
async function createPersistedDb(storage?: StorageAdapter) {
  const s = storage ?? ephemeralStorage();
  const db = new Database(null, s);
  await db.hydrate();
  return { db, storage: s };
}

/** Drain a query iterator into yielded values. */
function* iterateQuery(db: any, queryId: number) {
  let next = db.queryNext(queryId);
  while (!next.done) {
    yield next.value;
    next = db.queryNext(queryId);
  }
}

/** Insert a document inside a transaction and commit. */
function insertAndCommit(
  db: Database,
  table: string,
  fields: Record<string, unknown> = {},
) {
  db.startTransaction();
  const id = db.insert(table, fields);
  const result = db.commit();
  return { id, ...result };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Database persistence", () => {
  // -- Basic round-trip ---------------------------------------------------

  describe("round-trip", () => {
    it("documents survive a simulated restart", async () => {
      const storage = ephemeralStorage();

      // Session 1: insert documents
      const { db: db1 } = await createPersistedDb(storage);
      insertAndCommit(db1, "tasks", { text: "buy milk" });
      insertAndCommit(db1, "tasks", { text: "walk dog" });

      // Wait for fire-and-forget storage writes to settle
      await new Promise((r) => setTimeout(r, 10));

      // Session 2: create a new Database from the same storage
      const { db: db2 } = await createPersistedDb(storage);

      // Query documents from the hydrated database
      db2.startTransaction();
      const qid = db2.startQuery({
        source: { type: "FullTableScan", tableName: "tasks", order: null },
        operators: [],
      });
      const results = Array.from(iterateQuery(db2, qid)).filter(Boolean);
      db2.queryCleanup(qid);
      db2.rollbackWrites();

      expect(results).toHaveLength(2);
      expect(results.map((r: any) => r.text)).toContain("buy milk");
      expect(results.map((r: any) => r.text)).toContain("walk dog");
    });

    it("metadata counters survive a restart", async () => {
      const storage = ephemeralStorage();

      const { db: db1 } = await createPersistedDb(storage);
      insertAndCommit(db1, "tasks", { text: "a" });
      insertAndCommit(db1, "tasks", { text: "b" });

      await new Promise((r) => setTimeout(r, 10));

      const meta = await storage.getMeta();
      expect(meta).not.toBeNull();
      expect(meta!.timestamp).toBe(2);

      // Session 2: verify timestamp and IDs continue from where they left off
      const { db: db2 } = await createPersistedDb(storage);
      expect(db2.timestamp).toBe(2);

      // A new insert should not collide with previous IDs
      const { id } = insertAndCommit(db2, "tasks", { text: "c" });
      expect(id).toBeDefined();
      expect(db2.timestamp).toBe(3);
    });
  });

  // -- Deletes ------------------------------------------------------------

  describe("deletes", () => {
    it("deleted documents are not restored on hydration", async () => {
      const storage = ephemeralStorage();

      const { db: db1 } = await createPersistedDb(storage);
      const { id } = insertAndCommit(db1, "tasks", { text: "temp" });

      // Delete it
      db1.startTransaction();
      db1.delete("tasks", id);
      db1.commit();

      await new Promise((r) => setTimeout(r, 10));

      // Session 2
      const { db: db2 } = await createPersistedDb(storage);
      db2.startTransaction();
      const doc = db2.get("tasks", id);
      db2.rollbackWrites();

      expect(doc).toBeNull();
    });
  });

  // -- Patch / Replace ----------------------------------------------------

  describe("mutations", () => {
    it("patched documents persist the updated values", async () => {
      const storage = ephemeralStorage();

      const { db: db1 } = await createPersistedDb(storage);
      const { id } = insertAndCommit(db1, "tasks", {
        text: "original",
        done: false,
      });

      db1.startTransaction();
      db1.patch("tasks", id, { done: true });
      db1.commit();

      await new Promise((r) => setTimeout(r, 10));

      const { db: db2 } = await createPersistedDb(storage);
      db2.startTransaction();
      const doc = db2.get("tasks", id);
      db2.rollbackWrites();

      expect(doc).not.toBeNull();
      expect(doc!.done).toBe(true);
      expect(doc!.text).toBe("original");
    });
  });

  // -- No storage (backward compat) --------------------------------------

  describe("no storage", () => {
    it("Database works without a storage adapter", () => {
      const db = new Database(null);
      insertAndCommit(db, "tasks", { text: "ephemeral" });

      db.startTransaction();
      const qid = db.startQuery({
        source: { type: "FullTableScan", tableName: "tasks", order: null },
        operators: [],
      });
      const next = db.queryNext(qid);
      db.queryCleanup(qid);
      db.rollbackWrites();

      expect(next.value).not.toBeNull();
      expect((next.value as any).text).toBe("ephemeral");
    });

    it("hydrate is a no-op without storage", async () => {
      const db = new Database(null);
      await db.hydrate(); // should not throw
      expect(db.timestamp).toBe(0);
    });
  });

  // -- Storage error handling ---------------------------------------------

  describe("error handling", () => {
    it("storage commit failure does not break in-memory state", async () => {
      const storage = ephemeralStorage();
      const failingStorage: StorageAdapter = {
        ...storage,
        commit: vi.fn().mockRejectedValue(new Error("disk full")),
      };

      const db = new Database(null, failingStorage);

      // Suppress the console.error from fire-and-forget
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      insertAndCommit(db, "tasks", { text: "test" });

      // In-memory state should still be correct
      db.startTransaction();
      const doc = db.get(
        undefined,
        db.normalizeId("tasks", Object.keys((db as any)._documents)[0])!,
      );
      db.rollbackWrites();

      expect(doc).not.toBeNull();
      expect((doc as any).text).toBe("test");

      spy.mockRestore();
    });
  });

  // -- clear --------------------------------------------------------------

  describe("clear via storage", () => {
    it("clears storage when adapter.clear() is called directly", async () => {
      const storage = ephemeralStorage();

      const { db: db1 } = await createPersistedDb(storage);
      insertAndCommit(db1, "tasks", { text: "hello" });

      await new Promise((r) => setTimeout(r, 10));

      await storage.clear();

      // New database from cleared storage starts empty
      const { db: db2 } = await createPersistedDb(storage);
      expect(db2.timestamp).toBe(0);
    });
  });
});
