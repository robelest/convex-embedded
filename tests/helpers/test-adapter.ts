/**
 * Test adapter — a `PersistenceAdapter` subclass whose methods can be
 * individually overridden via the constructor options.
 *
 * All methods are async (matches the class's async modal). Fields use the
 * class's method names (`list`, `commit`, `listBlobs`, …). No legacy shape.
 *
 * Used by tests that need to stub out specific methods on an adapter (e.g.
 * to simulate storage failure or a specific data fixture) without writing a
 * full subclass per test.
 */

import {
  PersistenceAdapter,
  type AtomicCommitOptions,
  type AtomicCommitResult,
  type CommitBatch,
  type DatabaseMeta,
  type QueryRead,
  type ReadOptions,
  type StoredDocumentWithTable,
  type VectorRead,
} from "@embedded/persistence/adapter";
import type { Source, StoredDocument } from "@embedded/runtime/db/types";

export interface TestAdapterOptions {
  supportsAtomicCommit?: boolean;
  supportsPushdownReads?: boolean;

  listAll?: () => Promise<StoredDocumentWithTable[]>;
  list?: (tableName: string) => Promise<StoredDocument[]>;
  get?: (tableName: string, id: string) => Promise<StoredDocument | null>;
  count?: (tableName: string) => Promise<number>;
  listMany?: (tableNames: string[]) => Promise<StoredDocumentWithTable[]>;
  meta?: () => Promise<DatabaseMeta | null>;
  commit?: (batch: CommitBatch) => Promise<void>;
  clear?: () => Promise<void>;
  listBlobs?: () => Promise<Array<{ id: string; blob: Blob }>>;
  getBlob?: (id: string) => Promise<Blob | null>;
  putBlob?: (id: string, blob: Blob) => Promise<void>;
  deleteBlob?: (id: string) => Promise<void>;

  query?: (args: QueryRead) => Promise<StoredDocument[] | null>;
  source?: (
    source: Source,
    options?: ReadOptions,
  ) => Promise<StoredDocument[] | null>;
  vectorSearch?: (args: VectorRead) => Promise<StoredDocument[] | null>;
  atomicCommit?: (
    batch: CommitBatch,
    options: AtomicCommitOptions,
  ) => Promise<AtomicCommitResult | null>;
  hasAnyDocuments?: (tableName: string) => Promise<boolean | null>;
  isAuthoritative?: (tableName: string) => boolean;
  close?: () => Promise<void>;
}

export class TestAdapter extends PersistenceAdapter {
  readonly supportsAtomicCommit: boolean;
  readonly supportsPushdownReads: boolean;

  constructor(private readonly opts: TestAdapterOptions = {}) {
    super();
    this.supportsAtomicCommit =
      opts.supportsAtomicCommit ?? typeof opts.atomicCommit === "function";
    this.supportsPushdownReads =
      opts.supportsPushdownReads ??
      (typeof opts.query === "function" ||
        typeof opts.source === "function" ||
        typeof opts.vectorSearch === "function");
  }

  async listAll(): Promise<StoredDocumentWithTable[]> {
    return (await this.opts.listAll?.()) ?? [];
  }

  async list(tableName: string): Promise<StoredDocument[]> {
    return (await this.opts.list?.(tableName)) ?? [];
  }

  async meta(): Promise<DatabaseMeta | null> {
    return (await this.opts.meta?.()) ?? null;
  }

  async commit(batch: CommitBatch): Promise<void> {
    await this.opts.commit?.(batch);
  }

  async clear(): Promise<void> {
    await this.opts.clear?.();
  }

  async listBlobs(): Promise<Array<{ id: string; blob: Blob }>> {
    return (await this.opts.listBlobs?.()) ?? [];
  }

  async putBlob(id: string, blob: Blob): Promise<void> {
    await this.opts.putBlob?.(id, blob);
  }

  async deleteBlob(id: string): Promise<void> {
    await this.opts.deleteBlob?.(id);
  }

  async get(tableName: string, id: string): Promise<StoredDocument | null> {
    if (this.opts.get) return this.opts.get(tableName, id);
    return super.get(tableName, id);
  }

  async count(tableName: string): Promise<number> {
    if (this.opts.count) return this.opts.count(tableName);
    return super.count(tableName);
  }

  async getBlob(id: string): Promise<Blob | null> {
    if (this.opts.getBlob) return this.opts.getBlob(id);
    return super.getBlob(id);
  }

  async listMany(tableNames: string[]): Promise<StoredDocumentWithTable[]> {
    if (this.opts.listMany) return this.opts.listMany(tableNames);
    return super.listMany(tableNames);
  }

  async query(args: QueryRead): Promise<StoredDocument[] | null> {
    return (await this.opts.query?.(args)) ?? null;
  }

  async source(
    src: Source,
    options?: ReadOptions,
  ): Promise<StoredDocument[] | null> {
    return (await this.opts.source?.(src, options)) ?? null;
  }

  async vectorSearch(args: VectorRead): Promise<StoredDocument[] | null> {
    return (await this.opts.vectorSearch?.(args)) ?? null;
  }

  async atomicCommit(
    batch: CommitBatch,
    options: AtomicCommitOptions,
  ): Promise<AtomicCommitResult | null> {
    return (await this.opts.atomicCommit?.(batch, options)) ?? null;
  }

  async hasAnyDocuments(tableName: string): Promise<boolean | null> {
    return (await this.opts.hasAnyDocuments?.(tableName)) ?? null;
  }

  isAuthoritative(tableName: string): boolean {
    if (this.opts.isAuthoritative) return this.opts.isAuthoritative(tableName);
    if (tableName.startsWith("_")) return false;
    return this.supportsPushdownReads || this.supportsAtomicCommit;
  }

  async close(): Promise<void> {
    await this.opts.close?.();
  }
}

/** Convenience factory: `mockAdapter({...})` ≡ `new TestAdapter({...})`. */
export function mockAdapter(opts: TestAdapterOptions = {}): TestAdapter {
  return new TestAdapter(opts);
}
