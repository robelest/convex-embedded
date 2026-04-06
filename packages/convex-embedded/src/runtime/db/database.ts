import { Fx } from "@robelest/fx";
import type { JSONValue, Value } from "convex/values";
import { jsonToConvex } from "convex/values";

import {
  createAmbientCryptoProvider,
  type EmbeddedCryptoProvider,
} from "@/runtime/crypto";
import { compareValues } from "@/runtime/db/compare";
import { QueryEngine } from "@/runtime/db/query";
import {
  evaluateFieldPath,
  evaluateNormalizedFilter,
  normalizeFilter,
  type DocumentIterator,
  type FilterNode,
  type QueryReader,
  type SourceReader,
  type TableCountReader,
} from "@/runtime/db/query";
import type { ParsedSchema } from "@/runtime/db/schema";
import {
  validateValidator,
  validateSchemaDefinition,
} from "@/runtime/db/schema";
import {
  addDocumentToSearchIndexState,
  buildSearchIndexState,
  executeSearch,
  executeOverlaySearch,
  removeDocumentFromSearchIndexState,
  resolveSearchIndexDefinition,
  type SearchOverlayState,
  type SearchIndexState,
} from "@/runtime/db/search";
/**
 * Core in-memory database engine with MVCC timestamps.
 *
 * Ported from convex-test's `DatabaseFake`, enhanced with:
 *  - MVCC timestamp that increments on each committed transaction
 *  - Per-transaction tracking of which tables were written
 *  - Delegation to QueryEngine for query evaluation
 *
 * ID format: UUIDs generated via `crypto.randomUUID()`.
 * A separate `_idTableMap` maps each UUID to its table name.
 */
import type { GenericDocument } from "@/runtime/db/types";
import type {
  DocumentId,
  QueryId,
  SerializedQuery,
  SerializedRangeExpression,
  StoredDocument,
  TableName,
  Timestamp,
  VectorSearchExpression,
} from "@/runtime/db/types";
import {
  addDocumentToVectorIndexState,
  buildVectorIndexState,
  executeOverlayVectorSearch,
  executeVectorSearch,
  removeDocumentFromVectorIndexState,
  resolveVectorIndexDefinition,
  type VectorOverlayState,
  type VectorIndexState,
} from "@/runtime/db/vector";
import type { CommitBatch, StorageAdapter } from "@/storage/adapter";

const IDENTITY_SCOPE_FIELD = "__identityKey";

type IdentityScopedDocument = StoredDocument & {
  [IDENTITY_SCOPE_FIELD]?: string | null;
};

type CommittedStateChange = {
  tableName: string;
  id: DocumentId;
  before: IdentityScopedDocument | null;
  after: IdentityScopedDocument | null;
};

type PendingTableState = {
  shadowedIds: Set<string>;
  rawVisibleDocs: Map<string, IdentityScopedDocument>;
  visiblePendingDocs?: Array<{
    doc: StoredDocument;
    identityKey: string | null;
  }>;
  mergedIndexes: Map<string, StoredDocument[]>;
  vectorOverlays: Map<string, VectorOverlayState>;
  searchOverlays: Map<string, SearchOverlayState>;
};

const SYSTEM_INDEX_DEFINITIONS: Record<
  string,
  Array<{ indexName: string; fields: string[] }>
> = {
  _resolve_id_map: [
    {
      indexName: "by_identity_key_and_local_id",
      fields: ["identityKey", "localId", "_creationTime", "_id"],
    },
  ],
  _resolve_pending: [
    {
      indexName: "by_identity_key_and_creation_time",
      fields: ["identityKey", "_creationTime", "_id"],
    },
  ],
  _resolve_schema_versions: [
    {
      indexName: "by_table",
      fields: ["table", "_creationTime", "_id"],
    },
  ],
  _resolve_store_versions: [
    {
      indexName: "by_store_scope_and_identity",
      fields: ["store", "scope", "identityKey", "_creationTime", "_id"],
    },
  ],
};

export interface DatabaseCommitResult {
  timestamp: Timestamp;
  tablesWritten: Set<string>;
  changes: Array<{
    tableName: string;
    before: StoredDocument | null;
    after: StoredDocument | null;
  }>;
  persisted: Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a JSONValue to a Convex value, treating `{ $undefined: true }` as
 * `undefined` (used when patch/replace values arrive from the syscall layer).
 */
function evaluateValue(value: JSONValue): Value | undefined {
  if (typeof value === "object" && value !== null && "$undefined" in value) {
    return undefined;
  }
  return jsonToConvex(value);
}

function formatValueForError(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (value instanceof ArrayBuffer) {
    return `ArrayBuffer(${value.byteLength})`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export class Database {
  // ---- Persistent state ---------------------------------------------------

  /** Committed documents keyed by `DocumentId`. */
  private _documents: Record<DocumentId, StoredDocument> = {};

  /** Blob storage keyed by `_storage` document ID. */
  private _blobStorage: Record<DocumentId, Blob> = {};

  /** Committed document IDs grouped by table for faster per-table iteration. */
  private _tableDocuments: Map<string, Set<string>> = new Map();

  /** Committed index orderings keyed by `table.index`. */
  private _indexDocuments: Map<string, string[]> = new Map();

  /** Committed search index state keyed by `table.index`. */
  private _searchIndexes: Map<string, SearchIndexState> = new Map();

  /** Committed vector index state keyed by `table.index`. */
  private _vectorIndexes: Map<string, VectorIndexState> = new Map();

  /**
   * Maps each document UUID to its table name.
   * Populated on insert (when UUID is generated) and on hydrate/syncTable
   * (derived from stored documents).
   */
  private _idTableMap: Map<string, string> = new Map();

  /** Last creation-time value emitted, used to guarantee monotonic times. */
  private _lastCreationTime: number = 0;

  /** Parsed schema definition (may be null if running schema-less). */
  private _schema: ParsedSchema | null;

  /** Active identity namespace for non-system tables. */
  private _activeIdentityKey: string | null = null;

  // ---- MVCC state ---------------------------------------------------------

  /**
   * Monotonically increasing timestamp. Incremented on every committed
   * transaction that contains at least one write. Consumers (e.g. the
   * subscription manager) use this to detect staleness.
   */
  private _timestamp: Timestamp = 0;

  /**
   * Tables that have been written (insert / patch / replace / delete)
   * in the *current* outermost transaction.  Accumulated across nested
   * child transactions when they commit up.
   */
  private _tablesWritten: Set<string> = new Set();

  // ---- Storage adapter ----------------------------------------------------

  /** Optional durable storage backend. */
  private _storage: StorageAdapter | null = null;

  private readonly _crypto: EmbeddedCryptoProvider;

  // ---- Transaction state --------------------------------------------------

  /**
   * Pending writes for each level of transaction nesting.
   *
   * - When a mutation performs updates they are staged in the last (deepest)
   *   level.
   * - When a child mutation commits, its writes are merged up one level.
   * - When the top-level mutation commits, the writes are applied to
   *   `_documents` and the MVCC timestamp bumps.
   * - When a mutation rolls back, the deepest level is discarded.
   */
  private _writes: Array<Record<DocumentId, StoredDocument | null>> = [];

  /** Number of staged writes across all active transaction levels. */
  private _pendingWriteCount = 0;

  /** Per-transaction write counts keyed by nesting depth. */
  private _writeCounts: number[] = [];

  /** Pending write ids grouped by table for each transaction level. */
  private _writeTables: Array<Map<string, Set<string>>> = [];

  /** Lazily built visible pending state grouped by table. */
  private _pendingTableState: Map<string, PendingTableState> = new Map();

  // ---- Query engine -------------------------------------------------------

  readonly queryEngine: QueryEngine;

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  constructor(
    schema: ParsedSchema | null,
    storage?: StorageAdapter,
    crypto?: EmbeddedCryptoProvider,
  ) {
    this._schema = schema;
    this._storage = storage ?? null;
    this._crypto = crypto ?? createAmbientCryptoProvider();

    if (schema !== null) {
      validateSchemaDefinition(schema);
    }

    // Build document iterator bound to this database instance.
    const iterateDocs: DocumentIterator = (tableName, callback) => {
      this._iterateDocs(tableName, callback);
    };
    const countTable: TableCountReader = (tableName) =>
      this.getDocumentsForTable(tableName).length;
    const readQuery: QueryReader = (query) => this._readOptimizedQuery(query);
    const readSource: SourceReader = (source, limit) =>
      this._readOptimizedSource(source, limit);

    this.queryEngine = new QueryEngine(
      schema,
      iterateDocs,
      countTable,
      readQuery,
      readSource,
    );
  }

  // -------------------------------------------------------------------------
  // Storage management
  // -------------------------------------------------------------------------

  /**
   * Attach (or replace) the durable storage adapter.
   *
   * This is used when the storage backend is initialised asynchronously
   * (e.g. a wa-sqlite worker) after the `Database` is constructed.
   * After calling this, invoke {@link hydrate} to load persisted data.
   */
  setStorage(storage: StorageAdapter): void {
    this._storage = storage;
  }

  setActiveIdentityKey(identityKey: string | null): void {
    this._activeIdentityKey = identityKey;
  }

  getActiveIdentityKey(): string | null {
    return this._activeIdentityKey;
  }

  // -------------------------------------------------------------------------
  // Storage hydration
  // -------------------------------------------------------------------------

  /**
   * Hydrate the database from durable storage.
   *
   * Must be called (and awaited) before the first transaction when a
   * {@link StorageAdapter} is configured. No-op when running without
   * storage.
   */
  async hydrate(): Promise<void> {
    if (this._storage === null) return;

    const [documents, meta, blobs] = await Promise.all([
      this._storage.getDocuments(),
      this._storage.getMeta(),
      this._storage.getBlobs(),
    ]);

    // Restore documents and rebuild ID→table map.
    for (const { doc, tableName } of documents) {
      this._documents[doc._id] = doc;
      if (tableName) {
        this._idTableMap.set(doc._id as string, tableName);
        this._addCommittedIdToTable(tableName, doc._id as string);
      }
    }
    this._rebuildAllIndexes();
    this._rebuildAllSearchIndexes();
    this._rebuildAllVectorIndexes();

    // Restore metadata counters.
    if (meta !== null) {
      this._timestamp = meta.timestamp;
      this._lastCreationTime = meta.lastCreationTime;
    }

    // Restore blobs.
    for (const { id, blob } of blobs) {
      this._blobStorage[id as DocumentId] = blob;
    }
  }

  /**
   * Re-read a single table from durable storage into the in-memory store.
   *
   * Used by cross-tab sync: when another tab writes to a table, this
   * method replaces the in-memory documents for that table with the
   * current state from IndexedDB (via the wa-sqlite worker). Also
   * syncs metadata counters so IDs and timestamps remain monotonic.
   *
   * No-op when running without a storage adapter.
   */
  async syncTable(tableName: string): Promise<void> {
    if (this._storage === null) return;

    const [docs, meta] = await Promise.all([
      this._storage.getDocumentsByTable(tableName),
      this._storage.getMeta(),
    ]);

    // Remove all current in-memory docs for this table.
    for (const id of this._tableDocuments.get(tableName) ?? []) {
      delete this._documents[id as DocumentId];
      this._idTableMap.delete(id);
    }
    this._tableDocuments.set(tableName, new Set());

    // Replace with what's in storage and rebuild map entries.
    for (const doc of docs) {
      this._documents[doc._id] = doc;
      this._idTableMap.set(doc._id as string, tableName);
      this._addCommittedIdToTable(tableName, doc._id as string);
    }
    this._rebuildTableIndexes(tableName);
    this._rebuildTableSearchIndexes(tableName);
    this._rebuildTableVectorIndexes(tableName);

    // Sync metadata counters so timestamps remain monotonic across tabs.
    if (meta !== null) {
      if (meta.timestamp > this._timestamp) {
        this._timestamp = meta.timestamp;
      }
      if (meta.lastCreationTime > this._lastCreationTime) {
        this._lastCreationTime = meta.lastCreationTime;
      }
    }
  }

  // -------------------------------------------------------------------------
  // MVCC timestamp
  // -------------------------------------------------------------------------

  /** Current MVCC timestamp. */
  get timestamp(): Timestamp {
    return this._timestamp;
  }

  // -------------------------------------------------------------------------
  // Transaction lifecycle
  // -------------------------------------------------------------------------

  /** Begin a new (possibly nested) transaction. */
  startTransaction(): void {
    this._writes.push({});
    this._writeCounts.push(0);
    this._writeTables.push(new Map());
  }

  /**
   * Commit the current transaction level.
   *
   * - If this is a nested transaction, writes merge into the parent level.
   * - If this is the outermost transaction, writes are applied to committed
   *   storage and the MVCC timestamp bumps.
   *
   * Returns the new timestamp and the set of tables that were written so
   * that callers can invalidate subscriptions.
   */
  commit(): DatabaseCommitResult {
    const lastWrites = this._writes.pop();
    const lastWriteCount = this._writeCounts.pop();
    const _lastWriteTables = this._writeTables.pop();
    if (lastWrites === undefined) {
      throw new Error("Transaction already committed or rolled back");
    }
    this._pendingWriteCount -= lastWriteCount ?? 0;
    this._pendingTableState.clear();

    // Track which tables are affected by this commit level.
    for (const id of Object.keys(lastWrites)) {
      const table = this._idTableMap.get(id);
      if (table !== undefined) {
        this._tablesWritten.add(table);
      }
    }

    if (this._writes.length === 0) {
      // Outermost commit — apply writes to in-memory storage.
      const { puts, deletes, changes, stateChanges } =
        this._applyCommittedWrites(lastWrites);

      // Bump timestamp only if there were actual writes.
      const tablesWritten = new Set(this._tablesWritten);
      if (tablesWritten.size > 0) {
        this._timestamp += 1;
        this._applyCommittedStateChanges(stateChanges);
      }
      this._tablesWritten.clear();
      this._pendingTableState.clear();

      const persisted = this._persistCommitBatch({
        puts,
        deletes,
        meta: {
          timestamp: this._timestamp,
          lastCreationTime: this._lastCreationTime,
        },
      });

      return { timestamp: this._timestamp, tablesWritten, changes, persisted };
    }

    // Nested commit — merge writes into the parent level.
    for (const [id, write] of Object.entries(lastWrites)) {
      this._addWriteRaw(id as DocumentId, write);
    }

    // Return the *current* (not yet bumped) timestamp; the outermost
    // commit is what actually increments it.
    return {
      timestamp: this._timestamp,
      tablesWritten: new Set(this._tablesWritten),
      changes: [],
      persisted: Promise.resolve(),
    };
  }

  /** Discard the deepest pending write level. */
  rollbackWrites(): void {
    if (this._writes.length === 0) {
      throw new Error("Transaction already committed or rolled back");
    }
    this._writes.pop();
    this._pendingWriteCount -= this._writeCounts.pop() ?? 0;
    this._writeTables.pop();
    this._pendingTableState.clear();
  }

  // -------------------------------------------------------------------------
  // CRUD operations
  // -------------------------------------------------------------------------

  /**
   * Read a single document by ID.
   *
   * Reads through the write stack (most-recent first) before falling back
   * to committed storage. Returns `null` when the document has been deleted
   * or never existed.
   */
  get(
    tableName: TableName | undefined,
    id: DocumentId,
    _options: { countRead?: boolean } = {},
  ): StoredDocument | null {
    if (!this._validateId(tableName, id)) {
      return null;
    }

    const document = this._getRaw(id);
    if (document === null || !this._isVisibleInScope(tableName, document)) {
      return null;
    }

    return this._stripIdentityScope(document);
  }

  /** Insert a new document. Returns the generated UUID `_id`. */
  insert(table: TableName, value: Record<string, unknown>): DocumentId {
    this._validate(table, value as GenericDocument);
    const _id = this._crypto.randomUUID() as unknown as DocumentId;
    this._idTableMap.set(_id as string, table);
    const now = Date.now();
    const _creationTime =
      now <= this._lastCreationTime ? this._lastCreationTime + 0.001 : now;
    this._lastCreationTime = _creationTime;
    this._addWrite(
      _id,
      this._withIdentityScope(table, { ...value, _id, _creationTime }),
    );
    return _id;
  }

  /** Merge `value` into an existing document (like `Object.assign`). */
  patch(
    tableName: TableName | undefined,
    id: DocumentId,
    value: Record<string, unknown>,
  ): void {
    const idText = formatValueForError(id);
    if (!this._validateId(tableName, id)) {
      throw new Error(`Patch on non-existent document with ID "${idText}"`);
    }

    if (typeof value !== "object" || value === null) {
      throw new Error(
        `Invalid argument \`value\` in \`db.patch\`, expected object but got '${typeof value}': ${String(value)}`,
      );
    }

    const rawDocument = this._getRaw(id);
    if (
      rawDocument === null ||
      !this._isVisibleInScope(tableName, rawDocument)
    ) {
      throw new Error(`Patch on non-existent document with ID "${idText}"`);
    }
    const document = this._stripIdentityScope(rawDocument);

    const { _id, _creationTime, ...fields } = document;

    if (value._id !== undefined && value._id !== _id) {
      throw new Error(
        `Provided \`_id\` field value "${formatValueForError(value._id)}" ` +
          `does not match the document ID "${_id}"`,
      );
    }
    if (
      value._creationTime !== undefined &&
      value._creationTime !== _creationTime
    ) {
      throw new Error(
        `Provided \`_creationTime\` field value ${formatValueForError(value._creationTime)} ` +
          `does not match the document's creation time ${_creationTime}`,
      );
    }

    // Strip system fields before merging.
    delete value["_id"];
    delete value["_creationTime"];

    // Resolve any $undefined sentinels.
    const convexValue: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      convexValue[key] = evaluateValue(v as JSONValue);
    }

    const merged = { ...fields, ...convexValue };
    this._validate(
      this._idTableMap.get(_id as string)!,
      merged as GenericDocument,
    );
    this._addWrite(
      id,
      this._withIdentityScope(tableName, { _id, _creationTime, ...merged }),
    );
  }

  /** Replace all user fields of an existing document. */
  replace(
    tableName: TableName | undefined,
    id: DocumentId,
    value: Record<string, unknown>,
  ): void {
    const idText = formatValueForError(id);
    if (!this._validateId(tableName, id)) {
      throw new Error(`Replace on non-existent document with ID "${idText}"`);
    }

    if (typeof value !== "object" || value === null) {
      throw new Error(
        `Invalid argument \`value\` in \`db.replace\`, expected object but got '${typeof value}': ${String(value)}`,
      );
    }

    const rawDocument = this._getRaw(id);
    if (
      rawDocument === null ||
      !this._isVisibleInScope(tableName, rawDocument)
    ) {
      throw new Error(`Replace on non-existent document with ID "${idText}"`);
    }
    const document = this._stripIdentityScope(rawDocument);

    if (value._id !== undefined && value._id !== document._id) {
      throw new Error(
        `Provided \`_id\` field value "${formatValueForError(value._id)}" ` +
          `does not match the document ID "${document._id}"`,
      );
    }
    if (
      value._creationTime !== undefined &&
      value._creationTime !== document._creationTime
    ) {
      throw new Error(
        `Provided \`_creationTime\` field value ${formatValueForError(value._creationTime)} ` +
          `does not match the document's creation time ${document._creationTime}`,
      );
    }

    delete value["_id"];
    delete value["_creationTime"];

    const convexValue: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      convexValue[key] = evaluateValue(v as JSONValue);
    }

    this._validate(
      this._idTableMap.get(document._id as string)!,
      convexValue as GenericDocument,
    );
    this._addWrite(
      id,
      this._withIdentityScope(tableName, {
        ...convexValue,
        _id: document._id,
        _creationTime: document._creationTime,
      }),
    );
  }

  /** Mark a document as deleted. */
  delete(tableName: TableName | undefined, id: DocumentId): void {
    if (!this._validateId(tableName, id)) {
      throw new Error("Delete on non-existent doc");
    }

    const rawDocument = this._getRaw(id);
    if (
      rawDocument === null ||
      !this._isVisibleInScope(tableName, rawDocument)
    ) {
      throw new Error("Delete on non-existent doc");
    }
    this._addWrite(id, null);
  }

  // -------------------------------------------------------------------------
  // Authoritative ingestion (for remote → local sync)
  // -------------------------------------------------------------------------

  /**
   * Upsert a document with a caller-supplied `_id` and `_creationTime`.
   *
   * Used when ingesting authoritative documents from a remote source
   * (e.g. a remote Convex backend). Unlike {@link insert}, this method
   * does **not** generate a new UUID — it uses the provided `_id` as-is.
   *
   * - If the `_id` already exists in the database and belongs to the
   *   same table, the document is **replaced** with the incoming values.
   * - If the `_id` is new, it is registered in the ID table map and
   *   inserted as a new document.
   * - Throws if the `_id` belongs to a **different** table.
   *
   * Must be called within an active transaction.
   */
  putDocument(
    table: TableName,
    doc: Record<string, unknown> & { _id: string; _creationTime: number },
  ): void {
    const { _id, _creationTime, ...userFields } = doc;
    const docId = _id as unknown as DocumentId;

    this._validate(table, userFields as GenericDocument);

    const existingTable = this._idTableMap.get(_id);

    if (existingTable !== undefined) {
      // ID exists — verify it belongs to the same table.
      if (existingTable !== table) {
        throw new Error(
          `putDocument: ID "${_id}" belongs to table "${existingTable}", ` +
            `not "${table}"`,
        );
      }
      // Replace in-place — keep the incoming _id and _creationTime.
      this._addWrite(
        docId,
        this._withIdentityScope(table, {
          _id: docId,
          _creationTime,
          ...userFields,
        }),
      );
    } else {
      // New document — register in the ID table map.
      this._idTableMap.set(_id, table);

      // Track creation time for monotonicity.
      if (_creationTime > this._lastCreationTime) {
        this._lastCreationTime = _creationTime;
      }

      this._addWrite(
        docId,
        this._withIdentityScope(table, {
          _id: docId,
          _creationTime,
          ...userFields,
        }),
      );
    }
  }

  /**
   * Remove a document by ID if it exists. Returns `true` if the document
   * was found and deleted, `false` if it was not present (no-op).
   *
   * Unlike {@link delete}, this method does **not** throw when the
   * document is missing — it silently returns `false`. This is useful
   * when syncing deletions from a remote source where the local state
   * may already be out of remote.
   *
   * Must be called within an active transaction.
   */
  removeDocument(table: TableName, id: DocumentId): boolean {
    const existingTable = this._idTableMap.get(id as string);
    if (existingTable === undefined) {
      return false;
    }

    if (existingTable !== table) {
      throw new Error(
        `removeDocument: ID "${id}" belongs to table "${existingTable}", ` +
          `not "${table}"`,
      );
    }

    const rawDocument = this._getRaw(id);
    if (rawDocument === null || !this._isVisibleInScope(table, rawDocument)) {
      return false;
    }

    this._addWrite(id, null);
    return true;
  }

  /**
   * Return all committed + pending documents for a given table.
   *
   * Reads through the write stack so in-transaction changes are visible.
   * Deleted documents (write === null) are excluded.
   */
  getDocumentsForTable(tableName: string): StoredDocument[] {
    const results: StoredDocument[] = [];
    this._iterateDocs(tableName, (doc) => results.push(doc));
    return results;
  }

  hasDocumentsForTable(tableName: string): boolean {
    return (this._tableDocuments.get(tableName)?.size ?? 0) > 0;
  }

  migrateAnonymousDataToIdentity(identityKey: string): Set<string> {
    const tablesWritten = new Set<string>();
    for (const [id, doc] of Object.entries(this._documents)) {
      const tableName = this._idTableMap.get(id);
      if (!tableName || !this._isIdentityScopedTable(tableName)) {
        continue;
      }
      if ((doc as IdentityScopedDocument)[IDENTITY_SCOPE_FIELD] != null) {
        continue;
      }
      this._addWrite(id as DocumentId, {
        ...(doc as IdentityScopedDocument),
        [IDENTITY_SCOPE_FIELD]: identityKey,
      });
      tablesWritten.add(tableName);
    }
    return tablesWritten;
  }

  // -------------------------------------------------------------------------
  // normalizeId
  // -------------------------------------------------------------------------

  /**
   * If `idString` is a valid ID that belongs to `table`, return it.
   * Otherwise return `null`.
   */
  normalizeId(table: TableName, idString: string): DocumentId | null {
    if (typeof idString !== "string") return null;
    return this._idTableMap.get(idString) === table
      ? (idString as DocumentId)
      : null;
  }

  /**
   * Look up the table name for a given document ID.
   * Returns `undefined` if the ID is not known.
   */
  getTableForId(id: string): string | undefined {
    return this._idTableMap.get(id);
  }

  // -------------------------------------------------------------------------
  // File / blob storage
  // -------------------------------------------------------------------------

  storeFile(storageId: DocumentId, blob: Blob): void {
    this._blobStorage[storageId] = blob;

    // Persist to durable storage (fire-and-forget).
    if (this._storage) {
      const storage = this._storage;
      Fx.detach(
        () => storage.storeBlob(storageId as string, blob),
        "[convex-embedded] blob persist failed:",
      );
    }
  }

  deleteBlob(storageId: string): void {
    delete this._blobStorage[storageId as DocumentId];

    // Remove from durable storage (fire-and-forget).
    if (this._storage) {
      const storage = this._storage;
      Fx.detach(
        () => storage.deleteBlob(storageId),
        "[convex-embedded] blob delete failed:",
      );
    }
  }

  getFile(storageId: DocumentId): Blob | null {
    if (this.get("_storage", storageId) === null) {
      return null;
    }
    return this._blobStorage[storageId] ?? null;
  }

  // -------------------------------------------------------------------------
  // Query delegation
  // -------------------------------------------------------------------------

  startQuery(query: SerializedQuery): QueryId {
    return this.queryEngine.startQuery(query);
  }

  queryNext(queryId: QueryId): {
    value: GenericDocument | null;
    done: boolean;
  } {
    return this.queryEngine.queryNext(queryId);
  }

  queryCleanup(queryId: QueryId): void {
    this.queryEngine.queryCleanup(queryId);
  }

  paginate(args: {
    query: SerializedQuery;
    cursor: string | null;
    pageSize: number;
  }): { page: GenericDocument[]; isDone: boolean; continueCursor: string } {
    return this.queryEngine.paginate(args);
  }

  count(tableName: string): number {
    return this.queryEngine.count(tableName);
  }

  getCommittedTableCount(tableName: string): number {
    return this._tableDocuments.get(tableName)?.size ?? 0;
  }

  getIndexedDocuments(tableName: string, indexName: string): StoredDocument[] {
    const indexKey = `${tableName}.${indexName}`;
    const ids = this._indexDocuments.get(indexKey);
    if (!ids) {
      if (
        indexName === "by_creation_time" ||
        indexName === "by_creation_time_desc" ||
        indexName === "by_id" ||
        (SYSTEM_INDEX_DEFINITIONS[tableName] ?? []).some(
          (entry) => entry.indexName === indexName,
        )
      ) {
        return [];
      }
      throw new Error(
        `Cannot use index "${indexName}" for table "${tableName}" because it is not declared in the schema.`,
      );
    }
    return ids
      .map((id) => this._documents[id as DocumentId])
      .filter((doc): doc is StoredDocument => doc !== undefined)
      .map((doc) => this._stripIdentityScope(doc as IdentityScopedDocument));
  }

  vectorSearch(
    tableAndIndexName: string,
    vector: number[],
    filter: VectorSearchExpression | null,
    limit?: number,
  ): Array<{ _id: string; _score: number }> {
    const [tableName, indexName] = tableAndIndexName.split(".");
    const state = this._vectorIndexes.get(`${tableName}.${indexName}`);
    if (state) {
      resolveVectorIndexDefinition(
        this._schema?.tables.get(tableName)?.vectorIndexes,
        tableName,
        indexName,
      );

      if (!this._hasPendingWritesForTable(tableName)) {
        return executeVectorSearch(state, {
          vector,
          limit,
          filter,
          activeIdentityKey: this._activeIdentityKey,
        });
      }

      return executeOverlayVectorSearch(
        state,
        this._buildPendingVectorOverlay(tableName, state),
        {
          vector,
          limit,
          filter,
          activeIdentityKey: this._activeIdentityKey,
        },
      );
    }

    return this.queryEngine.vectorSearch(
      tableAndIndexName,
      vector,
      filter,
      limit,
    );
  }

  // -------------------------------------------------------------------------
  // Private: ID validation
  // -------------------------------------------------------------------------

  /**
   * Validate that `id` is a string whose table (looked up in `_idTableMap`)
   * matches `expectedTableName` (when non-undefined).
   *
   * Returns `true` if the ID is known and valid, `false` if the ID is a
   * valid UUID string but not present in `_idTableMap` (deleted or never
   * existed). Throws only for genuinely invalid arguments (wrong type,
   * wrong table).
   */
  private _validateId(
    expectedTableName: unknown,
    id: unknown,
  ): id is DocumentId {
    if (typeof id !== "string") {
      throw new Error(
        `Invalid argument \`id\`, expected string but got '${typeof id}': ${String(id)}`,
      );
    }

    if (expectedTableName === undefined) {
      return true;
    }

    if (typeof expectedTableName !== "string") {
      throw new Error(
        `Invalid argument \`tableName\`, expected string but got '${typeof expectedTableName}': ${formatValueForError(expectedTableName)}`,
      );
    }

    const actualTableName = this._idTableMap.get(id);
    if (actualTableName === undefined) {
      // ID is not known — could be deleted or never existed.
      // Return false so callers (get/delete/patch/replace) can handle it.
      return false;
    }

    if (actualTableName !== expectedTableName) {
      throw new Error(
        `Invalid argument \`id\`, expected ID in table '${expectedTableName}' but got ID in table '${actualTableName}'`,
      );
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Private: schema validation
  // -------------------------------------------------------------------------

  /**
   * Validate a document against the schema for `tableName`.
   * No-op when running schema-less or when validation is disabled.
   */
  private _validate(tableName: string, doc: GenericDocument): void {
    if (this._schema === null || !this._schema.schemaValidation) {
      return;
    }
    const validator = this._schema.tables.get(tableName)?.documentType;
    if (validator === undefined) {
      return;
    }
    validateValidator(validator, doc, (id) => this._idTableMap.get(id));
  }

  // -------------------------------------------------------------------------
  // Private: write helpers
  // -------------------------------------------------------------------------

  /**
   * Stage a write into the deepest pending transaction level.
   * Throws if no transaction is active.
   */
  private _addWrite(id: DocumentId, newValue: StoredDocument | null): void {
    if (this._writes.length === 0) {
      throw new Error(`Write outside of transaction ${id}`);
    }
    this._registerWrite(this._writes.length - 1, id, newValue);
  }

  /**
   * Low-level write into the current deepest transaction level.
   * Used during nested commit to merge child writes into the parent —
   * skips the "no transaction" check because the parent level exists.
   */
  private _addWriteRaw(id: DocumentId, newValue: StoredDocument | null): void {
    this._registerWrite(this._writes.length - 1, id, newValue);
  }

  private _registerWrite(
    level: number,
    id: DocumentId,
    newValue: StoredDocument | null,
  ): void {
    const writes = this._writes[level];
    if (writes[id] === undefined) {
      this._pendingWriteCount += 1;
      this._writeCounts[level] = (this._writeCounts[level] ?? 0) + 1;
      const tableName = this._idTableMap.get(id as string);
      if (tableName) {
        this._pendingTableState.delete(tableName);
        let ids = this._writeTables[level]?.get(tableName);
        if (!ids) {
          ids = new Set();
          this._writeTables[level]?.set(tableName, ids);
        }
        ids.add(id as string);
      }
    }

    writes[id] = newValue;
  }

  private _applyCommittedWrites(
    lastWrites: Record<DocumentId, StoredDocument | null>,
  ): {
    puts: Array<{ doc: StoredDocument; tableName: string }>;
    deletes: string[];
    changes: Array<{
      tableName: string;
      before: StoredDocument | null;
      after: StoredDocument | null;
    }>;
    stateChanges: CommittedStateChange[];
  } {
    return Object.entries(lastWrites).reduce(
      (acc, [id, write]) => {
        const docId = id as DocumentId;
        const tableName = this._idTableMap.get(id) ?? "";
        const before =
          (this._documents[docId] as IdentityScopedDocument | undefined) ??
          null;

        if (write === null) {
          delete this._documents[docId];
          if (tableName !== undefined) {
            this._removeCommittedIdFromTable(tableName, id);
          }
          this._idTableMap.delete(id);
          acc.deletes.push(id);
          if (tableName) {
            acc.changes.push({
              tableName,
              before: before ? this._stripIdentityScope(before) : null,
              after: null,
            });
            acc.stateChanges.push({
              tableName,
              id: docId,
              before,
              after: null,
            });
          }
          return acc;
        }

        this._documents[docId] = write;
        if (tableName) {
          this._addCommittedIdToTable(tableName, id);
        }
        acc.puts.push({ doc: write, tableName });
        if (tableName) {
          acc.changes.push({
            tableName,
            before: before ? this._stripIdentityScope(before) : null,
            after: this._stripIdentityScope(write as IdentityScopedDocument),
          });
          acc.stateChanges.push({
            tableName,
            id: docId,
            before,
            after: write as IdentityScopedDocument,
          });
        }
        return acc;
      },
      {
        puts: [] as Array<{ doc: StoredDocument; tableName: string }>,
        deletes: [] as string[],
        changes: [] as Array<{
          tableName: string;
          before: StoredDocument | null;
          after: StoredDocument | null;
        }>,
        stateChanges: [] as CommittedStateChange[],
      },
    );
  }

  private _persistCommitBatch(batch: CommitBatch): Promise<void> {
    if (this._storage === null) return Promise.resolve();
    if (batch.puts.length === 0 && batch.deletes.length === 0) {
      return Promise.resolve();
    }
    return this._storage.commit(batch);
  }

  // -------------------------------------------------------------------------
  // Private: document iteration
  // -------------------------------------------------------------------------

  /**
   * Iterate over all visible documents in `tableName`, including pending
   * writes at every nesting level.  Deleted documents (write === null)
   * are skipped.
   */
  private _iterateDocs(
    tableName: string,
    callback: (doc: StoredDocument) => void,
  ): void {
    if (!this._hasPendingWritesForTable(tableName)) {
      for (const id of this._tableDocuments.get(tableName) ?? []) {
        const document = this._documents[id as DocumentId] as
          | IdentityScopedDocument
          | undefined;
        const visible =
          document === undefined
            ? null
            : this._visibleDocumentInScope(tableName, document);
        if (visible !== null) {
          callback(visible);
        }
      }
      return;
    }

    const seen = new Set<string>();
    for (let level = this._writes.length - 1; level >= 0; level -= 1) {
      const ids = this._writeTables[level]?.get(tableName);
      if (!ids) {
        continue;
      }

      for (const id of ids) {
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);

        const document = this._writes[level]?.[id as DocumentId] as
          | IdentityScopedDocument
          | null
          | undefined;
        const visible =
          document === undefined || document === null
            ? null
            : this._visibleDocumentInScope(tableName, document);
        if (visible !== null) {
          callback(visible);
        }
      }
    }

    for (const id of this._tableDocuments.get(tableName) ?? []) {
      if (seen.has(id)) {
        continue;
      }
      const document = this._documents[id as DocumentId] as
        | IdentityScopedDocument
        | undefined;
      const visible =
        document === undefined
          ? null
          : this._visibleDocumentInScope(tableName, document);
      if (visible !== null) {
        callback(visible);
      }
    }
  }

  private _getRaw(id: DocumentId): IdentityScopedDocument | null {
    let hasPendingWrite = false;
    let document: IdentityScopedDocument | null = null;

    for (let i = this._writes.length - 1; i >= 0; i--) {
      const write = this._writes[i][id];
      if (write !== undefined) {
        hasPendingWrite = true;
        document = write as IdentityScopedDocument | null;
        break;
      }
    }

    if (!hasPendingWrite) {
      document =
        (this._documents[id] as IdentityScopedDocument | undefined) ?? null;
    }

    return document;
  }

  private _isIdentityScopedTable(tableName: TableName | undefined): boolean {
    return typeof tableName === "string" && !tableName.startsWith("_");
  }

  private _isVisibleInScope(
    tableName: TableName | undefined,
    document: IdentityScopedDocument,
  ): boolean {
    if (!this._isIdentityScopedTable(tableName)) {
      return true;
    }
    return (document[IDENTITY_SCOPE_FIELD] ?? null) === this._activeIdentityKey;
  }

  private _withIdentityScope<T extends Record<string, unknown>>(
    tableName: TableName | undefined,
    document: T,
  ): T & { [IDENTITY_SCOPE_FIELD]?: string | null } {
    if (!this._isIdentityScopedTable(tableName)) {
      return document;
    }

    return {
      ...document,
      [IDENTITY_SCOPE_FIELD]: this._activeIdentityKey,
    };
  }

  private _stripIdentityScope(
    document: IdentityScopedDocument,
  ): StoredDocument {
    const { [IDENTITY_SCOPE_FIELD]: _identityKey, ...rest } = document;
    return rest as StoredDocument;
  }

  private _visibleDocumentInScope(
    tableName: TableName | undefined,
    document: IdentityScopedDocument,
  ): StoredDocument | null {
    return this._isVisibleInScope(tableName, document)
      ? this._stripIdentityScope(document)
      : null;
  }

  private _getPendingTableState(tableName: string): PendingTableState {
    const cached = this._pendingTableState.get(tableName);
    if (cached) {
      return cached;
    }

    const shadowedIds = new Set<string>();
    const rawVisibleDocs = new Map<string, IdentityScopedDocument>();
    for (let level = this._writes.length - 1; level >= 0; level -= 1) {
      const ids = this._writeTables[level]?.get(tableName);
      if (!ids) {
        continue;
      }

      for (const id of ids) {
        if (shadowedIds.has(id)) {
          continue;
        }
        shadowedIds.add(id);

        const document = this._writes[level]?.[id as DocumentId] as
          | IdentityScopedDocument
          | null
          | undefined;
        if (document !== undefined && document !== null) {
          rawVisibleDocs.set(id, document);
        }
      }
    }

    const state: PendingTableState = {
      shadowedIds,
      rawVisibleDocs,
      mergedIndexes: new Map(),
      vectorOverlays: new Map(),
      searchOverlays: new Map(),
    };
    this._pendingTableState.set(tableName, state);
    return state;
  }

  private _getVisiblePendingDocs(tableName: string): Array<{
    doc: StoredDocument;
    identityKey: string | null;
  }> {
    const pending = this._getPendingTableState(tableName);
    if (pending.visiblePendingDocs) {
      return pending.visiblePendingDocs;
    }

    const docs: Array<{ doc: StoredDocument; identityKey: string | null }> = [];
    for (const document of pending.rawVisibleDocs.values()) {
      const visible = this._visibleDocumentInScope(tableName, document);
      if (visible !== null) {
        docs.push({
          doc: visible,
          identityKey: document[IDENTITY_SCOPE_FIELD] ?? null,
        });
      }
    }
    pending.visiblePendingDocs = docs;
    return docs;
  }

  private _addCommittedIdToTable(tableName: string, id: string): void {
    let ids = this._tableDocuments.get(tableName);
    if (!ids) {
      ids = new Set();
      this._tableDocuments.set(tableName, ids);
    }
    ids.add(id);
  }

  private _removeCommittedIdFromTable(tableName: string, id: string): void {
    const ids = this._tableDocuments.get(tableName);
    if (!ids) {
      return;
    }
    ids.delete(id);
    if (ids.size === 0) {
      this._tableDocuments.delete(tableName);
    }
  }

  private _readOptimizedSource(
    source: SerializedQuery["source"],
    limit?: number | null,
  ): {
    results: StoredDocument[];
    fieldPathsToSortBy: string[];
    order: "asc" | "desc";
  } | null {
    if (source.type === "FullTableScan") {
      const indexName =
        source.order === "desc" ? "by_creation_time_desc" : "by_creation_time";
      if (this._hasPendingWritesForTable(source.tableName)) {
        return {
          results: this._getMergedIndexedDocuments(source.tableName, indexName),
          fieldPathsToSortBy: [],
          order: source.order ?? "asc",
        };
      }
      return {
        results: this.getIndexedDocuments(source.tableName, indexName),
        fieldPathsToSortBy: [],
        order: source.order ?? "asc",
      };
    }

    if (source.type === "IndexRange") {
      const [tableName, indexName] = source.indexName.split(".");
      const orderedDocs = this.getIndexedDocuments(tableName, indexName);
      const fields = this._getIndexDefinitions(tableName).find(
        (entry) => entry.indexName === indexName,
      )?.fields;

      if (!fields) {
        throw new Error(
          `Cannot use index "${indexName}" for table "${tableName}" because it is not declared in the schema.`,
        );
      }

      const lower = this._buildRangeBound([...source.range], fields, "lower");
      const upper = this._buildRangeBound([...source.range], fields, "upper");
      const predicate = this._buildRangePredicate(source.range);
      if (this._hasPendingWritesForTable(tableName) && source.order === "asc") {
        return {
          results: this._collectMergedIndexRangeDocs(
            tableName,
            indexName,
            [],
            null,
            fields,
            lower,
            upper,
            predicate,
          ),
          fieldPathsToSortBy: [],
          order: "asc",
        };
      }

      const sourceDocs = this._hasPendingWritesForTable(tableName)
        ? this._getMergedIndexedDocuments(tableName, indexName)
        : orderedDocs;
      const start = lower
        ? this._binarySearchLowerBound(sourceDocs, fields, lower)
        : 0;
      const end = upper
        ? this._binarySearchUpperBound(sourceDocs, fields, upper)
        : sourceDocs.length;
      const filteredDocs = sourceDocs.slice(start, end).filter(predicate);
      return {
        results:
          source.order === "desc" ? [...filteredDocs].reverse() : filteredDocs,
        fieldPathsToSortBy: [],
        order: "asc",
      };
    }

    if (source.type === "Search") {
      const [tableName, indexName] = source.indexName.split(".");
      const state = this._searchIndexes.get(`${tableName}.${indexName}`);
      if (!state) {
        return null;
      }

      if (this._hasPendingWritesForTable(tableName)) {
        return {
          results: executeOverlaySearch(
            state,
            this._buildPendingSearchOverlay(tableName, state),
            {
              source,
              activeIdentityKey: this._activeIdentityKey,
              limit: limit ?? undefined,
            },
          ),
          fieldPathsToSortBy: [],
          order: "asc",
        };
      }

      return {
        results: executeSearch(state, {
          source,
          activeIdentityKey: this._activeIdentityKey,
          limit: limit ?? undefined,
        }),
        fieldPathsToSortBy: [],
        order: "asc",
      };
    }

    return null;
  }

  private _readOptimizedQuery(
    query: SerializedQuery,
  ): Array<GenericDocument> | null {
    const { filters, limit } = this._extractNormalizedOperators(
      query.operators,
    );

    if (query.source.type === "FullTableScan") {
      const indexName =
        query.source.order === "desc"
          ? "by_creation_time_desc"
          : "by_creation_time";
      if (this._hasPendingWritesForTable(query.source.tableName)) {
        return this._collectMergedIndexDocs(
          query.source.tableName,
          indexName,
          filters,
          limit,
        );
      }

      const docs = this.getIndexedDocuments(query.source.tableName, indexName);
      return this._filterOrderedDocs(docs, filters, limit);
    }

    if (query.source.type === "IndexRange") {
      const [tableName, indexName] = query.source.indexName.split(".");
      const fields = this._getIndexDefinitions(tableName).find(
        (entry) => entry.indexName === indexName,
      )?.fields;
      if (!fields) {
        return null;
      }

      const lower = this._buildRangeBound(
        [...query.source.range],
        fields,
        "lower",
      );
      const upper = this._buildRangeBound(
        [...query.source.range],
        fields,
        "upper",
      );
      const predicate = this._buildRangePredicate(query.source.range);
      if (
        this._hasPendingWritesForTable(tableName) &&
        query.source.order === "asc"
      ) {
        return this._collectMergedIndexRangeDocs(
          tableName,
          indexName,
          filters,
          limit,
          fields,
          lower,
          upper,
          predicate,
        );
      }

      const docs = this._hasPendingWritesForTable(tableName)
        ? this._getMergedIndexedDocuments(tableName, indexName)
        : this.getIndexedDocuments(tableName, indexName);
      const start = lower
        ? this._binarySearchLowerBound(docs, fields, lower)
        : 0;
      const end = upper
        ? this._binarySearchUpperBound(docs, fields, upper)
        : docs.length;

      return this._filterOrderedDocs(
        docs.slice(start, end),
        filters,
        limit,
        predicate,
        query.source.order ?? undefined,
      );
    }

    return null;
  }

  private _extractNormalizedOperators(
    operators: SerializedQuery["operators"],
  ): {
    filters: FilterNode[];
    limit: number | null;
  } {
    const filters: FilterNode[] = [];
    let limit: number | null = null;

    for (const operator of operators) {
      if ("filter" in operator) {
        filters.push(normalizeFilter(operator.filter));
        continue;
      }
      if (limit === null && "limit" in operator) {
        limit = operator.limit;
      }
    }

    return { filters, limit };
  }

  private _filterOrderedDocs(
    docs: StoredDocument[],
    filters: FilterNode[],
    limit: number | null,
    predicate: (doc: StoredDocument) => boolean = () => true,
    order: "asc" | "desc" = "asc",
  ): StoredDocument[] {
    const results: StoredDocument[] = [];
    const iterate = order === "desc" ? [...docs].reverse() : docs;

    for (const doc of iterate) {
      if (!predicate(doc)) {
        continue;
      }
      if (
        filters.length > 0 &&
        !filters.every((filter) => evaluateNormalizedFilter(doc, filter))
      ) {
        continue;
      }
      results.push(doc);
      if (limit !== null && results.length >= limit) {
        break;
      }
    }

    return results;
  }

  private _collectMergedIndexDocs(
    tableName: string,
    indexName: string,
    filters: FilterNode[],
    limit: number | null,
  ): StoredDocument[] {
    const indexDefinition = this._getIndexDefinitions(tableName).find(
      (entry) => entry.indexName === indexName,
    );
    if (!indexDefinition) {
      throw new Error(
        `Cannot use index "${indexName}" for table "${tableName}" because it is not declared in the schema.`,
      );
    }

    const pendingState = this._getPendingTableState(tableName);
    const pendingDocs = this._getVisiblePendingDocs(tableName)
      .map(({ doc }) => doc)
      .sort((left, right) =>
        this._compareDocsForIndex(
          indexName,
          indexDefinition.fields,
          left,
          right,
        ),
      );
    const committedIds =
      this._indexDocuments.get(`${tableName}.${indexName}`) ?? [];
    const results: StoredDocument[] = [];

    let committedIndex = 0;
    let pendingIndex = 0;

    const nextCommittedDoc = (): StoredDocument | null => {
      while (committedIndex < committedIds.length) {
        const id = committedIds[committedIndex++]!;
        if (pendingState.shadowedIds.has(id)) {
          continue;
        }
        const raw = this._documents[id as DocumentId] as
          | IdentityScopedDocument
          | undefined;
        const visible =
          raw === undefined
            ? null
            : this._visibleDocumentInScope(this._idTableMap.get(id), raw);
        if (visible !== null) {
          return visible;
        }
      }
      return null;
    };

    const maybePush = (doc: StoredDocument): boolean => {
      if (
        filters.length > 0 &&
        !filters.every((filter) => evaluateNormalizedFilter(doc, filter))
      ) {
        return false;
      }
      results.push(doc);
      return limit !== null && results.length >= limit;
    };

    let committedDoc = nextCommittedDoc();
    while (committedDoc !== null && pendingIndex < pendingDocs.length) {
      const nextDoc =
        this._compareDocsForIndex(
          indexName,
          indexDefinition.fields,
          committedDoc,
          pendingDocs[pendingIndex]!,
        ) <= 0
          ? (() => {
              const doc = committedDoc!;
              committedDoc = nextCommittedDoc();
              return doc;
            })()
          : pendingDocs[pendingIndex++]!;

      if (maybePush(nextDoc)) {
        return results;
      }
    }

    while (committedDoc !== null) {
      if (maybePush(committedDoc)) {
        return results;
      }
      committedDoc = nextCommittedDoc();
    }
    while (pendingIndex < pendingDocs.length) {
      if (maybePush(pendingDocs[pendingIndex]!)) {
        return results;
      }
      pendingIndex += 1;
    }

    return results;
  }

  private _collectMergedIndexRangeDocs(
    tableName: string,
    indexName: string,
    filters: FilterNode[],
    limit: number | null,
    fields: string[],
    lower: { values: Array<Value | undefined>; inclusive: boolean } | null,
    upper: { values: Array<Value | undefined>; inclusive: boolean } | null,
    predicate: (doc: StoredDocument) => boolean,
  ): StoredDocument[] {
    const pendingState = this._getPendingTableState(tableName);
    const pendingDocs = this._getVisiblePendingDocs(tableName)
      .map(({ doc }) => doc)
      .sort((left, right) =>
        this._compareDocsForIndex(indexName, fields, left, right),
      );
    const committedIds =
      this._indexDocuments.get(`${tableName}.${indexName}`) ?? [];
    const results: StoredDocument[] = [];
    let committedIndex = 0;
    let pendingIndex = 0;

    const compareBounds = (doc: StoredDocument): boolean => {
      if (lower !== null && this._compareDocToBound(doc, fields, lower) < 0) {
        return false;
      }
      if (upper !== null && this._compareDocToBound(doc, fields, upper) >= 0) {
        return false;
      }
      return true;
    };

    const nextCommittedDoc = (): StoredDocument | null => {
      while (committedIndex < committedIds.length) {
        const id = committedIds[committedIndex++]!;
        if (pendingState.shadowedIds.has(id)) {
          continue;
        }
        const raw = this._documents[id as DocumentId] as
          | IdentityScopedDocument
          | undefined;
        const visible =
          raw === undefined
            ? null
            : this._visibleDocumentInScope(this._idTableMap.get(id), raw);
        if (visible !== null) {
          return visible;
        }
      }
      return null;
    };

    const maybePush = (doc: StoredDocument): boolean => {
      if (!compareBounds(doc) || !predicate(doc)) {
        return false;
      }
      if (
        filters.length > 0 &&
        !filters.every((filter) => evaluateNormalizedFilter(doc, filter))
      ) {
        return false;
      }
      results.push(doc);
      return limit !== null && results.length >= limit;
    };

    let committedDoc = nextCommittedDoc();
    while (committedDoc !== null && pendingIndex < pendingDocs.length) {
      const nextDoc =
        this._compareDocsForIndex(
          indexName,
          fields,
          committedDoc,
          pendingDocs[pendingIndex]!,
        ) <= 0
          ? (() => {
              const doc = committedDoc!;
              committedDoc = nextCommittedDoc();
              return doc;
            })()
          : pendingDocs[pendingIndex++]!;
      if (maybePush(nextDoc)) {
        return results;
      }
    }

    while (committedDoc !== null) {
      if (maybePush(committedDoc)) {
        return results;
      }
      committedDoc = nextCommittedDoc();
    }
    while (pendingIndex < pendingDocs.length) {
      if (maybePush(pendingDocs[pendingIndex]!)) {
        return results;
      }
      pendingIndex += 1;
    }

    return results;
  }

  private _buildPendingVectorOverlay(
    tableName: string,
    baseState: VectorIndexState,
  ): VectorOverlayState {
    const pendingState = this._getPendingTableState(tableName);
    const key = baseState.definition.indexDescriptor;
    const cached = pendingState.vectorOverlays.get(key);
    if (cached) {
      return cached;
    }

    const overlay: VectorOverlayState = {
      shadowedIds: pendingState.shadowedIds,
      state: buildVectorIndexState({
        docs: this._getVisiblePendingDocs(tableName),
        definition: baseState.definition,
      }),
    };
    pendingState.vectorOverlays.set(key, overlay);
    return overlay;
  }

  private _buildPendingSearchOverlay(
    tableName: string,
    baseState: SearchIndexState,
  ): SearchOverlayState {
    const pendingState = this._getPendingTableState(tableName);
    const key = baseState.definition.indexDescriptor;
    const cached = pendingState.searchOverlays.get(key);
    if (cached) {
      return cached;
    }

    const overlay: SearchOverlayState = {
      shadowedIds: pendingState.shadowedIds,
      state: buildSearchIndexState({
        docs: this._getVisiblePendingDocs(tableName),
        definition: baseState.definition,
      }),
    };
    pendingState.searchOverlays.set(key, overlay);
    return overlay;
  }

  private _getMergedIndexedDocuments(
    tableName: string,
    indexName: string,
  ): StoredDocument[] {
    const pendingState = this._getPendingTableState(tableName);
    const cached = pendingState.mergedIndexes.get(indexName);
    if (cached) {
      return cached;
    }

    const committedIds =
      this._indexDocuments.get(`${tableName}.${indexName}`) ?? [];
    const indexDefinition = this._getIndexDefinitions(tableName).find(
      (entry) => entry.indexName === indexName,
    );

    if (!indexDefinition) {
      throw new Error(
        `Cannot use index "${indexName}" for table "${tableName}" because it is not declared in the schema.`,
      );
    }

    const pendingDocs = this._getVisiblePendingDocs(tableName)
      .map(({ doc }) => doc)
      .sort((left, right) =>
        this._compareDocsForIndex(
          indexName,
          indexDefinition.fields,
          left,
          right,
        ),
      );

    const merged = this._mergeCommittedIdsAndPendingDocs(
      committedIds,
      pendingDocs,
      pendingState.shadowedIds,
      (left, right) =>
        this._compareDocsForIndex(
          indexName,
          indexDefinition.fields,
          left,
          right,
        ),
    );
    pendingState.mergedIndexes.set(indexName, merged);
    return merged;
  }

  private _mergeCommittedIdsAndPendingDocs(
    leftIds: string[],
    rightDocs: StoredDocument[],
    shadowedIds: Set<string>,
    compare: (left: StoredDocument, right: StoredDocument) => number,
  ): StoredDocument[] {
    const merged: StoredDocument[] = [];
    let leftIndex = 0;
    let rightIndex = 0;

    const nextLeftDoc = (): StoredDocument | null => {
      while (leftIndex < leftIds.length) {
        const id = leftIds[leftIndex++]!;
        if (shadowedIds.has(id)) {
          continue;
        }
        const raw = this._documents[id as DocumentId] as
          | IdentityScopedDocument
          | undefined;
        const visible =
          raw === undefined
            ? null
            : this._visibleDocumentInScope(this._idTableMap.get(id), raw);
        if (visible !== null) {
          return visible;
        }
      }
      return null;
    };

    let leftDoc = nextLeftDoc();

    while (leftDoc !== null && rightIndex < rightDocs.length) {
      if (compare(leftDoc, rightDocs[rightIndex]!) <= 0) {
        merged.push(leftDoc);
        leftDoc = nextLeftDoc();
      } else {
        merged.push(rightDocs[rightIndex]!);
        rightIndex += 1;
      }
    }

    while (leftDoc !== null) {
      merged.push(leftDoc);
      leftDoc = nextLeftDoc();
    }
    while (rightIndex < rightDocs.length) {
      merged.push(rightDocs[rightIndex]!);
      rightIndex += 1;
    }

    return merged;
  }

  private _rebuildAllIndexes(): void {
    this._indexDocuments.clear();
    for (const tableName of this._tableDocuments.keys()) {
      this._rebuildTableIndexes(tableName);
    }
  }

  private _rebuildAllSearchIndexes(): void {
    this._searchIndexes.clear();
    for (const tableName of this._tableDocuments.keys()) {
      this._rebuildTableSearchIndexes(tableName);
    }
  }

  private _rebuildAllVectorIndexes(): void {
    this._vectorIndexes.clear();
    for (const tableName of this._tableDocuments.keys()) {
      this._rebuildTableVectorIndexes(tableName);
    }
  }

  private _rebuildTableIndexes(tableName: string): void {
    const committedDocs = [...(this._tableDocuments.get(tableName) ?? [])]
      .map((id) => this._documents[id as DocumentId])
      .filter((doc): doc is StoredDocument => doc !== undefined);

    for (const { indexName, fields } of this._getIndexDefinitions(tableName)) {
      const sorted = [...committedDocs].sort((left, right) =>
        this._compareDocsForIndex(indexName, fields, left, right),
      );

      this._indexDocuments.set(
        `${tableName}.${indexName}`,
        sorted.map((doc) => doc._id as string),
      );
    }
  }

  private _rebuildTableSearchIndexes(tableName: string): void {
    const searchIndexes =
      this._schema?.tables.get(tableName)?.searchIndexes ?? [];
    for (const key of this._searchIndexes.keys()) {
      if (key.startsWith(`${tableName}.`)) {
        this._searchIndexes.delete(key);
      }
    }
    const rawDocs = [...(this._tableDocuments.get(tableName) ?? [])]
      .map(
        (id) =>
          this._documents[id as DocumentId] as
            | IdentityScopedDocument
            | undefined,
      )
      .filter((doc): doc is IdentityScopedDocument => doc !== undefined);

    for (const definition of searchIndexes) {
      this._searchIndexes.set(
        `${tableName}.${definition.indexDescriptor}`,
        buildSearchIndexState({
          docs: rawDocs.map((doc) => ({
            doc: this._stripIdentityScope(doc),
            identityKey: doc[IDENTITY_SCOPE_FIELD] ?? null,
          })),
          definition: resolveSearchIndexDefinition(
            searchIndexes,
            tableName,
            definition.indexDescriptor,
          ),
        }),
      );
    }
  }

  private _rebuildTableVectorIndexes(tableName: string): void {
    const vectorIndexes =
      this._schema?.tables.get(tableName)?.vectorIndexes ?? [];
    for (const key of this._vectorIndexes.keys()) {
      if (key.startsWith(`${tableName}.`)) {
        this._vectorIndexes.delete(key);
      }
    }
    const rawDocs = [...(this._tableDocuments.get(tableName) ?? [])]
      .map(
        (id) =>
          this._documents[id as DocumentId] as
            | IdentityScopedDocument
            | undefined,
      )
      .filter((doc): doc is IdentityScopedDocument => doc !== undefined);

    for (const definition of vectorIndexes) {
      this._vectorIndexes.set(
        `${tableName}.${definition.indexDescriptor}`,
        buildVectorIndexState({
          docs: rawDocs.map((doc) => ({
            doc: this._stripIdentityScope(doc),
            identityKey: doc[IDENTITY_SCOPE_FIELD] ?? null,
          })),
          definition: resolveVectorIndexDefinition(
            vectorIndexes,
            tableName,
            definition.indexDescriptor,
          ),
        }),
      );
    }
  }

  private _applyCommittedStateChanges(changes: CommittedStateChange[]): void {
    const changesByTable = new Map<string, CommittedStateChange[]>();
    for (const change of changes) {
      let tableChanges = changesByTable.get(change.tableName);
      if (!tableChanges) {
        tableChanges = [];
        changesByTable.set(change.tableName, tableChanges);
      }
      tableChanges.push(change);
    }

    for (const [tableName, tableChanges] of changesByTable) {
      const committedCount = this.getCommittedTableCount(tableName);
      const hasCommittedState = this._indexDocuments.has(
        `${tableName}.by_creation_time`,
      );
      const shouldRebuild =
        !hasCommittedState ||
        tableChanges.length > Math.max(32, committedCount >> 3);

      if (shouldRebuild) {
        this._rebuildTableIndexes(tableName);
        this._rebuildTableSearchIndexes(tableName);
        this._rebuildTableVectorIndexes(tableName);
        continue;
      }

      this._applyIncrementalIndexChanges(tableName, tableChanges);
      this._applyIncrementalSearchChanges(tableName, tableChanges);
      this._applyIncrementalVectorChanges(tableName, tableChanges);
    }
  }

  private _applyIncrementalIndexChanges(
    tableName: string,
    changes: CommittedStateChange[],
  ): void {
    for (const { indexName, fields } of this._getIndexDefinitions(tableName)) {
      const key = `${tableName}.${indexName}`;
      const ids = this._indexDocuments.get(key);
      if (!ids) {
        continue;
      }

      for (const change of changes) {
        if (change.before !== null) {
          const position = ids.indexOf(change.id as string);
          if (position !== -1) {
            ids.splice(position, 1);
          }
        }
      }

      for (const change of changes) {
        if (change.after === null) {
          continue;
        }
        const insertAt = this._binarySearchIndexInsertPosition(
          ids,
          indexName,
          fields,
          change.after,
        );
        ids.splice(insertAt, 0, change.id as string);
      }
    }
  }

  private _applyIncrementalVectorChanges(
    tableName: string,
    changes: CommittedStateChange[],
  ): void {
    const vectorIndexes =
      this._schema?.tables.get(tableName)?.vectorIndexes ?? [];
    for (const definition of vectorIndexes) {
      const state = this._vectorIndexes.get(
        `${tableName}.${definition.indexDescriptor}`,
      );
      if (!state) {
        continue;
      }

      for (const change of changes) {
        removeDocumentFromVectorIndexState(state, change.id as string);
      }
      for (const change of changes) {
        if (change.after !== null) {
          addDocumentToVectorIndexState(state, {
            doc: this._stripIdentityScope(change.after),
            identityKey: change.after[IDENTITY_SCOPE_FIELD] ?? null,
          });
        }
      }
    }
  }

  private _applyIncrementalSearchChanges(
    tableName: string,
    changes: CommittedStateChange[],
  ): void {
    const searchIndexes =
      this._schema?.tables.get(tableName)?.searchIndexes ?? [];
    for (const definition of searchIndexes) {
      const state = this._searchIndexes.get(
        `${tableName}.${definition.indexDescriptor}`,
      );
      if (!state) {
        continue;
      }

      for (const change of changes) {
        removeDocumentFromSearchIndexState(state, change.id as string);
      }
      for (const change of changes) {
        if (change.after !== null) {
          addDocumentToSearchIndexState(state, {
            doc: this._stripIdentityScope(change.after),
            identityKey: change.after[IDENTITY_SCOPE_FIELD] ?? null,
          });
        }
      }
    }
  }

  private _compareDocsForIndex(
    indexName: string,
    fields: string[],
    left: StoredDocument,
    right: StoredDocument,
  ): number {
    for (const field of fields) {
      const comparison = compareValues(
        evaluateFieldPath(field, left),
        evaluateFieldPath(field, right),
      );
      if (comparison !== 0) {
        return indexName === "by_creation_time_desc" ? -comparison : comparison;
      }
    }
    return 0;
  }

  private _binarySearchIndexInsertPosition(
    ids: string[],
    indexName: string,
    fields: string[],
    target: StoredDocument,
  ): number {
    let low = 0;
    let high = ids.length;

    while (low < high) {
      const mid = (low + high) >> 1;
      const current = this._documents[ids[mid] as DocumentId];
      if (current === undefined) {
        ids.splice(mid, 1);
        high = ids.length;
        continue;
      }
      const comparison = this._compareDocsForIndex(
        indexName,
        fields,
        current,
        target,
      );
      if (comparison <= 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    return low;
  }

  private _getIndexDefinitions(
    tableName: string,
  ): Array<{ indexName: string; fields: string[] }> {
    const schemaIndexes =
      this._schema?.tables.get(tableName)?.indexes.map((index) => ({
        indexName: index.indexDescriptor,
        fields: [...index.fields, "_creationTime", "_id"],
      })) ?? [];
    const systemIndexes = SYSTEM_INDEX_DEFINITIONS[tableName] ?? [];

    return [
      { indexName: "by_creation_time", fields: ["_creationTime", "_id"] },
      { indexName: "by_creation_time_desc", fields: ["_creationTime", "_id"] },
      { indexName: "by_id", fields: ["_id"] },
      ...systemIndexes,
      ...schemaIndexes,
    ];
  }

  private _hasPendingWrites(): boolean {
    return this._pendingWriteCount > 0;
  }

  private _hasPendingWritesForTable(tableName: string): boolean {
    if (!this._hasPendingWrites()) {
      return false;
    }

    return this._writeTables.some((tables) => tables.has(tableName));
  }

  private _buildRangePredicate(
    range: ReadonlyArray<{
      type: "Eq" | "Gt" | "Gte" | "Lt" | "Lte";
      fieldPath: string;
      value: JSONValue;
    }>,
  ): (doc: StoredDocument) => boolean {
    if (range.length === 0) {
      return () => true;
    }

    const filters = range.map((filter) => ({
      ...filter,
      evaluatedValue: evaluateValue(filter.value),
    }));

    return (doc) => {
      for (const filter of filters) {
        const result = evaluateFieldPath(filter.fieldPath, doc);
        if (
          (filter.type === "Eq" &&
            compareValues(result, filter.evaluatedValue) !== 0) ||
          (filter.type === "Gt" &&
            compareValues(result, filter.evaluatedValue) <= 0) ||
          (filter.type === "Gte" &&
            compareValues(result, filter.evaluatedValue) < 0) ||
          (filter.type === "Lt" &&
            compareValues(result, filter.evaluatedValue) >= 0) ||
          (filter.type === "Lte" &&
            compareValues(result, filter.evaluatedValue) > 0)
        ) {
          return false;
        }
      }
      return true;
    };
  }

  private _buildRangeBound(
    range: SerializedRangeExpression[],
    fields: string[],
    side: "lower" | "upper",
  ): { values: Array<Value | undefined>; inclusive: boolean } | null {
    const values: Array<Value | undefined> = [];
    let inclusive = true;

    for (const expression of range) {
      const fieldIndex = fields.indexOf(expression.fieldPath);
      if (fieldIndex === -1) {
        continue;
      }
      const value = evaluateValue(expression.value);
      if (expression.type === "Eq") {
        values[fieldIndex] = value;
        continue;
      }
      if (
        side === "lower" &&
        (expression.type === "Gt" || expression.type === "Gte")
      ) {
        values[fieldIndex] = value;
        inclusive = expression.type === "Gte";
      }
      if (
        side === "upper" &&
        (expression.type === "Lt" || expression.type === "Lte")
      ) {
        values[fieldIndex] = value;
        inclusive = expression.type === "Lte";
      }
    }

    return values.length === 0 ? null : { values, inclusive };
  }

  private _compareDocToBound(
    doc: StoredDocument,
    fields: string[],
    bound: { values: Array<Value | undefined> },
  ): number {
    for (let index = 0; index < bound.values.length; index++) {
      const comparison = compareValues(
        evaluateFieldPath(fields[index]!, doc),
        bound.values[index],
      );
      if (comparison !== 0) {
        return comparison;
      }
    }
    return 0;
  }

  private _binarySearchLowerBound(
    docs: StoredDocument[],
    fields: string[],
    bound: { values: Array<Value | undefined>; inclusive: boolean },
  ): number {
    let low = 0;
    let high = docs.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const comparison = this._compareDocToBound(docs[mid]!, fields, bound);
      const moveRight = bound.inclusive ? comparison < 0 : comparison <= 0;
      if (moveRight) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  private _binarySearchUpperBound(
    docs: StoredDocument[],
    fields: string[],
    bound: { values: Array<Value | undefined>; inclusive: boolean },
  ): number {
    let low = 0;
    let high = docs.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const comparison = this._compareDocToBound(docs[mid]!, fields, bound);
      const keepLeft = bound.inclusive ? comparison > 0 : comparison >= 0;
      if (keepLeft) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    return low;
  }
}
