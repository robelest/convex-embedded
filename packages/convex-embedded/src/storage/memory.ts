/**
 * In-memory {@link StorageAdapter} implementation.
 *
 * Useful for testing and as the default when no durable storage is
 * configured. Data lives only for the lifetime of the runtime.
 */

import type { StoredDocument } from "@/core/types";
import type { CommitBatch, DatabaseMeta, StorageAdapter } from "@/storage/adapter";

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
  const blobs = new Map<string, Blob>();
  let meta: DatabaseMeta | null = null;

  return {
    async getDocuments(): Promise<StoredDocument[]> {
      return Array.from(documents.values());
    },

    async getMeta(): Promise<DatabaseMeta | null> {
      return meta;
    },

    async getBlobs(): Promise<Array<{ id: string; blob: Blob }>> {
      return Array.from(blobs.entries()).map(([id, blob]) => ({ id, blob }));
    },

    async commit(batch: CommitBatch): Promise<void> {
      for (const doc of batch.puts) {
        documents.set(doc._id as string, doc);
      }
      for (const id of batch.deletes) {
        documents.delete(id);
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
      blobs.clear();
      meta = null;
    },
  };
}
