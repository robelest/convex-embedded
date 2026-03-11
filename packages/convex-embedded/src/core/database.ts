import { Fx } from "@robelest/fx";
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
import type { GenericDocument } from "convex/server";
import type { JSONValue, Value } from "convex/values";
import { jsonToConvex } from "convex/values";

import { QueryEngine } from "@/core/query-engine";
import type { DocumentIterator } from "@/core/query-engine";
import type { ParsedSchema } from "@/core/schema";
import {
  validateValidator,
  validateSchemaDefinition,
} from "@/core/schema";
import type {
  DocumentId,
  QueryId,
  SerializedQuery,
  SerializedRangeExpression,
  StoredDocument,
  TableName,
  Timestamp,
} from "@/core/types";
import type { StorageAdapter } from "@/storage/adapter";

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

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export class Database {
  // ---- Persistent state ---------------------------------------------------

  /** Committed documents keyed by `DocumentId`. */
  private _documents: Record<DocumentId, StoredDocument> = {};

  /** Blob storage keyed by `_storage` document ID. */
  private _blobStorage: Record<DocumentId, Blob> = {};

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

  // ---- Query engine -------------------------------------------------------

  readonly queryEngine: QueryEngine;

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  constructor(schema: ParsedSchema | null, storage?: StorageAdapter) {
    this._schema = schema;
    this._storage = storage ?? null;

    if (schema !== null) {
      validateSchemaDefinition(schema);
    }

    // Build document iterator bound to this database instance.
    const iterateDocs: DocumentIterator = (tableName, callback) => {
      this._iterateDocs(tableName, callback);
    };

    this.queryEngine = new QueryEngine(schema, iterateDocs);
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
      }
    }

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
    for (const id of Object.keys(this._documents)) {
      if (this._idTableMap.get(id) === tableName) {
        delete this._documents[id as DocumentId];
        this._idTableMap.delete(id);
      }
    }

    // Replace with what's in storage and rebuild map entries.
    for (const doc of docs) {
      this._documents[doc._id] = doc;
      this._idTableMap.set(doc._id as string, tableName);
    }

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
  commit(): { timestamp: Timestamp; tablesWritten: Set<string> } {
    const lastWrites = this._writes.pop();
    if (lastWrites === undefined) {
      throw new Error("Transaction already committed or rolled back");
    }

    // Track which tables are affected by this commit level.
    for (const id of Object.keys(lastWrites)) {
      const table = this._idTableMap.get(id);
      if (table !== undefined) {
        this._tablesWritten.add(table);
      }
    }

    if (this._writes.length === 0) {
      // Outermost commit — apply writes to in-memory storage.
      const puts: Array<{ doc: StoredDocument; tableName: string }> = [];
      const deletes: string[] = [];

      for (const [id, write] of Object.entries(lastWrites)) {
        const _id = id as DocumentId;
        if (write === null) {
          delete this._documents[_id];
          deletes.push(id);
        } else {
          this._documents[_id] = write;
          const table = this._idTableMap.get(id) ?? "";
          puts.push({ doc: write, tableName: table });
        }
      }

      // Bump timestamp only if there were actual writes.
      const tablesWritten = new Set(this._tablesWritten);
      if (tablesWritten.size > 0) {
        this._timestamp += 1;
      }
      this._tablesWritten.clear();

      // Persist to durable storage (fire-and-forget).
      if (this._storage !== null && (puts.length > 0 || deletes.length > 0)) {
        const storage = this._storage;
        Fx.detach(
          () =>
            storage.commit({
              puts,
              deletes,
              meta: {
                timestamp: this._timestamp,
                lastCreationTime: this._lastCreationTime,
              },
            }),
          "[convex-embedded] storage commit failed:",
        );
      }

      return { timestamp: this._timestamp, tablesWritten };
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
    };
  }

  /** Discard the deepest pending write level. */
  rollbackWrites(): void {
    if (this._writes.length === 0) {
      throw new Error("Transaction already committed or rolled back");
    }
    this._writes.pop();
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

    let hasPendingWrite = false;
    let document: StoredDocument | null = null;

    for (let i = this._writes.length - 1; i >= 0; i--) {
      const write = this._writes[i][id];
      if (write !== undefined) {
        hasPendingWrite = true;
        document = write;
        break;
      }
    }

    if (!hasPendingWrite) {
      document = this._documents[id] ?? null;
    }

    return document;
  }

  /** Insert a new document. Returns the generated UUID `_id`. */
  insert(table: TableName, value: Record<string, unknown>): DocumentId {
    this._validate(table, value as GenericDocument);
    const _id = crypto.randomUUID() as unknown as DocumentId;
    this._idTableMap.set(_id as string, table);
    const now = Date.now();
    const _creationTime =
      now <= this._lastCreationTime ? this._lastCreationTime + 0.001 : now;
    this._lastCreationTime = _creationTime;
    this._addWrite(_id, { ...value, _id, _creationTime });
    return _id;
  }

  /** Merge `value` into an existing document (like `Object.assign`). */
  patch(
    tableName: TableName | undefined,
    id: DocumentId,
    value: Record<string, unknown>,
  ): void {
    if (!this._validateId(tableName, id)) {
      throw new Error(`Patch on non-existent document with ID "${id}"`);
    }

    if (typeof value !== "object" || value === null) {
      throw new Error(
        `Invalid argument \`value\` in \`db.patch\`, expected object but got '${typeof value}': ${String(value)}`,
      );
    }

    const document = this.get(tableName, id);
    if (document === null) {
      throw new Error(`Patch on non-existent document with ID "${id}"`);
    }

    const { _id, _creationTime, ...fields } = document;

    if (value._id !== undefined && value._id !== _id) {
      throw new Error(
        `Provided \`_id\` field value "${value._id}" ` +
          `does not match the document ID "${_id}"`,
      );
    }
    if (
      value._creationTime !== undefined &&
      value._creationTime !== _creationTime
    ) {
      throw new Error(
        `Provided \`_creationTime\` field value ${value._creationTime} ` +
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
    this._validate(this._idTableMap.get(_id as string)!, merged as GenericDocument);
    this._addWrite(id, { _id, _creationTime, ...merged });
  }

  /** Replace all user fields of an existing document. */
  replace(
    tableName: TableName | undefined,
    id: DocumentId,
    value: Record<string, unknown>,
  ): void {
    if (!this._validateId(tableName, id)) {
      throw new Error(`Replace on non-existent document with ID "${id}"`);
    }

    if (typeof value !== "object" || value === null) {
      throw new Error(
        `Invalid argument \`value\` in \`db.replace\`, expected object but got '${typeof value}': ${String(value)}`,
      );
    }

    const document = this.get(tableName, id);
    if (document === null) {
      throw new Error(`Replace on non-existent document with ID "${id}"`);
    }

    if (value._id !== undefined && value._id !== document._id) {
      throw new Error(
        `Provided \`_id\` field value "${value._id}" ` +
          `does not match the document ID "${document._id}"`,
      );
    }
    if (
      value._creationTime !== undefined &&
      value._creationTime !== document._creationTime
    ) {
      throw new Error(
        `Provided \`_creationTime\` field value ${value._creationTime} ` +
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
    this._addWrite(id, {
      ...convexValue,
      _id: document._id,
      _creationTime: document._creationTime,
    });
  }

  /** Mark a document as deleted. */
  delete(tableName: TableName | undefined, id: DocumentId): void {
    if (!this._validateId(tableName, id)) {
      throw new Error("Delete on non-existent doc");
    }

    const document = this.get(tableName, id);
    if (document === null) {
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
      this._addWrite(docId, { _id: docId, _creationTime, ...userFields });
    } else {
      // New document — register in the ID table map.
      this._idTableMap.set(_id, table);

      // Track creation time for monotonicity.
      if (_creationTime > this._lastCreationTime) {
        this._lastCreationTime = _creationTime;
      }

      this._addWrite(docId, { _id: docId, _creationTime, ...userFields });
    }
  }

  /**
   * Remove a document by ID if it exists. Returns `true` if the document
   * was found and deleted, `false` if it was not present (no-op).
   *
   * Unlike {@link delete}, this method does **not** throw when the
   * document is missing — it silently returns `false`. This is useful
   * when syncing deletions from a remote source where the local state
   * may already be out of sync.
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

    const document = this.get(table, id);
    if (document === null) {
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

  vectorSearch(
    tableAndIndexName: string,
    vector: number[],
    expressions: SerializedRangeExpression[],
    limit: number,
  ): Array<{ _id: string; _score: number }> {
    return this.queryEngine.vectorSearch(
      tableAndIndexName,
      vector,
      expressions,
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
        `Invalid argument \`tableName\`, expected string but got '${typeof expectedTableName}': ${String(expectedTableName)}`,
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
    this._writes[this._writes.length - 1][id] = newValue;
  }

  /**
   * Low-level write into the current deepest transaction level.
   * Used during nested commit to merge child writes into the parent —
   * skips the "no transaction" check because the parent level exists.
   */
  private _addWriteRaw(id: DocumentId, newValue: StoredDocument | null): void {
    this._writes[this._writes.length - 1][id] = newValue;
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
    const isInTable = (id: string) => this._idTableMap.get(id) === tableName;

    // Collect all IDs that belong to the table (committed + staged).
    const ids = new Set(Object.keys(this._documents).filter(isInTable));
    for (let i = 0; i < this._writes.length; i++) {
      for (const id of Object.keys(this._writes[i]).filter(isInTable)) {
        ids.add(id);
      }
    }

    for (const id of ids) {
      const document = this.get(tableName, id as DocumentId);
      if (document !== null) {
        callback(document);
      }
    }
  }
}
