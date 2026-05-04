import type { StoredDocument } from "@embedded/runtime/db/types";
import type { WriteBatch } from "@embedded/storage/adapter";
import { OpaqueTestAdapter } from "@tests/helpers/adapter";
import { describe, it, expect, beforeEach } from "@tests/testkit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function doc(
  id: string,
  _table: string,
  fields: Record<string, unknown> = {},
): StoredDocument {
  return {
    _id: id as any,
    _creationTime: Date.now(),
    ...fields,
  };
}

function batchPut(
  docObj: StoredDocument,
  tableName: string,
): { doc: StoredDocument; tableName: string } {
  return { doc: docObj, tableName };
}

function batch(
  puts: Array<{ doc: StoredDocument; tableName: string }> = [],
  deletes: Array<string | { id: string; tableName: string }> = [],
  meta = { timestamp: 1, lastCreationTime: 1000 },
): WriteBatch {
  return {
    puts,
    deletes: deletes.map((entry) =>
      typeof entry === "string" ? { id: entry, tableName: "tasks" } : entry,
    ),
    meta,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ephemeralStorage", () => {
  let storage: OpaqueTestAdapter;

  beforeEach(() => {
    storage = new OpaqueTestAdapter();
  });

  // -- Hydration (empty state) --------------------------------------------

  describe("empty state", () => {
    it("getDocuments returns empty array", async () => {
      expect(await storage.listAll()).toEqual([]);
    });

    it("getMeta returns null", async () => {
      expect(await storage.meta()).toBeNull();
    });

    it("getBlobs returns empty array", async () => {
      expect(await storage.listBlobs()).toEqual([]);
    });
  });

  // -- commit -------------------------------------------------------------

  describe("commit", () => {
    it("persists put documents", async () => {
      const d = doc("1", "tasks", { text: "hello" });
      await storage.commit(batch([batchPut(d, "tasks")]));

      const docs = await storage.listAll();
      expect(docs).toHaveLength(1);
      expect(docs[0]).toEqual({ doc: d, tableName: "tasks" });
    });

    it("persists meta", async () => {
      const meta = { timestamp: 5, lastCreationTime: 9999 };
      await storage.commit(batch([], [], meta));

      expect(await storage.meta()).toEqual(meta);
    });

    it("deletes documents by ID", async () => {
      const d1 = doc("1", "tasks", { text: "a" });
      const d2 = doc("2", "tasks", { text: "b" });
      await storage.commit(
        batch([batchPut(d1, "tasks"), batchPut(d2, "tasks")]),
      );

      await storage.commit(batch([], [d1._id as string]));

      const docs = await storage.listAll();
      expect(docs).toHaveLength(1);
      expect(docs[0].doc._id).toBe(d2._id);
    });

    it("handles puts and deletes in the same batch", async () => {
      const d1 = doc("1", "tasks");
      const d2 = doc("2", "tasks");
      await storage.commit(
        batch([batchPut(d1, "tasks"), batchPut(d2, "tasks")]),
      );

      const d3 = doc("3", "tasks");
      await storage.commit(batch([batchPut(d3, "tasks")], [d1._id as string]));

      const docs = await storage.listAll();
      expect(docs).toHaveLength(2);
      const ids = docs.map((d) => d.doc._id);
      expect(ids).toContain(d2._id);
      expect(ids).toContain(d3._id);
    });

    it("replaces document with same ID on put", async () => {
      const d = doc("1", "tasks", { text: "v1" });
      await storage.commit(batch([batchPut(d, "tasks")]));

      const updated = { ...d, text: "v2" };
      await storage.commit(batch([batchPut(updated, "tasks")]));

      const docs = await storage.listAll();
      expect(docs).toHaveLength(1);
      expect(docs[0].doc.text).toBe("v2");
    });

    it("gets a document in O(1) storage without scanning tables", async () => {
      const d = doc("1", "tasks", { text: "hello" });
      await storage.commit(batch([batchPut(d, "tasks")]));

      await expect(storage.get("tasks", "1")).resolves.toEqual(d);
      await expect(storage.get("users", "1")).resolves.toBeNull();
    });

    it("updates meta on each commit", async () => {
      await storage.commit(
        batch([], [], {
          timestamp: 1,
          lastCreationTime: 100,
        }),
      );
      await storage.commit(
        batch([], [], {
          timestamp: 2,
          lastCreationTime: 200,
        }),
      );

      const meta = await storage.meta();
      expect(meta).toEqual({
        timestamp: 2,
        lastCreationTime: 200,
      });
    });
  });

  // -- Blob storage -------------------------------------------------------

  describe("blob storage", () => {
    it("storeBlob and getBlobs round-trip", async () => {
      const blob = new Blob(["test content"], { type: "text/plain" });
      await storage.putBlob("blob-1", blob);

      const blobs = await storage.listBlobs();
      expect(blobs).toHaveLength(1);
      expect(blobs[0].id).toBe("blob-1");
      expect(await blobs[0].blob.text()).toBe("test content");
    });

    it("deleteBlob removes the blob", async () => {
      await storage.putBlob("blob-1", new Blob(["data"]));
      await storage.deleteBlob("blob-1");

      expect(await storage.listBlobs()).toEqual([]);
    });

    it("multiple blobs are stored independently", async () => {
      await storage.putBlob("a", new Blob(["aaa"]));
      await storage.putBlob("b", new Blob(["bbb"]));

      const blobs = await storage.listBlobs();
      expect(blobs).toHaveLength(2);
    });
  });

  // -- clear --------------------------------------------------------------

  describe("clear", () => {
    it("wipes all documents, meta, and blobs", async () => {
      await storage.commit(batch([batchPut(doc("1", "tasks"), "tasks")]));
      await storage.putBlob("blob-1", new Blob(["data"]));

      await storage.clear();

      expect(await storage.listAll()).toEqual([]);
      expect(await storage.meta()).toBeNull();
      expect(await storage.listBlobs()).toEqual([]);
    });
  });
});
