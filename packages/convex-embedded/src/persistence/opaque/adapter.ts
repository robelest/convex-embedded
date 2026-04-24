/**
 * Opaque persistence adapter — blob-per-document in-process storage.
 *
 * In-memory. No indexes, no pushdown. The runtime filters in-memory on top
 * of `list` / `listAll`.
 *
 * Usage: `new OpaqueAdapter()`. No options.
 *
 * @public
 */

import {
  PersistenceAdapter,
  type CommitBatch,
  type DatabaseMeta,
  type StoredDocumentWithTable,
} from "@/persistence/adapter";
import type { StoredDocument } from "@/runtime/db/types";

export class OpaqueAdapter extends PersistenceAdapter {
  private readonly documents = new Map<string, StoredDocument>();
  private readonly tableByDocId = new Map<string, string>();
  private readonly blobs = new Map<string, Blob>();
  private meta_: DatabaseMeta | null = null;

  async listAll(): Promise<StoredDocumentWithTable[]> {
    return Array.from(this.documents.entries()).map(([id, doc]) => {
      const tableName = this.tableByDocId.get(id);
      if (!tableName) {
        throw new Error(
          `[convex-embedded] OpaqueAdapter invariant violated: missing table mapping for document ${id}.`,
        );
      }
      return { doc, tableName };
    });
  }

  async list(tableName: string): Promise<StoredDocument[]> {
    const docs: StoredDocument[] = [];
    for (const doc of this.documents.values()) {
      const id = doc._id as string;
      if (this.tableByDocId.get(id) === tableName) {
        docs.push(doc);
      }
    }
    return docs;
  }

  async get(tableName: string, id: string): Promise<StoredDocument | null> {
    if (this.tableByDocId.get(id) !== tableName) {
      return null;
    }
    return this.documents.get(id) ?? null;
  }

  async meta(): Promise<DatabaseMeta | null> {
    return this.meta_;
  }

  async commit(batch: CommitBatch): Promise<void> {
    for (const { doc, tableName } of batch.puts) {
      const id = doc._id as string;
      this.documents.set(id, doc);
      this.tableByDocId.set(id, tableName);
    }
    for (const { id } of batch.deletes) {
      this.documents.delete(id);
      this.tableByDocId.delete(id);
    }
    this.meta_ = batch.meta;
  }

  async clear(): Promise<void> {
    this.documents.clear();
    this.tableByDocId.clear();
    this.blobs.clear();
    this.meta_ = null;
  }

  async listBlobs(): Promise<Array<{ id: string; blob: Blob }>> {
    return Array.from(this.blobs.entries()).map(([id, blob]) => ({ id, blob }));
  }

  async putBlob(id: string, blob: Blob): Promise<void> {
    this.blobs.set(id, blob);
  }

  async deleteBlob(id: string): Promise<void> {
    this.blobs.delete(id);
  }
}
