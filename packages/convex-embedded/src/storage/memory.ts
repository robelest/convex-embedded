/**
 * In-memory {@link StorageAdapter} implementation.
 *
 * Useful for testing and as the default when no durable storage is
 * configured. Data lives only for the lifetime of the runtime.
 */

import type { StoredDocument } from "@/core/types";
import type {
  CommitBatch,
  DatabaseMeta,
  StorageAdapter,
  StoredDocumentWithTable,
} from "@/storage/adapter";

// ---------------------------------------------------------------------------
// memoryStorage
// ---------------------------------------------------------------------------

/**
 * Create an in-memory {@link StorageAdapter}.
 *
 * All data is held in plain Maps and lost on page reload. This is the
 * default storage backend when no adapter is provided.
 */
export function memoryStorage(): StorageAdapter {
  const documents = new Map<string, StoredDocument>();
  const tableMap = new Map<string, string>(); // id → tableName
  const blobs = new Map<string, Blob>();
  let meta: DatabaseMeta | null = null;

  return {
    async getDocuments(): Promise<StoredDocumentWithTable[]> {
      return Array.from(documents.entries()).map(([id, doc]) => ({
        doc,
        tableName: tableMap.get(id) ?? "",
      }));
    },

    async getDocumentsByTable(tableName: string): Promise<StoredDocument[]> {
      return Array.from(documents.values()).filter(
        (doc) => tableMap.get(doc._id as string) === tableName,
      );
    },

    async getMeta(): Promise<DatabaseMeta | null> {
      return meta;
    },

    async getBlobs(): Promise<Array<{ id: string; blob: Blob }>> {
      return Array.from(blobs.entries()).map(([id, blob]) => ({ id, blob }));
    },

    async commit(batch: CommitBatch): Promise<void> {
      for (const { doc, tableName } of batch.puts) {
        documents.set(doc._id as string, doc);
        tableMap.set(doc._id as string, tableName);
      }
      for (const id of batch.deletes) {
        documents.delete(id);
        tableMap.delete(id);
      }
      meta = batch.meta;
    },

    async storeBlob(id: string, blob: Blob): Promise<void> {
      blobs.set(id, blob);
    },

    async deleteBlob(id: string): Promise<void> {
      blobs.delete(id);
    },

    async clear(): Promise<void> {
      documents.clear();
      tableMap.clear();
      blobs.clear();
      meta = null;
    },
  };
}
