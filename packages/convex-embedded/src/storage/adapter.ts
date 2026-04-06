/**
 * Storage adapter interface for durable persistence.
 *
 * The adapter is a **durability layer**, not a query engine. The in-memory
 * {@link Database} is the source of truth at runtime; the adapter persists
 * state so it can be restored after a page reload or process restart.
 *
 * Implementors must provide five capabilities:
 *  1. Bulk-load all documents on startup.
 *  2. Bulk-load metadata counters on startup.
 *  3. Atomically persist a commit batch (puts + deletes + meta).
 *  4. Store and retrieve blobs (file storage).
 *  5. Wipe all data (for resets / migrations).
 *
 * @internal
 * @packageDocumentation
 */

import type { StoredDocument } from "@/runtime/db/types";

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/**
 * Metadata required to restore a {@link Database} to its pre-shutdown state.
 *
 * These counters are updated on every committed write and must survive
 * restarts so timestamps and creation times remain monotonic.
 * @internal
 */
export interface DatabaseMeta {
  /** MVCC timestamp — monotonically increasing on each write-commit. */
  timestamp: number;
  /** Last assigned `_creationTime` (monotonic). */
  lastCreationTime: number;
}

/**
 * A document paired with its table name, used during persistence.
 * The table name is stored alongside the document so that
 * `getDocumentsByTable` can filter without parsing the ID.
 * @internal
 */
export interface StoredDocumentWithTable {
  doc: StoredDocument;
  tableName: string;
}

/**
 * A batch of changes produced by a single {@link Database.commit}.
 *
 * Passed to {@link StorageAdapter.commit} so the adapter can persist an
 * entire transaction atomically.
 * @internal
 */
export interface CommitBatch {
  /** Documents with their table names, inserted or replaced in this commit. */
  puts: StoredDocumentWithTable[];
  /** IDs of documents that were deleted in this commit. */
  deletes: string[];
  /** Updated counters after this commit. */
  meta: DatabaseMeta;
}

// ---------------------------------------------------------------------------
// StorageAdapter
// ---------------------------------------------------------------------------

/**
 * Durable storage backend for the embedded Convex runtime.
 *
 * The adapter is called in two phases:
 *
 * **Hydration** — on startup the runtime calls {@link getDocuments},
 * {@link getMeta}, and {@link getBlobs} to restore persisted state
 * into the in-memory {@link Database}.
 *
 * **Persistence** — after each successful {@link Database.commit} the
 * runtime calls {@link commit} with the delta. Blob mutations go through
 * {@link storeBlob} and {@link deleteBlob}.
 * @internal
 */
export interface StorageAdapter {
  // -- Hydration (called once on startup) ----------------------------------

  /** Return every persisted document (with table name), across all tables. */
  getDocuments(): Promise<StoredDocumentWithTable[]>;

  /**
   * Return persisted documents for a single table.
   *
   * Used by cross-tab remote to incrementally re-read only the tables
   * that were written by another tab, rather than re-loading everything.
   *
   * Documents are stored with an associated `tableName`, so implementations
   * filter by the stored table name column/field.
   */
  getDocumentsByTable(tableName: string): Promise<StoredDocument[]>;

  /** Return persisted metadata, or `null` on first run. */
  getMeta(): Promise<DatabaseMeta | null>;

  /** Return every persisted blob as `{ id, blob }` pairs. */
  getBlobs(): Promise<Array<{ id: string; blob: Blob }>>;

  // -- Persistence (called on each Database.commit()) ----------------------

  /**
   * Atomically persist a commit batch.
   *
   * The adapter SHOULD write all puts, deletes, and meta in a single
   * transaction when the backend supports it (e.g. IndexedDB transaction,
   * SQLite transaction). If atomicity is not possible, writes MUST be
   * ordered: puts → deletes → meta.
   */
  commit(batch: CommitBatch): Promise<void>;

  // -- Blob storage --------------------------------------------------------

  /** Persist a blob by ID. */
  storeBlob(id: string, blob: Blob): Promise<void>;

  /** Delete a persisted blob by ID. */
  deleteBlob(id: string): Promise<void>;

  // -- Lifecycle -----------------------------------------------------------

  /** Wipe all persisted data (documents, meta, blobs). */
  clear(): Promise<void>;

  /** Release resources (close DB connections, etc.). */
  close?(): Promise<void>;
}
