/**
 * Storage adapter interfaces.
 *
 * - {@link StorageAdapter} — blob storage (minimal base)
 * - {@link QueryableAdapter} — documents, queries, and blob storage
 *
 * @public
 */

import type { FilterNode } from "@/runtime/db/query";
import type {
  SearchIndexDefinition,
  VectorIndexDefinition,
} from "@/runtime/db/schema";
import type {
  SeekBound,
  Source,
  StoredDocument,
  VectorSearchExpression,
} from "@/runtime/db/types";
import type { InternalTableSpec } from "@/storage/sqlite/factory";

export interface StorageMetadata {
  timestamp: number;
  lastCreationTime: number;
}

export interface DocumentWithTable {
  doc: StoredDocument;
  tableName: string;
}

export interface DocumentDelete {
  id: string;
  tableName: string;
}

export interface WriteBatch {
  puts: DocumentWithTable[];
  deletes: DocumentDelete[];
  meta: StorageMetadata;
}

export interface TableSnapshot {
  tableName: string;
  docs: StoredDocument[];
}

export interface WriteOptions {
  materializedTables: string[];
  tableSearchIndexes?: Record<string, SearchIndexDefinition[]>;
  tableVectorIndexes?: Record<string, VectorIndexDefinition[]>;
}

export interface WriteResult {
  meta: StorageMetadata;
  tables: TableSnapshot[];
}

export type { SeekBound };

export interface ReadOptions {
  limit?: number | null;
  indexFields?: string[];
  searchDefinition?: SearchIndexDefinition;
  activeIdentityKey?: string | null;
  seek?: SeekBound;
}

export interface QueryArgs {
  source: Source;
  filters: FilterNode[];
  limit: number | null;
  indexFields?: string[];
  searchDefinition?: SearchIndexDefinition;
  activeIdentityKey?: string | null;
}

export interface VectorSearchArgs {
  tableName: string;
  indexName: string;
  definition: VectorIndexDefinition;
  filter: VectorSearchExpression | null;
  activeIdentityKey?: string | null;
}

export type SchemaOp =
  | {
      type: "addColumn";
      column: string;
      sqlType: "TEXT" | "REAL" | "INTEGER" | "BLOB";
      notNull?: boolean;
      defaultSql?: string;
    }
  | { type: "dropColumn"; column: string }
  | {
      type: "addIndex";
      name: string;
      fields: string[];
      unique?: boolean;
    }
  | { type: "dropIndex"; name: string };

/**
 * Blob storage — the minimal base adapter.
 *
 * Handles binary blob storage for file uploads and downloads.
 */
export interface StorageAdapter {
  getBlob(id: string): Promise<Blob | null>;
  storeBlob(id: string, blob: Blob): Promise<void>;
  deleteBlob(id: string): Promise<void>;
  clearAll(): Promise<void>;
  close?(): Promise<void>;
  setUserTableSpecs?(specs: Map<string, InternalTableSpec> | undefined): void;
}

/**
 * Full document + query + blob storage.
 *
 * Extends {@link StorageAdapter} with document storage, metadata,
 * native query execution, and atomic writes. This is what SQL-backed
 * adapters implement.
 *
 * Query methods return `null` to opt out for a given input — the
 * runtime falls back to in-memory evaluation.
 */
export interface QueryableAdapter extends StorageAdapter {
  getDocuments(
    table?: string,
    opts?: ReadOptions,
  ): Promise<DocumentWithTable[] | StoredDocument[]>;
  getDocument(
    table: string,
    id: string,
    opts?: ReadOptions,
  ): Promise<StoredDocument | null>;
  countDocuments(table: string, opts?: ReadOptions): Promise<number>;
  getMetadata(): Promise<StorageMetadata | null>;
  write(batch: WriteBatch, opts?: WriteOptions): Promise<WriteResult | void>;
  query(args: QueryArgs): Promise<StoredDocument[] | null>;
  source(source: Source, opts?: ReadOptions): Promise<StoredDocument[] | null>;
  vectorSearch(args: VectorSearchArgs): Promise<StoredDocument[] | null>;
  hasDocuments(table: string): Promise<boolean | null>;
  applySchemaOps?(table: string, ops: readonly SchemaOp[]): Promise<void>;
  reStampAnonymousIdentity?(identityKey: string): Promise<string[]>;
}

/**
 * Type guard for queryable adapters.
 */
export function isQueryable(
  adapter: StorageAdapter,
): adapter is QueryableAdapter {
  return typeof (adapter as QueryableAdapter).query === "function";
}

export type { StorageMetadata as DatabaseMeta };
export type { DocumentWithTable as StoredDocumentWithTable };
export type { WriteBatch as CommitBatch };

export interface SqlCommittedTableSnapshot {
  tableName: string;
  docs: StoredDocument[];
}

export interface SqlWriteOptions {
  materializedTables: string[];
  tableSearchIndexes?: Record<string, SearchIndexDefinition[]>;
  tableVectorIndexes?: Record<string, VectorIndexDefinition[]>;
}

export interface SqlWriteResult {
  meta: StorageMetadata;
  tables: SqlCommittedTableSnapshot[];
}

export interface SqlStorageAdapter {
  kind: "sql";
  getDocuments(): Promise<DocumentWithTable[]>;
  getDocumentsByTable(
    tableName: string,
    opts?: ReadOptions,
  ): Promise<StoredDocument[]>;
  getDocumentsByTables(tableNames: string[]): Promise<DocumentWithTable[]>;
  getMeta(): Promise<StorageMetadata | null>;
  listDocuments(
    tableName: string,
    opts?: ReadOptions,
  ): Promise<StoredDocument[]>;
  getDocument(
    tableName: string,
    id: string,
    opts?: ReadOptions,
  ): Promise<StoredDocument | null>;
  countDocuments(tableName: string, opts?: ReadOptions): Promise<number>;
  source(
    source: Source,
    options?: ReadOptions,
  ): Promise<StoredDocument[] | null>;
  query(args: QueryArgs): Promise<StoredDocument[] | null>;
  vectorSearch(args: VectorSearchArgs): Promise<StoredDocument[] | null>;
  hasAnyDocuments(tableName: string): Promise<boolean>;
  applySchemaOps(tableName: string, ops: readonly SchemaOp[]): Promise<void>;
  /**
   * Re-stamp every user-table row whose `identity_key` is NULL to `identityKey`
   * (the first-login anonymous → identity move). Returns the logical table names
   * that had rows updated.
   */
  reStampAnonymousIdentity(identityKey: string): Promise<string[]>;
  getBlobs(): Promise<Array<{ id: string; blob: Blob }>>;
  getBlob(id: string): Promise<Blob | null>;
  commit(batch: WriteBatch): Promise<void>;
  applyCommit(
    batch: WriteBatch,
    options: SqlWriteOptions,
  ): Promise<SqlWriteResult>;
  storeBlob(id: string, blob: Blob): Promise<void>;
  deleteBlob(id: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}
