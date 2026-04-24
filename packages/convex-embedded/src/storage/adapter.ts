/**
 * @internal Shared value types + the legacy `SqlPersistenceAdapter` object
 * shape used internally by the SQL factory and worker.
 *
 * The public API for persistence is the class hierarchy in `@/persistence`
 * ({@link PersistenceAdapter} base class, {@link SqliteAdapter}, {@link
 * OpaqueAdapter}). This module exists only because the SQL factory +
 * browser-worker still exchange objects via the `SqlPersistenceAdapter`
 * shape. New code should not import `SqlPersistenceAdapter` from here.
 *
 * @packageDocumentation
 */

import type { FilterNode } from "@/runtime/db/query";
import type {
  SearchIndexDefinition,
  VectorIndexDefinition,
} from "@/runtime/db/schema";
import type {
  Source,
  StoredDocument,
  VectorSearchExpression,
} from "@/runtime/db/types";

export interface DatabaseMeta {
  timestamp: number;
  lastCreationTime: number;
}

export interface StoredDocumentWithTable {
  doc: StoredDocument;
  tableName: string;
}

export interface StoredDocumentDelete {
  id: string;
  tableName: string;
}

export interface CommitBatch {
  puts: StoredDocumentWithTable[];
  deletes: StoredDocumentDelete[];
  meta: DatabaseMeta;
}

export interface SqlCommittedTableSnapshot {
  tableName: string;
  docs: StoredDocument[];
}

export interface SqlCommitApplyOptions {
  materializedTables: string[];
  tableSearchIndexes?: Record<string, SearchIndexDefinition[]>;
  tableVectorIndexes?: Record<string, VectorIndexDefinition[]>;
}

export interface SqlCommitApplyResult {
  meta: DatabaseMeta;
  tables: SqlCommittedTableSnapshot[];
}

export interface PersistenceReadOptions {
  limit?: number | null;
  indexFields?: string[];
  searchDefinition?: SearchIndexDefinition;
  activeIdentityKey?: string | null;
}

export interface PersistenceQueryRead {
  source: Source;
  filters: FilterNode[];
  limit: number | null;
  indexFields?: string[];
  searchDefinition?: SearchIndexDefinition;
  activeIdentityKey?: string | null;
}

export interface PersistenceVectorRead {
  tableName: string;
  indexName: string;
  definition: VectorIndexDefinition;
  filter: VectorSearchExpression | null;
  activeIdentityKey?: string | null;
}

/**
 * Internal object shape returned by `createSqlitePersistenceAdapter`. The
 * `SqliteAdapter` class wraps this; the browser SQLite worker exchanges
 * instances of this shape via RPC. Not exported from the public surface.
 *
 * @internal
 */
export interface SqlPersistenceAdapter {
  kind: "sql";
  getDocuments(): Promise<StoredDocumentWithTable[]>;
  getDocumentsByTable(tableName: string): Promise<StoredDocument[]>;
  getDocumentsByTables(
    tableNames: string[],
  ): Promise<StoredDocumentWithTable[]>;
  getMeta(): Promise<DatabaseMeta | null>;
  listDocuments(tableName: string): Promise<StoredDocument[]>;
  getDocument(tableName: string, id: string): Promise<StoredDocument | null>;
  countDocuments(tableName: string): Promise<number>;
  readSource(
    source: Source,
    options?: PersistenceReadOptions,
  ): Promise<StoredDocument[] | null>;
  readQuery(args: PersistenceQueryRead): Promise<StoredDocument[] | null>;
  readVectorCandidates(
    args: PersistenceVectorRead,
  ): Promise<StoredDocument[] | null>;
  hasAnyDocuments(tableName: string): Promise<boolean>;
  getBlobs(): Promise<Array<{ id: string; blob: Blob }>>;
  getBlob(id: string): Promise<Blob | null>;
  commit(batch: CommitBatch): Promise<void>;
  applyCommit(
    batch: CommitBatch,
    options: SqlCommitApplyOptions,
  ): Promise<SqlCommitApplyResult>;
  storeBlob(id: string, blob: Blob): Promise<void>;
  deleteBlob(id: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}
