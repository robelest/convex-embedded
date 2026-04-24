/**
 * SQLite-backed persistence adapter.
 *
 * Usage: `const adapter = await SqliteAdapter.open(driver)`. The driver is a
 * platform-specific SQLite binding (Node / browser WASM / Expo).
 *
 * Full pushdown: queries, sources, vector search, atomic commits.
 *
 * @public
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
} from "@/persistence/adapter";
import type { StoredDocument, Source } from "@/runtime/db/types";
import type { SqlPersistenceAdapter } from "@/storage/adapter";

import type { SqliteDriver } from "./driver";
import { createSqlitePersistenceAdapter } from "./factory";

export class SqliteAdapter extends PersistenceAdapter {
  readonly supportsAtomicCommit = true;
  readonly supportsPushdownReads = true;

  private constructor(private readonly impl: SqlPersistenceAdapter) {
    super();
  }

  /** Async factory — SQLite schema initialization is async. */
  static async open(driver: SqliteDriver): Promise<SqliteAdapter> {
    const impl = await createSqlitePersistenceAdapter({ driver });
    return new SqliteAdapter(impl);
  }

  async listAll(): Promise<StoredDocumentWithTable[]> {
    return this.impl.getDocuments();
  }

  async list(tableName: string): Promise<StoredDocument[]> {
    return this.impl.getDocumentsByTable(tableName);
  }

  async meta(): Promise<DatabaseMeta | null> {
    return this.impl.getMeta();
  }

  async commit(batch: CommitBatch): Promise<void> {
    return this.impl.commit(batch);
  }

  async clear(): Promise<void> {
    return this.impl.clear();
  }

  async listBlobs(): Promise<Array<{ id: string; blob: Blob }>> {
    return this.impl.getBlobs();
  }

  async putBlob(id: string, blob: Blob): Promise<void> {
    return this.impl.storeBlob(id, blob);
  }

  async deleteBlob(id: string): Promise<void> {
    return this.impl.deleteBlob(id);
  }

  async get(tableName: string, id: string): Promise<StoredDocument | null> {
    return this.impl.getDocument(tableName, id);
  }

  async count(tableName: string): Promise<number> {
    return this.impl.countDocuments(tableName);
  }

  async getBlob(id: string): Promise<Blob | null> {
    return this.impl.getBlob(id);
  }

  async listMany(tableNames: string[]): Promise<StoredDocumentWithTable[]> {
    return this.impl.getDocumentsByTables(tableNames);
  }

  async query(args: QueryRead): Promise<StoredDocument[] | null> {
    return this.impl.readQuery(args);
  }

  async source(
    source: Source,
    options?: ReadOptions,
  ): Promise<StoredDocument[] | null> {
    return this.impl.readSource(source, options);
  }

  async vectorSearch(args: VectorRead): Promise<StoredDocument[] | null> {
    return this.impl.readVectorCandidates(args);
  }

  async atomicCommit(
    batch: CommitBatch,
    options: AtomicCommitOptions,
  ): Promise<AtomicCommitResult | null> {
    return this.impl.applyCommit(batch, options);
  }

  async hasAnyDocuments(tableName: string): Promise<boolean | null> {
    return this.impl.hasAnyDocuments(tableName);
  }

  isAuthoritative(_tableName: string): boolean {
    // The runtime materializes every table in memory on hydration — `ctx.db`'s
    // read API is synchronous and has to serve rows without a round-trip to
    // the adapter. SQLite still backs durable writes via `atomicCommit` and
    // serves the initial hydrate + pushdown async queries, but for the
    // in-memory representation we never claim authority.
    return false;
  }

  async close(): Promise<void> {
    await this.impl.close();
  }
}
