/**
 * SQLite-backed storage adapter with full native query support.
 *
 * Usage: `new SqliteAdapter(driver)`.
 *
 * @public
 */

import type { StoredDocument, Source } from "@/runtime/db/types";
import type {
  WriteOptions,
  WriteResult,
  DocumentWithTable,
  QueryableAdapter,
  QueryArgs,
  ReadOptions,
  SchemaOp,
  SqlStorageAdapter,
  StorageMetadata,
  VectorSearchArgs,
  WriteBatch,
} from "@/storage/adapter";

import { withSpan } from "@/tracing/spans";

import type { SqliteDriver } from "./driver";
import { createSqliteStorage, type InternalTableSpec } from "./factory";

export interface SqliteAdapterOptions {
  userTableSpecs?: Map<string, InternalTableSpec>;
}

export class SqliteAdapter implements QueryableAdapter {
  private readonly driver: SqliteDriver;
  private userTableSpecs: Map<string, InternalTableSpec> | undefined;
  private impl: SqlStorageAdapter | null = null;
  private initPromise: Promise<SqlStorageAdapter> | null = null;

  constructor(driver: SqliteDriver, options: SqliteAdapterOptions = {}) {
    this.driver = driver;
    this.userTableSpecs = options.userTableSpecs;
  }

  setUserTableSpecs(specs: Map<string, InternalTableSpec> | undefined): void {
    if (this.impl || this.initPromise) {
      throw new Error(
        "[convex-embedded] cannot setUserTableSpecs after the adapter has been initialized.",
      );
    }
    this.userTableSpecs = specs;
  }

  getDriver(): SqliteDriver {
    return this.driver;
  }

  private ready(): Promise<SqlStorageAdapter> {
    if (this.impl) return Promise.resolve(this.impl);
    this.initPromise ??= createSqliteStorage({
      driver: this.driver,
      userTableSpecs: this.userTableSpecs,
    }).then((impl) => {
      this.impl = impl;
      return impl;
    });
    return this.initPromise;
  }

  async getDocuments(
    table?: string,
    opts?: ReadOptions,
  ): Promise<DocumentWithTable[] | StoredDocument[]> {
    return withSpan("convex-embedded.storage.getDocuments", async (span) => {
      if (table !== undefined) {
        span.setAttribute("convex.table", table);
      }
      const impl = await this.ready();
      if (table === undefined) {
        return impl.getDocuments();
      }
      return impl.getDocumentsByTable(table, opts);
    });
  }

  async getDocument(
    table: string,
    id: string,
    opts?: ReadOptions,
  ): Promise<StoredDocument | null> {
    return withSpan("convex-embedded.storage.getDocument", async (span) => {
      span.setAttribute("convex.table", table);
      span.setAttribute("convex.id", id);
      const impl = await this.ready();
      return impl.getDocument(table, id, opts);
    });
  }

  async countDocuments(table: string, opts?: ReadOptions): Promise<number> {
    return withSpan("convex-embedded.storage.countDocuments", async (span) => {
      span.setAttribute("convex.table", table);
      const impl = await this.ready();
      return impl.countDocuments(table, opts);
    });
  }

  async getMetadata(): Promise<StorageMetadata | null> {
    const impl = await this.ready();
    return impl.getMeta();
  }

  async write(
    batch: WriteBatch,
    opts?: WriteOptions,
  ): Promise<WriteResult | void> {
    return withSpan("convex-embedded.storage.write", async () => {
      const impl = await this.ready();
      if (opts) {
        return impl.applyCommit(batch, opts);
      }
      return impl.commit(batch);
    });
  }

  async clearAll(): Promise<void> {
    const impl = await this.ready();
    return impl.clear();
  }

  async getBlob(id: string): Promise<Blob | null> {
    return withSpan("convex-embedded.storage.getBlob", async (span) => {
      span.setAttribute("convex.id", id);
      const impl = await this.ready();
      return impl.getBlob(id);
    });
  }

  async putBlob(id: string, blob: Blob): Promise<void> {
    return withSpan("convex-embedded.storage.putBlob", async (span) => {
      span.setAttribute("convex.id", id);
      const impl = await this.ready();
      return impl.storeBlob(id, blob);
    });
  }

  async deleteBlob(id: string): Promise<void> {
    return withSpan("convex-embedded.storage.deleteBlob", async (span) => {
      span.setAttribute("convex.id", id);
      const impl = await this.ready();
      return impl.deleteBlob(id);
    });
  }

  async query(args: QueryArgs): Promise<StoredDocument[] | null> {
    const impl = await this.ready();
    return impl.query(args);
  }

  async source(
    source: Source,
    opts?: ReadOptions,
  ): Promise<StoredDocument[] | null> {
    const impl = await this.ready();
    return impl.source(source, opts);
  }

  async vectorSearch(args: VectorSearchArgs): Promise<StoredDocument[] | null> {
    const impl = await this.ready();
    return impl.vectorSearch(args);
  }

  async hasDocuments(table: string): Promise<boolean | null> {
    const impl = await this.ready();
    return impl.hasAnyDocuments(table);
  }

  async applySchemaOps(table: string, ops: readonly SchemaOp[]): Promise<void> {
    const impl = await this.ready();
    return impl.applySchemaOps(table, ops);
  }

  async close(): Promise<void> {
    const impl = await this.ready();
    await impl.close();
  }
}
