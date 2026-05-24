/**
 * Runtime store — single facade over a {@link StorageAdapter}.
 *
 * When the adapter is a {@link QueryableAdapter}, reads for user tables
 * are served directly from the adapter (SQL). System tables (prefixed `_`)
 * always fall back to in-memory so sync reads work.
 *
 * @internal
 */

import type { AsyncReadBackend } from "@/runtime/db/backend";
import type { Source, StoredDocument } from "@/runtime/db/types";
import type { StorageAdapter } from "@/storage/adapter";
import { isQueryable } from "@/storage/adapter";
import type {
  CommitBatch,
  DatabaseMeta,
  QueryArgs,
  ReadOptions,
  VectorSearchArgs,
  SqlWriteOptions,
  SqlWriteResult,
  StoredDocumentWithTable,
} from "@/storage/adapter";

export interface Store {
  setStorage(storage: StorageAdapter | null): void;
  setReadBackendForTests(readBackend: AsyncReadBackend | null): void;
  isQueryable(): boolean;
  load(input?: { tables?: string[] }): Promise<{
    documents: StoredDocumentWithTable[];
    meta: DatabaseMeta | null;
  }>;
  refreshTable(input: { tableName: string }): Promise<{
    docs: StoredDocument[] | null;
    meta: DatabaseMeta | null;
  }>;
  usesExternalCommitPath(): boolean;
  write(
    batch: CommitBatch,
    options: SqlWriteOptions,
  ): Promise<SqlWriteResult | null>;
  countDocuments(
    tableName: string,
    options?: ReadOptions,
  ): Promise<number | null>;
  getDocument(
    tableName: string,
    id: string,
    options?: ReadOptions,
  ): Promise<StoredDocument | null>;
  getDocuments(
    tableName: string,
    options?: ReadOptions,
  ): Promise<StoredDocument[] | null>;
  source(
    source: Source,
    options?: ReadOptions,
  ): Promise<StoredDocument[] | null>;
  query(args: QueryArgs): Promise<StoredDocument[] | null>;
  vectorSearch(args: VectorSearchArgs): Promise<StoredDocument[] | null>;
}

interface DocumentAdapter {
  getDocuments(
    table?: string,
    opts?: ReadOptions,
  ): Promise<StoredDocumentWithTable[] | StoredDocument[]>;
  getDocument(
    table: string,
    id: string,
    opts?: ReadOptions,
  ): Promise<StoredDocument | null>;
  countDocuments(table: string, opts?: ReadOptions): Promise<number>;
  getMetadata(): Promise<DatabaseMeta | null>;
  write(
    batch: CommitBatch,
    opts?: SqlWriteOptions,
  ): Promise<SqlWriteResult | void>;
  hasDocuments?(table: string): Promise<boolean | null>;
}

function hasDocumentMethods(
  adapter: StorageAdapter,
): adapter is StorageAdapter & DocumentAdapter {
  return (
    typeof (adapter as { getDocuments?: unknown }).getDocuments === "function"
  );
}

function isSystemTable(tableName: string): boolean {
  return tableName.startsWith("_");
}

class UnifiedStore implements Store {
  private adapter: StorageAdapter | null = null;
  private readOverlay: AsyncReadBackend | null = null;
  private _queryable = false;

  setStorage(storage: StorageAdapter | null): void {
    this.adapter = storage;
    this._queryable = storage != null && isQueryable(storage);
  }

  setReadBackendForTests(readBackend: AsyncReadBackend | null): void {
    this.readOverlay = readBackend;
  }

  isQueryable(): boolean {
    return this._queryable;
  }

  async load(input?: { tables?: string[] }): Promise<{
    documents: StoredDocumentWithTable[];
    meta: DatabaseMeta | null;
  }> {
    if (!this.adapter || !hasDocumentMethods(this.adapter)) {
      return { documents: [], meta: null };
    }
    const da = this.adapter;
    const tables = input?.tables;
    let documents: StoredDocumentWithTable[];
    if (tables === undefined) {
      documents = (await da.getDocuments()) as StoredDocumentWithTable[];
    } else if (tables.length === 0) {
      documents = [];
    } else {
      const results: StoredDocumentWithTable[] = [];
      for (const tableName of tables) {
        const docs = (await da.getDocuments(tableName)) as StoredDocument[];
        for (const doc of docs) {
          results.push({ doc, tableName });
        }
      }
      documents = results;
    }
    return { documents, meta: await da.getMetadata() };
  }

  async refreshTable(input: { tableName: string }): Promise<{
    docs: StoredDocument[] | null;
    meta: DatabaseMeta | null;
  }> {
    if (!this.adapter || !hasDocumentMethods(this.adapter)) {
      return { docs: null, meta: null };
    }
    const da = this.adapter;
    if (this._queryable && !isSystemTable(input.tableName)) {
      return { docs: null, meta: await da.getMetadata() };
    }
    return {
      docs: (await da.getDocuments(input.tableName)) as StoredDocument[],
      meta: await da.getMetadata(),
    };
  }

  usesExternalCommitPath(): boolean {
    return this._queryable;
  }

  async write(
    batch: CommitBatch,
    options: SqlWriteOptions,
  ): Promise<SqlWriteResult | null> {
    if (!this.adapter || !hasDocumentMethods(this.adapter)) return null;
    const result = await this.adapter.write(batch, options);
    if (!result) return null;
    return result as SqlWriteResult;
  }

  async countDocuments(
    tableName: string,
    options?: ReadOptions,
  ): Promise<number | null> {
    if (this.readOverlay?.countDocuments) {
      return this.readOverlay.countDocuments(tableName);
    }
    if (!this.adapter || !this._queryable || isSystemTable(tableName))
      return null;
    if (!hasDocumentMethods(this.adapter)) return null;
    return this.adapter.countDocuments(tableName, options);
  }

  async getDocument(
    tableName: string,
    id: string,
    options?: ReadOptions,
  ): Promise<StoredDocument | null> {
    if (this.readOverlay?.getDocument) {
      return this.readOverlay.getDocument(tableName, id as never);
    }
    if (!this.adapter || !this._queryable || isSystemTable(tableName))
      return null;
    if (!hasDocumentMethods(this.adapter)) return null;
    return this.adapter.getDocument(tableName, id, options);
  }

  async getDocuments(
    tableName: string,
    options?: ReadOptions,
  ): Promise<StoredDocument[] | null> {
    if (this.readOverlay?.getDocuments) {
      return this.readOverlay.getDocuments(tableName);
    }
    if (!this.adapter || !this._queryable || isSystemTable(tableName))
      return null;
    if (!hasDocumentMethods(this.adapter)) return null;
    return (await this.adapter.getDocuments(
      tableName,
      options,
    )) as StoredDocument[];
  }

  async source(
    source: Source,
    options?: ReadOptions,
  ): Promise<StoredDocument[] | null> {
    if (this.readOverlay?.source) {
      const overlayResult = await this.readOverlay.source(source, options);
      if (overlayResult !== null && overlayResult !== undefined) {
        return overlayResult;
      }
    }
    if (!this.adapter || !isQueryable(this.adapter)) {
      return null;
    }
    return this.adapter.source(source, options);
  }

  async query(args: QueryArgs): Promise<StoredDocument[] | null> {
    if (this.readOverlay?.query) {
      const overlayResult = await this.readOverlay.query(args);
      if (overlayResult !== null && overlayResult !== undefined) {
        return overlayResult;
      }
    }
    if (!this.adapter || !isQueryable(this.adapter)) {
      return null;
    }
    return this.adapter.query(args);
  }

  async vectorSearch(args: VectorSearchArgs): Promise<StoredDocument[] | null> {
    if (this.readOverlay?.vectorSearch) {
      const overlayResult = await this.readOverlay.vectorSearch(args);
      if (overlayResult !== null && overlayResult !== undefined) {
        return overlayResult;
      }
    }
    if (!this.adapter || !isQueryable(this.adapter)) {
      return null;
    }
    return this.adapter.vectorSearch(args);
  }
}

export function createStore(): Store {
  return new UnifiedStore();
}
