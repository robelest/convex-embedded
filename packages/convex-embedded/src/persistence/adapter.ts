/**
 * Abstract persistence adapter — the contract every local backend implements.
 *
 * The runtime holds exactly one {@link PersistenceAdapter} at a time. It does
 * not branch on adapter type; it calls optional capability methods and falls
 * back to the required methods when a capability returns `null`.
 *
 * Required methods are abstract (every adapter must implement them).
 *
 * Convenience methods (`get`, `count`, `getBlob`, `listMany`) have concrete
 * defaults on the base class implemented in terms of the required methods.
 * Adapters can override them for efficiency.
 *
 * Capability methods (`query`, `source`, `vectorSearch`, `atomicCommit`,
 * `hasAnyDocuments`) default to returning `null` / `false`. An adapter that
 * can push these down overrides them; the runtime treats `null` as "not
 * supported for this input, fall back to list + in-memory execution."
 *
 * There is no `kind` field. Capabilities are introspected polymorphically.
 *
 * @public
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

// ---------------------------------------------------------------------------
// Shared types (re-exported for consumers who import via `persistence/adapter`)
// ---------------------------------------------------------------------------

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

export interface CommittedTableSnapshot {
  tableName: string;
  docs: StoredDocument[];
}

export interface AtomicCommitOptions {
  materializedTables: string[];
  tableSearchIndexes?: Record<string, SearchIndexDefinition[]>;
  tableVectorIndexes?: Record<string, VectorIndexDefinition[]>;
}

export interface AtomicCommitResult {
  meta: DatabaseMeta;
  tables: CommittedTableSnapshot[];
}

export interface ReadOptions {
  limit?: number | null;
  indexFields?: string[];
  searchDefinition?: SearchIndexDefinition;
  activeIdentityKey?: string | null;
}

export interface QueryRead {
  source: Source;
  filters: FilterNode[];
  limit: number | null;
  indexFields?: string[];
  searchDefinition?: SearchIndexDefinition;
  activeIdentityKey?: string | null;
}

export interface VectorRead {
  tableName: string;
  indexName: string;
  definition: VectorIndexDefinition;
  filter: VectorSearchExpression | null;
  activeIdentityKey?: string | null;
}

// ---------------------------------------------------------------------------
// Abstract base class
// ---------------------------------------------------------------------------

/**
 * Abstract contract every local persistence backend extends.
 *
 * Concrete adapters: {@link OpaqueAdapter}, {@link SqliteAdapter}. Future
 * adapters (Mongo, Redis, ...) slot in by extending this base class without
 * touching the runtime or Store.
 */
export abstract class PersistenceAdapter {
  /**
   * True when the adapter implements {@link atomicCommit} with real logic.
   * Set to `true` in subclasses that bypass the materialized commit pipeline.
   */
  readonly supportsAtomicCommit: boolean = false;

  /**
   * True when the adapter implements any of the pushdown reads (`query`,
   * `source`, `vectorSearch`) with real logic. The runtime uses this to
   * decide between lazy, table-on-demand hydration (pushdown available) and
   * eager full-snapshot hydration on startup.
   */
  readonly supportsPushdownReads: boolean = false;

  // -------------------------------------------------------------------------
  // Required methods — every adapter implements these.
  // -------------------------------------------------------------------------

  /** All documents across all tables. */
  abstract listAll(): Promise<StoredDocumentWithTable[]>;

  /** All documents in a single table. */
  abstract list(tableName: string): Promise<StoredDocument[]>;

  /** Last-known commit metadata, or null if never committed. */
  abstract meta(): Promise<DatabaseMeta | null>;

  /** Apply a batch of writes (durable when the backend is durable). */
  abstract commit(batch: CommitBatch): Promise<void>;

  /** Drop all documents, blobs, and meta. */
  abstract clear(): Promise<void>;

  /** List every persisted blob. */
  abstract listBlobs(): Promise<Array<{ id: string; blob: Blob }>>;

  /** Write a blob (overwrites any existing blob with the same id). */
  abstract putBlob(id: string, blob: Blob): Promise<void>;

  /** Delete a blob. Safe to call for ids that don't exist. */
  abstract deleteBlob(id: string): Promise<void>;

  // -------------------------------------------------------------------------
  // Convenience methods — default implementations in terms of the required
  // methods. Adapters can override for efficiency.
  // -------------------------------------------------------------------------

  /** Fetch a single document by id from a table. */
  async get(tableName: string, id: string): Promise<StoredDocument | null> {
    const docs = await this.list(tableName);
    return docs.find((doc) => doc._id === id) ?? null;
  }

  /** Count documents in a table. */
  async count(tableName: string): Promise<number> {
    const docs = await this.list(tableName);
    return docs.length;
  }

  /** Fetch a single blob by id. */
  async getBlob(id: string): Promise<Blob | null> {
    const blobs = await this.listBlobs();
    return blobs.find((entry) => entry.id === id)?.blob ?? null;
  }

  /** Fetch all documents across multiple tables. */
  async listMany(tableNames: string[]): Promise<StoredDocumentWithTable[]> {
    const results = await Promise.all(
      tableNames.map(async (tableName) => {
        const docs = await this.list(tableName);
        return docs.map((doc) => ({ doc, tableName }));
      }),
    );
    return results.flat();
  }

  // -------------------------------------------------------------------------
  // Capability methods — optional pushdown operations. Default return `null`
  // to signal "not supported; runtime should fall back to list + in-memory."
  // Adapters override to participate.
  // -------------------------------------------------------------------------

  /** Push a query plan down to the adapter; `null` if not supported. */
  async query(_args: QueryRead): Promise<StoredDocument[] | null> {
    return null;
  }

  /** Push a source read (indexed or full-scan) down; `null` if not supported. */
  async source(
    _source: Source,
    _options?: ReadOptions,
  ): Promise<StoredDocument[] | null> {
    return null;
  }

  /** Push vector search down; `null` if not supported. */
  async vectorSearch(_args: VectorRead): Promise<StoredDocument[] | null> {
    return null;
  }

  /**
   * Apply an authoritative commit at the adapter layer, bypassing the
   * materialized commit pipeline. Returns `null` to opt out for this batch.
   */
  async atomicCommit(
    _batch: CommitBatch,
    _options: AtomicCommitOptions,
  ): Promise<AtomicCommitResult | null> {
    return null;
  }

  /** Fast existence probe; `null` if not supported (runtime falls back to list). */
  async hasAnyDocuments(_tableName: string): Promise<boolean | null> {
    return null;
  }

  /**
   * True if writes to this table bypass the in-memory representation. The
   * runtime uses this to decide whether to keep a table materialized.
   * Default: `false` — everything is materialized.
   */
  isAuthoritative(_tableName: string): boolean {
    return false;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Release underlying resources. Default: no-op. */
  async close(): Promise<void> {
    return;
  }
}
