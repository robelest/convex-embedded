import type { DocumentId, StoredDocument } from "@embedded/runtime/db/types";
import type {
  DocumentDelete,
  DocumentWithTable,
  StorageMetadata,
  WriteBatch,
} from "@embedded/storage/adapter";
import { describe, expect, it } from "@tests/testkit";

function doc(id: string, fields: Record<string, unknown> = {}): StoredDocument {
  return {
    _id: id as DocumentId,
    _creationTime: Date.now(),
    ...fields,
  };
}

function batchPut(
  document: StoredDocument,
  tableName: string,
): DocumentWithTable {
  return { doc: document, tableName };
}

function batch(
  puts: DocumentWithTable[] = [],
  deletes: Array<string | DocumentDelete> = [],
  meta: StorageMetadata = { timestamp: 1, lastCreationTime: 1000 },
): WriteBatch {
  return {
    puts,
    deletes: deletes.map((entry) =>
      typeof entry === "string" ? { id: entry, tableName: "tasks" } : entry,
    ),
    meta,
  };
}

describe("ephemeralStorage", () => {
  describe("empty state", () => {
    it("getDocuments returns an empty array", async ({ storage }) => {
      expect(await storage.getDocuments()).toEqual([]);
    });

    it("getMeta returns null", async ({ storage }) => {
      expect(await storage.getMetadata()).toBeNull();
    });

    it("getBlobs returns an empty array", async ({ storage }) => {
      expect(await storage.listBlobs()).toEqual([]);
    });
  });

  describe("commit", () => {
    it("persists put documents", async ({ storage }) => {
      const d = doc("1", { text: "hello" });
      await storage.write(batch([batchPut(d, "tasks")]));

      const docs = (await storage.getDocuments()) as DocumentWithTable[];
      expect(docs).toEqual([{ doc: d, tableName: "tasks" }]);
    });

    it("persists meta", async ({ storage }) => {
      const meta: StorageMetadata = { timestamp: 5, lastCreationTime: 9999 };
      await storage.write(batch([], [], meta));

      expect(await storage.getMetadata()).toEqual(meta);
    });

    it("deletes documents by ID", async ({ storage }) => {
      const d1 = doc("1", { text: "a" });
      const d2 = doc("2", { text: "b" });
      await storage.write(
        batch([batchPut(d1, "tasks"), batchPut(d2, "tasks")]),
      );

      await storage.write(batch([], [d1._id]));

      const docs = (await storage.getDocuments()) as DocumentWithTable[];
      expect(docs).toHaveLength(1);
      expect(docs[0]?.doc._id).toBe(d2._id);
    });

    it("handles puts and deletes in the same batch", async ({ storage }) => {
      const d1 = doc("1");
      const d2 = doc("2");
      await storage.write(
        batch([batchPut(d1, "tasks"), batchPut(d2, "tasks")]),
      );

      const d3 = doc("3");
      await storage.write(batch([batchPut(d3, "tasks")], [d1._id]));

      const docs = (await storage.getDocuments()) as DocumentWithTable[];
      const ids = docs.map((entry) => entry.doc._id);
      expect(ids).toEqual(expect.arrayContaining([d2._id, d3._id]));
      expect(ids).not.toContain(d1._id);
    });

    it("replaces a document with the same ID on put", async ({ storage }) => {
      const d = doc("1", { text: "v1" });
      await storage.write(batch([batchPut(d, "tasks")]));

      await storage.write(batch([batchPut({ ...d, text: "v2" }, "tasks")]));

      const docs = (await storage.getDocuments()) as DocumentWithTable[];
      expect(docs).toHaveLength(1);
      expect(docs[0]?.doc.text).toBe("v2");
    });

    it("gets a document by table and ID without scanning", async ({
      storage,
    }) => {
      const d = doc("1", { text: "hello" });
      await storage.write(batch([batchPut(d, "tasks")]));

      await expect(storage.getDocument("tasks", "1")).resolves.toEqual(d);
    });

    it("returns null when getting a document from the wrong table", async ({
      storage,
    }) => {
      const d = doc("1", { text: "hello" });
      await storage.write(batch([batchPut(d, "tasks")]));

      await expect(storage.getDocument("users", "1")).resolves.toBeNull();
    });

    it("overwrites meta on each commit", async ({ storage }) => {
      await storage.write(
        batch([], [], { timestamp: 1, lastCreationTime: 100 }),
      );
      await storage.write(
        batch([], [], { timestamp: 2, lastCreationTime: 200 }),
      );

      expect(await storage.getMetadata()).toEqual({
        timestamp: 2,
        lastCreationTime: 200,
      });
    });
  });

  describe("blob storage", () => {
    it("round-trips a stored blob", async ({ storage }) => {
      const blob = new Blob(["test content"], { type: "text/plain" });
      await storage.putBlob("blob-1", blob);

      const blobs = await storage.listBlobs();
      expect(blobs).toHaveLength(1);
      expect(blobs[0]?.id).toBe("blob-1");
      expect(await blobs[0]?.blob.text()).toBe("test content");
    });

    it("deletes a blob", async ({ storage }) => {
      await storage.putBlob("blob-1", new Blob(["data"]));
      await storage.deleteBlob("blob-1");

      expect(await storage.listBlobs()).toEqual([]);
    });

    it("stores multiple blobs independently", async ({ storage }) => {
      await storage.putBlob("a", new Blob(["aaa"]));
      await storage.putBlob("b", new Blob(["bbb"]));

      const blobs = await storage.listBlobs();
      expect(blobs.map((entry) => entry.id)).toEqual(
        expect.arrayContaining(["a", "b"]),
      );
    });
  });

  describe("clear", () => {
    it("wipes all documents, meta, and blobs", async ({ storage }) => {
      await storage.write(batch([batchPut(doc("1"), "tasks")]));
      await storage.putBlob("blob-1", new Blob(["data"]));

      await storage.clearAll();

      expect(await storage.getDocuments()).toEqual([]);
      expect(await storage.getMetadata()).toBeNull();
      expect(await storage.listBlobs()).toEqual([]);
    });
  });
});
