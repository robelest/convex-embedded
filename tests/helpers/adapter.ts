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
  storeBlob?: (id: string, blob: Blob) => Promise<void>;
  deleteBlob?: (id: string) => Promise<void>;
  close?: () => Promise<void>;
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
  protected _docs: Map<string, { doc: StoredDocument; tableName: string }> =
    new Map();
  readonly blobs: Map<string, Blob> = new Map();
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
      if (this.opts.getDocuments) return this.opts.getDocuments(table, opts);
      const result: StoredDocument[] = [];
      for (const entry of this._docs.values()) {
        if (entry.tableName === table) result.push(entry.doc);
      }
      return result;
    }
    if (this.opts.getDocuments) return this.opts.getDocuments(table, opts);
    return Array.from(this._docs.values());
  }

  async getDocument(
    table: string,
    id: string,
    opts?: ReadOptions,
  ): Promise<StoredDocument | null> {
    if (this.opts.getDocument) return this.opts.getDocument(table, id, opts);
    const entry = this._docs.get(id);
    if (entry && entry.tableName === table) return entry.doc;
    return null;
  }

  async countDocuments(table: string, opts?: ReadOptions): Promise<number> {
    if (this.opts.countDocuments) return this.opts.countDocuments(table, opts);
    let n = 0;
    for (const entry of this._docs.values()) {
      if (entry.tableName === table) n++;
    }
    return n;
  }

  async getMetadata(): Promise<StorageMetadata | null> {
    if (this.opts.getMetadata) return this.opts.getMetadata();
    return this._meta;
  }

  async write(
    batch: WriteBatch,
    opts?: WriteOptions,
  ): Promise<WriteResult | void> {
    if (this.opts.write) return this.opts.write(batch, opts);
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

  async clearAll(): Promise<void> {
    if (this.opts.clearAll) return this.opts.clearAll();
    this._docs.clear();
    this.blobs.clear();
    this._meta = null;
  }

  async getBlob(id: string): Promise<Blob | null> {
    if (this.opts.getBlob) return this.opts.getBlob(id);
    return this.blobs.get(id) ?? null;
  }

  async storeBlob(id: string, blob: Blob): Promise<void> {
    if (this.opts.storeBlob) return this.opts.storeBlob(id, blob);
    this.blobs.set(id, blob);
  }

  async deleteBlob(id: string): Promise<void> {
    if (this.opts.deleteBlob) return this.opts.deleteBlob(id);
    this.blobs.delete(id);
  }

  async close(): Promise<void> {
    await this.opts.close?.();
  }

}

class QueryableTestAdapter
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

  async hasDocuments(table: string): Promise<boolean | null> {
    if (this.opts.hasDocuments) return this.opts.hasDocuments(table);
    for (const entry of this._docs.values()) {
      if (entry.tableName === table) return true;
    }
    return false;
  }
}

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
