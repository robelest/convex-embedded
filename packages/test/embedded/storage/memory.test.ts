import { describe, it, expect, beforeEach } from "vitest";

import type { StoredDocument } from "#embedded/core/types";
import type { StorageAdapter, CommitBatch } from "#embedded/storage/adapter";
import { ephemeralStorage } from "#embedded/storage/memory";

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
  deletes: string[] = [],
  meta = { timestamp: 1, lastCreationTime: 1000 },
): CommitBatch {
  return { puts, deletes, meta };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ephemeralStorage", () => {
  let storage: StorageAdapter;

  beforeEach(() => {
    storage = ephemeralStorage();
  });

  // -- Hydration (empty state) --------------------------------------------

  describe("empty state", () => {
    it("getDocuments returns empty array", async () => {
      expect(await storage.getDocuments()).toEqual([]);
    });

    it("getMeta returns null", async () => {
      expect(await storage.getMeta()).toBeNull();
    });

    it("getBlobs returns empty array", async () => {
      expect(await storage.getBlobs()).toEqual([]);
    });
  });

  // -- commit -------------------------------------------------------------

  describe("commit", () => {
    it("persists put documents", async () => {
      const d = doc("1", "tasks", { text: "hello" });
      await storage.commit(batch([batchPut(d, "tasks")]));

      const docs = await storage.getDocuments();
      expect(docs).toHaveLength(1);
      expect(docs[0]).toEqual({ doc: d, tableName: "tasks" });
    });

    it("persists meta", async () => {
      const meta = { timestamp: 5, lastCreationTime: 9999 };
      await storage.commit(batch([], [], meta));

      expect(await storage.getMeta()).toEqual(meta);
    });

    it("deletes documents by ID", async () => {
      const d1 = doc("1", "tasks", { text: "a" });
      const d2 = doc("2", "tasks", { text: "b" });
      await storage.commit(
        batch([batchPut(d1, "tasks"), batchPut(d2, "tasks")]),
      );

      await storage.commit(batch([], [d1._id as string]));

      const docs = await storage.getDocuments();
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

      const docs = await storage.getDocuments();
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

      const docs = await storage.getDocuments();
      expect(docs).toHaveLength(1);
      expect(docs[0].doc.text).toBe("v2");
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

      const meta = await storage.getMeta();
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
      await storage.storeBlob("blob-1", blob);

      const blobs = await storage.getBlobs();
      expect(blobs).toHaveLength(1);
      expect(blobs[0].id).toBe("blob-1");
      expect(await blobs[0].blob.text()).toBe("test content");
    });

    it("deleteBlob removes the blob", async () => {
      await storage.storeBlob("blob-1", new Blob(["data"]));
      await storage.deleteBlob("blob-1");

      expect(await storage.getBlobs()).toEqual([]);
    });

    it("multiple blobs are stored independently", async () => {
      await storage.storeBlob("a", new Blob(["aaa"]));
      await storage.storeBlob("b", new Blob(["bbb"]));

      const blobs = await storage.getBlobs();
      expect(blobs).toHaveLength(2);
    });
  });

  // -- clear --------------------------------------------------------------

  describe("clear", () => {
    it("wipes all documents, meta, and blobs", async () => {
      await storage.commit(batch([batchPut(doc("1", "tasks"), "tasks")]));
      await storage.storeBlob("blob-1", new Blob(["data"]));

      await storage.clear();

      expect(await storage.getDocuments()).toEqual([]);
      expect(await storage.getMeta()).toBeNull();
      expect(await storage.getBlobs()).toEqual([]);
    });
  });
});
