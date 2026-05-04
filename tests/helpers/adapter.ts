/**
 * Test adapters — document-capable and queryable stubs whose methods can be
 * individually overridden via the constructor options.
 *
 * {@link OpaqueTestAdapter} has document + blob storage but no query methods,
 * so `isQueryable()` returns `false`.
 *
 * {@link QueryableTestAdapter} adds `query`, `source`, and `vectorSearch` so
 * that `isQueryable()` returns `true`.
 *
 * Used by tests that need to stub out specific methods on an adapter (e.g.
 * to simulate storage failure or a specific data fixture) without writing a
 * full subclass per test.
 */

import type { Source, StoredDocument } from "@embedded/runtime/db/types";
import type {
  StorageAdapter,
  QueryableAdapter,
  WriteOptions,
  WriteResult,
  WriteBatch,
  StorageMetadata,
  DocumentWithTable,
  QueryArgs,
  ReadOptions,
  VectorSearchArgs,
} from "@embedded/storage/adapter";

export interface OpaqueTestAdapterOptions {
  getDocuments?: (
    table?: string,
    opts?: ReadOptions,
  ) => Promise<DocumentWithTable[] | StoredDocument[]>;
  getDocument?: (
    table: string,
    id: string,
    opts?: ReadOptions,
  ) => Promise<StoredDocument | null>;
  countDocuments?: (table: string, opts?: ReadOptions) => Promise<number>;
  getMetadata?: () => Promise<StorageMetadata | null>;
  write?: (
    batch: WriteBatch,
    opts?: WriteOptions,
  ) => Promise<WriteResult | void>;
  hasDocuments?: (table: string) => Promise<boolean | null>;
  clearAll?: () => Promise<void>;
  getBlob?: (id: string) => Promise<Blob | null>;
  putBlob?: (id: string, blob: Blob) => Promise<void>;
  deleteBlob?: (id: string) => Promise<void>;
  close?: () => Promise<void>;

  // Legacy option aliases (map to new names internally)
  listAll?: () => Promise<DocumentWithTable[]>;
  list?: (tableName: string) => Promise<StoredDocument[]>;
  get?: (tableName: string, id: string) => Promise<StoredDocument | null>;
  count?: (tableName: string) => Promise<number>;
  meta?: () => Promise<StorageMetadata | null>;
  commit?: (batch: WriteBatch) => Promise<void>;
  clear?: () => Promise<void>;
  listBlobs?: () => Promise<Array<{ id: string; blob: Blob }>>;
  atomicCommit?: (
    batch: WriteBatch,
    options: WriteOptions,
  ) => Promise<WriteResult | null>;
  listDocuments?: (tableName: string) => Promise<StoredDocument[]>;
  hasAnyDocuments?: (tableName: string) => Promise<boolean | null>;
  listMany?: (tableNames: string[]) => Promise<DocumentWithTable[]>;
}

export interface QueryableTestAdapterOptions extends OpaqueTestAdapterOptions {
  query?: (args: QueryArgs) => Promise<StoredDocument[] | null>;
  source?: (
    source: Source,
    opts?: ReadOptions,
  ) => Promise<StoredDocument[] | null>;
  vectorSearch?: (args: VectorSearchArgs) => Promise<StoredDocument[] | null>;
}

export type TestAdapterOptions = QueryableTestAdapterOptions & {
  kind?: "opaque" | "sql";
  supportsAtomicCommit?: boolean;
  supportsPushdownReads?: boolean;
  isAuthoritative?: (tableName: string) => boolean;
};

export class OpaqueTestAdapter implements StorageAdapter {
  private _docs: Map<string, { doc: StoredDocument; tableName: string }> =
    new Map();
  private _blobs: Map<string, Blob> = new Map();
  private _meta: StorageMetadata | null = null;
  protected readonly opts: OpaqueTestAdapterOptions;

  constructor(opts: OpaqueTestAdapterOptions = {}) {
    this.opts = opts;
  }

  async getDocuments(
    table?: string,
    opts?: ReadOptions,
  ): Promise<DocumentWithTable[] | StoredDocument[]> {
    if (table !== undefined) {
      if (this.opts.list) return this.opts.list(table);
      if (this.opts.listDocuments) return this.opts.listDocuments(table);
      if (this.opts.getDocuments) return this.opts.getDocuments(table, opts);
      const result: StoredDocument[] = [];
      for (const entry of this._docs.values()) {
        if (entry.tableName === table) result.push(entry.doc);
      }
      return result;
    }
    if (this.opts.listAll) return this.opts.listAll();
    if (this.opts.getDocuments) return this.opts.getDocuments(table, opts);
    return Array.from(this._docs.values());
  }

  async getDocument(
    table: string,
    id: string,
    opts?: ReadOptions,
  ): Promise<StoredDocument | null> {
    if (this.opts.getDocument) return this.opts.getDocument(table, id, opts);
    if (this.opts.get) return this.opts.get(table, id);
    const entry = this._docs.get(id);
    if (entry && entry.tableName === table) return entry.doc;
    return null;
  }

  async countDocuments(table: string, opts?: ReadOptions): Promise<number> {
    if (this.opts.countDocuments) return this.opts.countDocuments(table, opts);
    if (this.opts.count) return this.opts.count(table);
    let n = 0;
    for (const entry of this._docs.values()) {
      if (entry.tableName === table) n++;
    }
    return n;
  }

  async getMetadata(): Promise<StorageMetadata | null> {
    if (this.opts.getMetadata) return this.opts.getMetadata();
    if (this.opts.meta) return this.opts.meta();
    return this._meta;
  }

  async write(
    batch: WriteBatch,
    opts?: WriteOptions,
  ): Promise<WriteResult | void> {
    if (this.opts.write) return this.opts.write(batch, opts);
    if (opts && this.opts.atomicCommit) {
      return (await this.opts.atomicCommit(batch, opts)) ?? undefined;
    }
    if (this.opts.commit) {
      await this.opts.commit(batch);
      this._meta = batch.meta;
      if (opts) {
        const tables = await Promise.all(
          (opts.materializedTables ?? []).map(async (tableName) => ({
            tableName,
            docs: (await this.getDocuments(tableName)) as StoredDocument[],
          })),
        );
        return { meta: batch.meta, tables };
      }
      return;
    }
    for (const del of batch.deletes) {
      this._docs.delete(del.id);
    }
    for (const put of batch.puts) {
      this._docs.set(put.doc._id as string, {
        doc: put.doc,
        tableName: put.tableName,
      });
    }
    this._meta = batch.meta;
    if (opts) {
      const tables = await Promise.all(
        (opts.materializedTables ?? []).map(async (tableName) => ({
          tableName,
          docs: (await this.getDocuments(tableName)) as StoredDocument[],
        })),
      );
      return { meta: batch.meta, tables };
    }
  }

  async hasDocuments(table: string): Promise<boolean | null> {
    if (this.opts.hasDocuments) return this.opts.hasDocuments(table);
    if (this.opts.hasAnyDocuments) return this.opts.hasAnyDocuments(table);
    if (this.opts.list) {
      const docs = await this.opts.list(table);
      return docs.length > 0;
    }
    if (this.opts.listDocuments) {
      const docs = await this.opts.listDocuments(table);
      return docs.length > 0;
    }
    if (this.opts.listAll) {
      const all = await this.opts.listAll();
      return all.some((entry) => entry.tableName === table);
    }
    for (const entry of this._docs.values()) {
      if (entry.tableName === table) return true;
    }
    return false;
  }

  async clearAll(): Promise<void> {
    if (this.opts.clearAll) return this.opts.clearAll();
    if (this.opts.clear) return this.opts.clear();
    this._docs.clear();
    this._blobs.clear();
    this._meta = null;
  }

  async getBlob(id: string): Promise<Blob | null> {
    if (this.opts.getBlob) return this.opts.getBlob(id);
    return this._blobs.get(id) ?? null;
  }

  async putBlob(id: string, blob: Blob): Promise<void> {
    if (this.opts.putBlob) return this.opts.putBlob(id, blob);
    this._blobs.set(id, blob);
  }

  async deleteBlob(id: string): Promise<void> {
    if (this.opts.deleteBlob) return this.opts.deleteBlob(id);
    this._blobs.delete(id);
  }

  async close(): Promise<void> {
    await this.opts.close?.();
  }

  // Legacy helpers used by existing tests
  async listAll(): Promise<DocumentWithTable[]> {
    if (this.opts.listAll) return this.opts.listAll();
    return Array.from(this._docs.values());
  }

  async list(tableName: string): Promise<StoredDocument[]> {
    const docs = await this.getDocuments(tableName);
    return docs as StoredDocument[];
  }

  async get(tableName: string, id: string): Promise<StoredDocument | null> {
    return this.getDocument(tableName, id);
  }

  async meta(): Promise<StorageMetadata | null> {
    return this.getMetadata();
  }

  async commit(batch: WriteBatch): Promise<void> {
    await this.write(batch);
  }

  async clear(): Promise<void> {
    await this.clearAll();
  }

  async listBlobs(): Promise<Array<{ id: string; blob: Blob }>> {
    if (this.opts.listBlobs) return this.opts.listBlobs();
    return Array.from(this._blobs.entries()).map(([id, blob]) => ({
      id,
      blob,
    }));
  }
}

export class QueryableTestAdapter
  extends OpaqueTestAdapter
  implements QueryableAdapter
{
  private readonly qOpts: QueryableTestAdapterOptions;

  constructor(opts: QueryableTestAdapterOptions = {}) {
    super(opts);
    this.qOpts = opts;
  }

  async query(args: QueryArgs): Promise<StoredDocument[] | null> {
    return (await this.qOpts.query?.(args)) ?? null;
  }

  async source(
    src: Source,
    opts?: ReadOptions,
  ): Promise<StoredDocument[] | null> {
    return (await this.qOpts.source?.(src, opts)) ?? null;
  }

  async vectorSearch(args: VectorSearchArgs): Promise<StoredDocument[] | null> {
    return (await this.qOpts.vectorSearch?.(args)) ?? null;
  }
}

// Legacy alias — kept so existing test imports keep working.
export { OpaqueTestAdapter as TestAdapter };

/**
 * Convenience factory used by most tests.
 *
 * When `kind` is `"sql"` or query/source/vectorSearch callbacks are provided,
 * returns a {@link QueryableTestAdapter}; otherwise an
 * {@link OpaqueTestAdapter}.
 */
export function mockAdapter(opts: TestAdapterOptions = {}): OpaqueTestAdapter {
  const isQueryableShape =
    opts.kind === "sql" ||
    typeof opts.query === "function" ||
    typeof opts.source === "function" ||
    typeof opts.vectorSearch === "function";

  if (isQueryableShape) {
    return new QueryableTestAdapter(opts);
  }
  return new OpaqueTestAdapter(opts);
}
