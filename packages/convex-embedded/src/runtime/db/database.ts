import type { JSONValue, Value } from "convex/values";
import { jsonToConvex } from "convex/values";

import {
  createAmbientCryptoProvider,
  type EmbeddedCryptoProvider,
} from "@/runtime/crypto";
import type { AsyncReadBackend } from "@/runtime/db/backend";
import { compareValues } from "@/runtime/db/compare";
import { evaluateFieldPath } from "@/runtime/db/fieldpath";
import { QueryEngine } from "@/runtime/db/query";
import {
  evaluateNormalizedFilter,
  normalizeFilter,
  type AsyncQueryReader,
  type AsyncSourceReader,
  type AsyncTableCountReader,
  type DocumentIterator,
  type FilterNode,
  type PaginateResult,
  type QueryReader,
  type SourceReader,
  type TableCountReader,
} from "@/runtime/db/query";
import type { ParsedSchema, SearchIndexDefinition } from "@/runtime/db/schema";
import {
  validateValidator,
  validateSchemaDefinition,
} from "@/runtime/db/schema";
import {
  addDocumentToSearchIndexState,
  buildSearchIndexState,
  executeSearch,
  executeOverlaySearch,
  deleteDocumentFromSearchIndexState,
  getSearchIndexDefinition,
  type SearchOverlayState,
  type SearchIndexState,
} from "@/runtime/db/search";
import { sourceTableName } from "@/runtime/db/sql";
import type { GenericDocument } from "@/runtime/db/types";
import type {
  DocumentId,
  QueryId,
  SeekBound,
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
  deleteDocumentFromVectorIndexState,
  getVectorIndexDefinition,
  type VectorOverlayState,
  type VectorIndexState,
} from "@/runtime/db/vector";
import { createStore } from "@/runtime/store";
import type { Store } from "@/runtime/store";
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
import { structuralEqual } from "@/shared/equals";
import { createLogger } from "@/shared/logger";
import type { ReadOptions, StorageAdapter } from "@/storage/adapter";
import type { CommitBatch } from "@/storage/adapter";
import { recordCounter } from "@/tracing/metrics";
import { withSpan, withSpanSync } from "@/tracing/spans";

const IDENTITY_SCOPE_FIELD = "__identityKey";
const log = createLogger("db");

type IdentityScopedDocument = StoredDocument & {
  [IDENTITY_SCOPE_FIELD]?: string | null;
};

type SourceEvaluationLike = {
  results: StoredDocument[];
  fieldPathsToSortBy: string[];
  order: "asc" | "desc";
  presorted: boolean;
};

type CommittedStateChange = {
  tableName: string;
  id: DocumentId;
  before: IdentityScopedDocument | null;
  after: IdentityScopedDocument | null;
};

type CommittedRowChange = {
  tableName: string;
  id: DocumentId;
  before: IdentityScopedDocument | null;
  after: IdentityScopedDocument | null;
  shouldMaterialize: boolean;
};

type CommittedWriteArtifacts = {
  puts: Array<{ doc: StoredDocument; tableName: string }>;
  deletes: Array<{ id: string; tableName: string }>;
  rowChanges: CommittedRowChange[];
  stateChanges: CommittedStateChange[];
  invalidation: CommitInvalidationBatch;
};

export interface CommitInvalidationBatch {
  tables: Set<string>;
  changes: Array<{
    tableName: string;
    before: StoredDocument | null;
    after: StoredDocument | null;
  }>;
}

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
  _resolve_pending_uploads: [
    {
      indexName: "by_identity_key_and_creation_time",
      fields: ["identityKey", "_creationTime", "_id"],
    },
    {
      indexName: "by_local_storage_id",
      fields: ["localStorageId", "_creationTime", "_id"],
    },
  ],
  _resolve_processors: [
    {
      indexName: "by_identity_key_and_processor_id",
      fields: ["identityKey", "processorId", "_creationTime", "_id"],
    },
  ],
  _resolve_collection_metadata: [
    {
      indexName: "by_identity_key_and_collection",
      fields: [
        "identityKey",
        "collection",
        "schemaVersion",
        "_creationTime",
        "_id",
      ],
    },
  ],
  _resolve_document_metadata: [
    {
      indexName: "by_identity_key_and_collection_and_doc_id",
      fields: [
        "identityKey",
        "collection",
        "docId",
        "schemaVersion",
        "_creationTime",
        "_id",
      ],
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

/**
 * Runtime system tables kept in memory. The store's push-down read path never
 * serves `_`-prefixed tables (see `store.ts` `isSystemTable`), so these must be
 * hydrated eagerly at open; user tables hydrate lazily / read from the store
 * directly. The `_search_*` / `_vector_*` / `_convex_sqlite_*` /
 * `_embedded_query_cache*` tables are storage-adapter-internal (never queried as
 * runtime tables) and are intentionally excluded. A completeness test guards
 * this list against the store/adapter system-table set.
 */
export const RUNTIME_SYSTEM_TABLES: readonly string[] = [
  ...Object.keys(SYSTEM_INDEX_DEFINITIONS),
  "_resolve_auth_state",
  "_scheduled_functions",
  "_storage",
];

export interface DatabaseCommitResult {
  timestamp: Timestamp;
  tablesWritten: Set<string>;
  invalidation: CommitInvalidationBatch;
  persisted: Promise<void>;
}

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

function splitIndexName(indexName: string): [string, string] {
  return indexName.split(".") as [string, string];
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

export class Database {
  /** Committed documents keyed by `DocumentId`. */
  private _documents = new Map<DocumentId, StoredDocument>();

  /** Blob storage keyed by `_storage` document ID. */
  private _blobStorage = new Map<DocumentId, Blob>();

  /** Committed document IDs grouped by table for faster per-table iteration. */
  private _tableDocuments: Map<string, Set<string>> = new Map();

  /** Committed index orderings keyed by `table.index`. */
  private _indexDocuments: Map<string, string[]> = new Map();
  private _indexDefsCache: Map<
    string,
    Array<{ indexName: string; fields: string[] }>
  > = new Map();

  /** Committed search index state keyed by `table.index`. */
  private _searchIndexes: Map<string, SearchIndexState> = new Map();

  /** Committed vector index state keyed by `table.index`. */
  private _vectorIndexes: Map<string, VectorIndexState> = new Map();

  /**
   * Maps each document UUID to its table name.
   * Populated on insert (when UUID is generated) and on hydrate/replicateTable
   * (derived from stored documents).
   */
  private _idTableMap: Map<string, string> = new Map();

  /** Last creation-time value emitted, used to guarantee monotonic times. */
  private _lastCreationTime: number = 0;

  /** Parsed schema definition (may be null if running schema-less). */
  private _schema: ParsedSchema | null;

  /** Active identity namespace for non-system tables. */
  private _activeIdentityKey: string | null = null;

  /**
   * Monotonically increasing timestamp. Incremented on every committed
   * transaction that contains at least one write. Consumers (e.g. the
   * subscription manager) use this to detect staleness.
   */
  private _timestamp: Timestamp = 0;

  private _tableVersion: Map<string, number> = new Map();

  getTableVersion(tableName: string): number {
    return this._tableVersion.get(tableName) ?? 0;
  }

  bumpTableVersions(tableNames: Iterable<string>): void {
    for (const tableName of tableNames) {
      this._tableVersion.set(
        tableName,
        (this._tableVersion.get(tableName) ?? 0) + 1,
      );
    }
  }

  /**
   * Tables that have been written (insert / patch / replace / delete)
   * in the *current* outermost transaction.  Accumulated across nested
   * child transactions when they commit up.
   */
  private _tablesWritten: Set<string> = new Set();

  /** Optional durable storage backend. */
  private _storage: StorageAdapter | null = null;
  private _fullyHydrated = false;
  private readonly _hydrationAttemptedTables = new Set<string>();
  private readonly _tableHydrationPromises = new Map<string, Promise<void>>();
  private readonly _tableHydrationResolvers = new Map<string, () => void>();

  private readonly _crypto: EmbeddedCryptoProvider;

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

  /** Dedups concurrent `hydrate()` calls with the same scope. */
  private _hydrationInFlight = new Map<string, Promise<void>>();

  /** Serializes async-persisted commits so SQLite writes apply in order. */
  private _pendingPersistChain: Promise<void> = Promise.resolve();

  /** Lazily built visible pending state grouped by table. */
  private _pendingTableState: Map<string, PendingTableState> = new Map();

  readonly queryEngine: QueryEngine;
  private readonly _store: Store = createStore();

  constructor(
    schema: ParsedSchema | null,
    storage?: StorageAdapter,
    crypto?: EmbeddedCryptoProvider,
  ) {
    this._schema = schema;
    this._storage = storage ?? null;
    this._crypto = crypto ?? createAmbientCryptoProvider();
    this._store.setStorage(this._storage);

    if (schema !== null) {
      validateSchemaDefinition(schema);
    }

    const iterateDocs: DocumentIterator = (tableName, callback) => {
      this._iterateDocs(tableName, callback);
    };
    const countTable: TableCountReader = (tableName) =>
      this._hasPendingWritesForTable(tableName) ||
      this._isIdentityScopedTable(tableName)
        ? this.getDocumentsForTable(tableName).length
        : (this._tableDocuments.get(tableName)?.size ?? 0);
    const countTableAsync: AsyncTableCountReader = async (tableName) => {
      if (
        this._hasPendingWritesForTable(tableName) ||
        this._isIdentityScopedTable(tableName)
      ) {
        return this.getDocumentsForTable(tableName).length;
      }
      if (this.isTableHydrationAttempted(tableName)) {
        return this._tableDocuments.get(tableName)?.size ?? 0;
      }
      const storeCount = await this._store.countDocuments(
        tableName,
        this._storageReadOptions(tableName),
      );
      if (storeCount !== null) return storeCount;
      return this._tableDocuments.get(tableName)?.size ?? 0;
    };
    const query: QueryReader = (query) => this._readOptimizedQuery(query);
    const readQueryAsync: AsyncQueryReader = (query) =>
      this._readOptimizedQueryAsync(query);
    const source: SourceReader = (source, limit, seek) =>
      this._readOptimizedSource(source, limit, seek);
    const readSourceAsync: AsyncSourceReader = (source, limit, seek) =>
      this._readOptimizedSourceAsync(source, limit, seek);

    this.queryEngine = new QueryEngine(
      schema,
      iterateDocs,
      countTable,
      query,
      source,
      countTableAsync,
      readQueryAsync,
      readSourceAsync,
      (tableName) => this.getTableVersion(tableName),
    );
  }

  /**
   * Attach (or replace) the durable storage adapter.
   *
   * This is used when the storage backend is initialised asynchronously
   * (e.g. a wa-sqlite worker) after the `Database` is constructed.
   * After calling this, invoke {@link hydrate} to load persisted data.
   */
  setStorage(storage: StorageAdapter | null): void {
    this._storage = storage;
    this._store.setStorage(storage);
    this._resetBlobState();
  }

  setReadBackendForTests(readBackend: AsyncReadBackend | null): void {
    this._store.setReadBackendForTests(readBackend);
  }

  setActiveIdentityKey(identityKey: string | null): void {
    this._activeIdentityKey = identityKey;
  }

  getActiveIdentityKey(): string | null {
    return this._activeIdentityKey;
  }

  /**
   * Hydrate the database from durable storage.
   *
   * Must be called (and awaited) before the first transaction when a
   * {@link StorageAdapter} is attached. No-op when running without
   * storage.
   */
  async hydrate(options?: { tables?: string[] }): Promise<void> {
    if (this._storage === null) return;
    const scopeKey = options?.tables
      ? [...options.tables].sort().join(",")
      : "__all__";
    const inFlight = this._hydrationInFlight.get(scopeKey);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const promise = withSpan("convex-embedded.db.hydrate", async (span) => {
      const started = globalThis.performance?.now?.() ?? Date.now();

      const tableNames = options?.tables;
      const scopedHydration = tableNames !== undefined;
      span.setAttributes({
        "convex.db.hydrate.scoped": scopedHydration,
        "convex.db.hydrate.scope": scopedHydration
          ? tableNames.join(",")
          : "all",
      });
      if (!scopedHydration || tableNames.includes("_storage")) {
        this._resetBlobState();
      }
      const { documents, meta } = await withSpan(
        "convex-embedded.db.hydrate.fetch",
        () =>
          this._store.load(
            scopedHydration ? { tables: tableNames } : undefined,
          ),
      );
      const fetched = globalThis.performance?.now?.() ?? Date.now();
      span.setAttributes({
        "convex.db.hydrate.docs": documents.length,
        "convex.db.hydrate.fetch_ms": +(fetched - started).toFixed(1),
      });

      withSpanSync("convex-embedded.db.hydrate.populate", () => {
        if (scopedHydration) {
          for (const tableName of tableNames) {
            this._clearCommittedTable(tableName);
            this._hydrationAttemptedTables.add(tableName);
          }
        } else {
          this._documents.clear();
          this._idTableMap.clear();
          this._tableDocuments.clear();
          this._fullyHydrated = true;
        }

        for (const { doc, tableName } of documents) {
          if (tableName) {
            this._idTableMap.set(doc._id as string, tableName);
          }
          this._documents.set(doc._id, doc);
          if (tableName) {
            this._addCommittedIdToTable(tableName, doc._id as string);
          }
        }
      });

      await withSpan("convex-embedded.db.hydrate.rebuildIndexes", async () => {
        if (scopedHydration) {
          for (const tableName of tableNames) {
            withSpanSync(
              "convex-embedded.db.rebuildTableIndexes",
              () => this._rebuildTableIndexes(tableName),
              { attributes: { "convex.table": tableName } },
            );
            withSpanSync(
              "convex-embedded.db.rebuildTableSearchIndexes",
              () => this._rebuildTableSearchIndexes(tableName),
              { attributes: { "convex.table": tableName } },
            );
            withSpanSync(
              "convex-embedded.db.rebuildTableVectorIndexes",
              () => this._rebuildTableVectorIndexes(tableName),
              { attributes: { "convex.table": tableName } },
            );
            this._resolveTableHydration(tableName);
          }
        } else {
          withSpanSync("convex-embedded.db.rebuildAllIndexes", () =>
            this._rebuildAllIndexes(),
          );
          withSpanSync("convex-embedded.db.rebuildAllSearchIndexes", () =>
            this._rebuildAllSearchIndexes(),
          );
          withSpanSync("convex-embedded.db.rebuildAllVectorIndexes", () =>
            this._rebuildAllVectorIndexes(),
          );
          this._resolveAllTableHydrations();
        }
      });

      if (meta !== null) {
        this._timestamp = meta.timestamp;
        this._lastCreationTime = meta.lastCreationTime;
      }

      const ended = globalThis.performance?.now?.() ?? Date.now();
      span.setAttributes({
        "convex.db.hydrate.total_ms": +(ended - started).toFixed(1),
        "convex.db.hydrate.rebuild_ms": +(ended - fetched).toFixed(1),
      });
      log.info(
        `hydrate: docs=${documents.length}, scope=${tableNames?.length ? tableNames.join(",") : "all"}, blobs=lazy, fetch=${(fetched - started).toFixed(1)}ms total=${(ended - started).toFixed(1)}ms`,
      );
    });
    this._hydrationInFlight.set(scopeKey, promise);
    try {
      await promise;
    } finally {
      if (this._hydrationInFlight.get(scopeKey) === promise) {
        this._hydrationInFlight.delete(scopeKey);
      }
    }
  }

  /**
   * Hydrate only the runtime's system tables (the open path). User tables are
   * left for lazy on-demand hydration and are read directly from the store
   * (push-down). This only applies to queryable (SQL) storage where reads can be
   * served without an in-memory copy; on non-queryable storage there is no
   * push-down, so fall back to full hydration.
   */
  async hydrateSystemTables(): Promise<void> {
    if (this._storage === null) return;
    if (!this._store.isQueryable()) {
      return this.hydrate();
    }
    return this.hydrate({ tables: [...RUNTIME_SYSTEM_TABLES] });
  }

  isTableHydrationAttempted(tableName: string): boolean {
    return this._fullyHydrated || this._hydrationAttemptedTables.has(tableName);
  }

  tableHydrated(tableName: string): Promise<void> {
    if (
      this._storage === null ||
      this._fullyHydrated ||
      // Queryable (SQL) user tables are served by push-down reads, so a reader
      // never needs to wait for an in-memory hydrate that will not happen under
      // lazy hydration. Without this the per-table query gate would hang.
      this._isQueryableTable(tableName)
    ) {
      return Promise.resolve();
    }
    return this._ensureTableHydrationEntry(tableName);
  }

  private _ensureTableHydrationEntry(tableName: string): Promise<void> {
    const existing = this._tableHydrationPromises.get(tableName);
    if (existing !== undefined) {
      return existing;
    }
    let resolver: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    this._tableHydrationPromises.set(tableName, promise);
    this._tableHydrationResolvers.set(tableName, resolver);
    return promise;
  }

  private _resolveTableHydration(tableName: string): void {
    const resolver = this._tableHydrationResolvers.get(tableName);
    if (resolver !== undefined) {
      resolver();
      this._tableHydrationResolvers.delete(tableName);
      return;
    }
    this._tableHydrationPromises.set(tableName, Promise.resolve());
  }

  private _resolveAllTableHydrations(): void {
    for (const resolver of this._tableHydrationResolvers.values()) {
      resolver();
    }
    this._tableHydrationResolvers.clear();
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
  async replicateTable(tableName: string): Promise<void> {
    if (this._storage === null) return;

    const { docs, meta } = await this._store.refreshTable({ tableName });

    if (docs !== null) {
      const oldIds = this._tableDocuments.get(tableName);
      let changed = !oldIds || oldIds.size !== docs.length;
      if (!changed) {
        for (const doc of docs) {
          if (!oldIds!.has(doc._id as string)) {
            changed = true;
            break;
          }
          if (!structuralEqual(this._documents.get(doc._id), doc)) {
            changed = true;
            break;
          }
        }
      }

      for (const id of oldIds ?? []) {
        this._documents.delete(id as DocumentId);
        this._idTableMap.delete(id);
      }
      this._tableDocuments.set(tableName, new Set());

      for (const doc of docs) {
        this._documents.set(doc._id, doc);
        this._idTableMap.set(doc._id as string, tableName);
        this._addCommittedIdToTable(tableName, doc._id as string);
      }

      if (changed) {
        this._rebuildTableIndexes(tableName);
        this._rebuildTableSearchIndexes(tableName);
        this._rebuildTableVectorIndexes(tableName);
      }
    }

    if (meta !== null) {
      if (meta.timestamp > this._timestamp) {
        this._timestamp = meta.timestamp;
      }
      if (meta.lastCreationTime > this._lastCreationTime) {
        this._lastCreationTime = meta.lastCreationTime;
      }
    }
  }

  /** Current MVCC timestamp. */
  get timestamp(): Timestamp {
    return this._timestamp;
  }

  /** Begin a new (possibly nested) transaction. */
  startTransaction(): void {
    this._writes.push({});
    this._writeCounts.push(0);
    this._writeTables.push(new Map());
  }

  /**
   * Commit the current transaction level synchronously.
   *
   * Top-level callers should use {@link commitAsync} so SQL-backed adapters can
   * authoritatively apply the commit and serve subsequent committed reads.
   * This synchronous path remains for nested commits and opaque storage.
   */
  commit(): DatabaseCommitResult {
    const lastWrites = this._popCommittedWriteLevel();

    if (this._writes.length === 0) {
      if (
        this._store.usesExternalCommitPath() &&
        this._tablesWritten.size > 0
      ) {
        throw new Error(
          "SQL-backed outer commits with adapter apply support must use commitAsync()",
        );
      }

      const { puts, deletes, rowChanges, stateChanges, invalidation } =
        this._buildCommittedWriteArtifacts(lastWrites);
      this._applyCommittedRowChanges(rowChanges);

      const tablesWritten = new Set(this._tablesWritten);
      if (tablesWritten.size > 0) {
        this._timestamp += 1;
        this.bumpTableVersions(tablesWritten);
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

      return {
        timestamp: this._timestamp,
        tablesWritten,
        invalidation,
        persisted,
      };
    }

    return this._mergeNestedCommittedWriteLevel(lastWrites);
  }

  async commitAsync(): Promise<DatabaseCommitResult> {
    return withSpan("convex-embedded.db.commit", () => {
      recordCounter("commit");
      return this._commitAsyncImpl();
    });
  }

  private async _commitAsyncImpl(): Promise<DatabaseCommitResult> {
    const isSqlCommit = this._store.usesExternalCommitPath();
    if (!isSqlCommit) {
      return this.commit();
    }

    if (this._writes.length === 0) {
      throw new Error("Transaction already committed or rolled back");
    }

    if (this._writes.length > 1) {
      const lastWrites = this._popCommittedWriteLevel();
      return this._mergeNestedCommittedWriteLevel(lastWrites);
    }

    const lastWrites = this._writes[this._writes.length - 1] ?? {};
    const tablesWritten = new Set(this._tablesWritten);
    for (const id of Object.keys(lastWrites)) {
      const tableName = this._idTableMap.get(id);
      if (tableName !== undefined) {
        tablesWritten.add(tableName);
      }
    }

    if (tablesWritten.size === 0) {
      this._popCommittedWriteLevel();
      this._tablesWritten.clear();
      return {
        timestamp: this._timestamp,
        tablesWritten,
        invalidation: { tables: new Set(), changes: [] },
        persisted: Promise.resolve(),
      };
    }

    const { puts, deletes, rowChanges, stateChanges, invalidation } =
      this._buildCommittedWriteArtifacts(lastWrites);
    const nextTimestamp = this._timestamp + 1;
    this.bumpTableVersions(tablesWritten);

    const batch = {
      puts,
      deletes,
      meta: {
        timestamp: nextTimestamp,
        lastCreationTime: this._lastCreationTime,
      },
    } satisfies CommitBatch;

    const materializedTables = Array.from(tablesWritten).filter(
      (tableName) => !this._isQueryableTable(tableName),
    );

    const writeOptions = {
      materializedTables,
      tableSearchIndexes: this._collectTableSearchIndexes(),
      tableVectorIndexes: this._collectTableVectorIndexes(),
    };

    const allWrittenTablesAlreadyHydrated = materializedTables.every(
      (tableName) => this.isTableHydrationAttempted(tableName),
    );

    if (allWrittenTablesAlreadyHydrated) {
      this._popCommittedWriteLevel();
      this._applyCommittedIdHints(rowChanges);
      this._timestamp = nextTimestamp;
      this._lastCreationTime = batch.meta.lastCreationTime;
      if (rowChanges.length > 0) {
        this._applyCommittedRowChanges(rowChanges);
        this._applyCommittedStateChanges(stateChanges, {
          skipQueryable: false,
        });
      }
      this._tablesWritten.clear();

      const persisted = this._enqueueAsyncCommit(batch, writeOptions);

      return {
        timestamp: this._timestamp,
        tablesWritten,
        invalidation,
        persisted,
      };
    }

    const applied = await this._store.write(batch, writeOptions);
    if (applied === null) {
      throw new Error(
        "[convex-embedded] expected committed store to apply external top-level commit",
      );
    }

    this._popCommittedWriteLevel();
    this._applyCommittedIdHints(rowChanges);
    this._timestamp = applied.meta.timestamp;
    this._lastCreationTime = applied.meta.lastCreationTime;
    for (const snapshot of applied.tables) {
      this._replaceCommittedTableSnapshot(snapshot.tableName, snapshot.docs);
    }
    const queryableRowChanges = rowChanges.filter(
      (change) =>
        change.tableName !== "" && this._isQueryableTable(change.tableName),
    );
    if (queryableRowChanges.length > 0) {
      this._applyCommittedRowChanges(queryableRowChanges);
      const dirtyTables = new Set<string>();
      for (const change of queryableRowChanges) {
        dirtyTables.add(change.tableName);
      }
      for (const tableName of dirtyTables) {
        this._rebuildTableIndexes(tableName);
        this._rebuildTableSearchIndexes(tableName);
        this._rebuildTableVectorIndexes(tableName);
      }
    }
    this._tablesWritten.clear();

    return {
      timestamp: this._timestamp,
      tablesWritten,
      invalidation,
      persisted: Promise.resolve(),
    };
  }

  private _enqueueAsyncCommit(
    batch: CommitBatch,
    options: {
      materializedTables: string[];
      tableSearchIndexes: Record<
        string,
        import("@/runtime/db/schema").SearchIndexDefinition[]
      >;
      tableVectorIndexes: Record<
        string,
        import("@/runtime/db/schema").VectorIndexDefinition[]
      >;
    },
  ): Promise<void> {
    const previous = this._pendingPersistChain;
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await this._store.write(batch, options);
      });
    this._pendingPersistChain = next.catch(() => undefined);
    return next;
  }

  async waitForPersistence(): Promise<void> {
    await this._pendingPersistChain;
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
    let _id: DocumentId | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this._crypto.randomUUID() as unknown as DocumentId;
      if (
        !this._idTableMap.has(candidate as string) &&
        this._getRaw(candidate) === null
      ) {
        _id = candidate;
        break;
      }
    }
    if (_id === null) {
      throw new Error(
        `[convex-embedded] Failed to allocate a unique document id for table "${table}".`,
      );
    }
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
      throw this._patchMissingDocError("Patch", tableName, idText);
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
      throw this._patchMissingDocError("Patch", tableName, idText);
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

    delete value["_id"];
    delete value["_creationTime"];

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
      throw this._patchMissingDocError("Replace", tableName, idText);
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
      throw this._patchMissingDocError("Replace", tableName, idText);
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
  writeDocument(
    table: TableName,
    doc: Record<string, unknown> & { _id: string; _creationTime: number },
    options: { validate?: boolean } = {},
  ): void {
    const {
      _id,
      _creationTime,
      [IDENTITY_SCOPE_FIELD]: _scopedKey,
      ...userFields
    } = doc;
    const docId = _id as unknown as DocumentId;

    if (options.validate ?? true) {
      this._validate(table, userFields as GenericDocument);
    }

    const existingTable = this._idTableMap.get(_id);

    if (existingTable !== undefined) {
      if (existingTable !== table) {
        throw new Error(
          `writeDocument: ID "${_id}" belongs to table "${existingTable}", ` +
            `not "${table}"`,
        );
      }
      this._addWrite(
        docId,
        this._withIdentityScope(table, {
          _id: docId,
          _creationTime,
          ...userFields,
        }),
      );
    } else {
      this._idTableMap.set(_id, table);

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
  deleteDocument(table: TableName, id: DocumentId): boolean {
    const existingTable = this._idTableMap.get(id as string);
    if (existingTable === undefined) {
      return false;
    }

    if (existingTable !== table) {
      throw new Error(
        `deleteDocument: ID "${id}" belongs to table "${existingTable}", ` +
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

  getTableNames(): string[] {
    const names = new Set<string>();
    if (this._schema) {
      for (const name of this._schema.tables.keys()) {
        names.add(name);
      }
    }
    for (const name of this._tableDocuments.keys()) {
      names.add(name);
    }
    return [...names].sort();
  }

  getIndexDefinitions(
    tableName: string,
  ): Array<{ indexName: string; fields: string[] }> {
    return this._getIndexDefinitions(tableName).map((definition) => ({
      indexName: definition.indexName,
      fields: [...definition.fields],
    }));
  }

  migrateAnonymousDataToIdentity(identityKey: string): Set<string> {
    const tablesWritten = new Set<string>();
    for (const [id, doc] of this._documents) {
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

  /**
   * Re-stamp anonymous (`identity_key IS NULL`) rows that live only in SQLite —
   * the in-memory {@link migrateAnonymousDataToIdentity} pass cannot see them
   * because user tables are SQLite-as-truth and never bulk-hydrated. Returns the
   * logical tables changed; their committed cache is evicted so reads re-fetch.
   */
  async reStampAnonymousUserTablesInStorage(
    identityKey: string,
  ): Promise<string[]> {
    const adapter = this._storage as
      | (StorageAdapter & {
          reStampAnonymousIdentity?: (key: string) => Promise<string[]>;
        })
      | null;
    if (!adapter?.reStampAnonymousIdentity) {
      return [];
    }
    const changed = await adapter.reStampAnonymousIdentity(identityKey);
    for (const tableName of changed) {
      this._evictCommittedTable(tableName);
    }
    return changed;
  }

  private _evictCommittedTable(tableName: string): void {
    const ids = this._tableDocuments.get(tableName);
    if (!ids) {
      return;
    }
    for (const id of ids) {
      this._documents.delete(id as DocumentId);
    }
    this._tableDocuments.delete(tableName);
  }

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

  async storeFile(storageId: DocumentId, blob: Blob): Promise<void> {
    this._blobStorage.set(storageId, blob);

    if (this._storage) {
      await this._storage.storeBlob(storageId as string, blob);
    }
  }

  deleteBlob(storageId: string): void {
    this._blobStorage.delete(storageId as DocumentId);

    if (this._storage) {
      this._storage.deleteBlob(storageId).catch((error) => {
        log.error("blob delete failed:", error);
      });
    }
  }

  getFile(storageId: DocumentId): Blob | null {
    if (this.get("_storage", storageId) === null) {
      return null;
    }
    return this._blobStorage.get(storageId) ?? null;
  }

  async loadFile(storageId: DocumentId): Promise<Blob | null> {
    if (this.get("_storage", storageId) === null) {
      return null;
    }

    const cached = this._blobStorage.get(storageId) ?? null;
    if (cached !== null) {
      return cached;
    }

    if (this._storage === null) {
      return null;
    }

    const blob = await this._storage.getBlob(storageId as string);
    if (blob !== null) {
      this._blobStorage.set(storageId, blob);
    }
    return blob;
  }

  startQuery(query: SerializedQuery): QueryId {
    return this.queryEngine.startQuery(query);
  }

  startQueryAsync(query: SerializedQuery): QueryId {
    return this.queryEngine.startQueryAsync(query);
  }

  queryNext(queryId: QueryId): {
    value: GenericDocument | null;
    done: boolean;
  } {
    return this.queryEngine.queryNext(queryId);
  }

  queryNextAsync(queryId: QueryId): Promise<{
    value: GenericDocument | null;
    done: boolean;
  }> {
    return this.queryEngine.queryNextAsync(queryId);
  }

  queryCleanup(queryId: QueryId): void {
    this.queryEngine.queryCleanup(queryId);
  }

  paginateAsync(args: {
    query: SerializedQuery;
    cursor: string | null;
    endCursor?: string | null;
    pageSize: number;
    maximumRowsRead?: number | null;
    maximumBytesRead?: number | null;
  }): Promise<PaginateResult> {
    return withSpan("convex-embedded.db.paginate", async (span) => {
      span.setAttribute("convex.page.size", args.pageSize);
      span.setAttribute("convex.page.has_cursor", args.cursor !== null);
      span.setAttribute("convex.page.has_end_cursor", args.endCursor != null);
      const result = await this.queryEngine.paginateAsync(args);
      span.setAttribute("convex.page.returned", result.page.length);
      span.setAttribute("convex.page.is_done", result.isDone);
      return result;
    });
  }

  count(tableName: string): number {
    return this.queryEngine.count(tableName);
  }

  countAsync(tableName: string): Promise<number> {
    if (!this._hasPendingWritesForTable(tableName)) {
      return this._store
        .countDocuments(
          tableName as TableName,
          this._storageReadOptions(tableName),
        )
        .then((count) => count ?? this.count(tableName));
    }
    return Promise.resolve(this.count(tableName));
  }

  async getAsync(
    tableName: TableName | undefined,
    id: DocumentId,
    options: { countRead?: boolean } = {},
  ): Promise<StoredDocument | null> {
    let resolvedTable =
      tableName ??
      (this._idTableMap.get(id as string) as TableName | undefined);
    if (
      resolvedTable !== undefined &&
      this.isTableHydrationAttempted(resolvedTable) &&
      !this._hasPendingWritesForTable(resolvedTable)
    ) {
      const inMemory = this._getRaw(id);
      if (inMemory !== null) {
        return this._visibleDocumentInScope(resolvedTable, inMemory);
      }
    }
    if (resolvedTable === undefined) {
      resolvedTable = (await this._findTableForIdViaBackend(id)) as
        | TableName
        | undefined;
    }
    if (
      resolvedTable !== undefined &&
      !this._hasPendingWritesForTable(resolvedTable)
    ) {
      const document = await this._store.getDocument(
        resolvedTable,
        id,
        this._storageReadOptions(resolvedTable),
      );
      if (document !== null) {
        this._rememberCommittedLookup(resolvedTable, [document]);
      }
      if (document !== null) {
        return this._stripIdentityScope(document as IdentityScopedDocument);
      }
    }
    return this.get(resolvedTable, id, options);
  }

  private async _findTableForIdViaBackend(
    id: DocumentId,
  ): Promise<string | undefined> {
    if (!this._schema) {
      return undefined;
    }
    for (const [tableName] of this._schema.tables) {
      if (this._isSystemTable(tableName)) {
        continue;
      }
      const found = await this._store.getDocument(
        tableName,
        id,
        this._storageReadOptions(tableName),
      );
      if (found !== null) {
        this._idTableMap.set(id as string, tableName);
        return tableName;
      }
    }
    return undefined;
  }

  async ensureCommittedDocumentForWrite(
    tableName: TableName,
    id: DocumentId,
  ): Promise<boolean> {
    if (this._getRaw(id) !== null) {
      return true;
    }

    if (this.isTableHydrationAttempted(tableName)) {
      return false;
    }

    const document = await this._store.getDocument(
      tableName,
      id,
      this._storageReadOptions(tableName),
    );
    if (document === null) {
      return false;
    }

    this._idTableMap.set(id, tableName);
    this._cacheCommittedDocument(tableName, document);
    return true;
  }

  async listDocumentsAsync(tableName: TableName): Promise<StoredDocument[]> {
    if (this.isTableHydrationAttempted(tableName)) {
      return this.getDocumentsForTable(tableName);
    }
    if (!this._hasPendingWritesForTable(tableName)) {
      const docs = await this._store.getDocuments(
        tableName,
        this._storageReadOptions(tableName),
      );
      if (docs !== null) {
        this._rememberCommittedLookup(tableName, docs);
        return this._stripIdentityScopes(docs);
      }
    }
    return this.getDocumentsForTable(tableName);
  }

  async listDocumentsForScopeAsync(
    tableName: TableName,
    scopeArgs: Record<string, unknown>,
  ): Promise<StoredDocument[] | null> {
    const scopeKeys = Object.keys(scopeArgs);
    if (scopeKeys.length === 0) {
      return this.listDocumentsAsync(tableName);
    }
    const wantedKeys = new Set(scopeKeys);
    const index = this.getIndexDefinitions(tableName).find((definition) => {
      if (definition.fields.length < scopeKeys.length) return false;
      return definition.fields
        .slice(0, scopeKeys.length)
        .every((field) => wantedKeys.has(field));
    });
    if (index === undefined) {
      return null;
    }
    const source: SerializedQuery["source"] = {
      type: "IndexRange",
      indexName: `${tableName}.${index.indexName}`,
      range: index.fields.slice(0, scopeKeys.length).map((field) => ({
        type: "Eq",
        fieldPath: field,
        value: scopeArgs[field] as JSONValue,
      })),
      order: null,
    };
    const evaluation = await this._readOptimizedSourceAsync(source);
    return evaluation?.results ?? null;
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
    const duplicateIds = new Set<string>();
    const uniqueIds: string[] = [];
    const seenIds = new Set<string>();
    for (const id of ids) {
      const key = id as string;
      if (seenIds.has(key)) {
        duplicateIds.add(key);
        continue;
      }
      seenIds.add(key);
      uniqueIds.push(key);
    }

    if (duplicateIds.size > 0) {
      log.warn(
        `duplicate committed ids detected for ${indexKey}: ${Array.from(duplicateIds).join(", ")}; rebuilding index`,
      );
      this._rebuildTableIndexes(tableName);
      const rebuiltIds = this._indexDocuments.get(indexKey) ?? [];
      return rebuiltIds
        .map((id) => this._documents.get(id as DocumentId))
        .filter((doc): doc is StoredDocument => doc !== undefined)
        .map((doc) => this._stripIdentityScope(doc as IdentityScopedDocument));
    }

    return uniqueIds
      .map((id) => this._documents.get(id as DocumentId))
      .filter((doc): doc is StoredDocument => doc !== undefined)
      .map((doc) => this._stripIdentityScope(doc as IdentityScopedDocument));
  }

  vectorSearch(
    tableAndIndexName: string,
    vector: number[],
    filter: VectorSearchExpression | null,
    limit?: number,
  ): Array<{ _id: string; _score: number }> {
    const [tableName, indexName] = tableAndIndexName.split(".") as [
      string,
      string,
    ];
    const state = this._vectorIndexes.get(`${tableName}.${indexName}`);
    if (state) {
      getVectorIndexDefinition(
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

  async vectorSearchAsync(
    tableAndIndexName: string,
    vector: number[],
    filter: VectorSearchExpression | null,
    limit?: number,
  ): Promise<Array<{ _id: string; _score: number }>> {
    const [tableName, indexName] = tableAndIndexName.split(".") as [
      string,
      string,
    ];
    const definition = getVectorIndexDefinition(
      this._schema?.tables.get(tableName)?.vectorIndexes,
      tableName,
      indexName,
    );

    if (this._isQueryableTable(tableName)) {
      const candidates =
        (await this._store.vectorSearch({
          tableName,
          indexName,
          definition,
          filter,
          activeIdentityKey: this._activeIdentityKey,
        })) ?? [];
      this._rememberCommittedLookup(tableName, candidates);
      const baseState = buildVectorIndexState({
        docs: candidates.map((doc) => {
          const raw = (doc as Record<string, unknown>)[IDENTITY_SCOPE_FIELD];
          return {
            doc,
            identityKey: typeof raw === "string" ? raw : null,
          };
        }),
        definition,
      });
      if (!this._hasPendingWritesForTable(tableName)) {
        return executeVectorSearch(baseState, {
          vector,
          limit,
          filter,
          activeIdentityKey: this._activeIdentityKey,
        });
      }
      return executeOverlayVectorSearch(
        baseState,
        this._buildPendingVectorOverlay(tableName, baseState),
        {
          vector,
          limit,
          filter,
          activeIdentityKey: this._activeIdentityKey,
        },
      );
    }

    return this.vectorSearch(tableAndIndexName, vector, filter, limit);
  }

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
      return false;
    }

    if (actualTableName !== expectedTableName) {
      throw new Error(
        `Invalid argument \`id\`, expected ID in table '${expectedTableName}' but got ID in table '${actualTableName}'`,
      );
    }

    return true;
  }

  private _patchMissingDocError(
    op: "Patch" | "Replace",
    tableName: TableName | undefined,
    idText: string,
  ): Error {
    if (
      typeof tableName === "string" &&
      this._isQueryableTable(tableName) &&
      !this._tableDocuments.has(tableName)
    ) {
      return new Error(
        `[convex-embedded] ${op} on SQL-backed table "${tableName}" requires the document to be hydrated first (id ${idText}). ` +
          `Await a read (e.g. db.get / db.query) on this table before calling ${op.toLowerCase()} so committed rows are materialized.`,
      );
    }
    return new Error(`${op} on non-existent document with ID "${idText}"`);
  }

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
    const writes = this._writes[level]!;
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

  private _popCommittedWriteLevel(): Record<DocumentId, StoredDocument | null> {
    const lastWrites = this._writes.pop();
    const lastWriteCount = this._writeCounts.pop();
    this._writeTables.pop();
    if (lastWrites === undefined) {
      throw new Error("Transaction already committed or rolled back");
    }
    this._pendingWriteCount -= lastWriteCount ?? 0;
    this._pendingTableState.clear();

    for (const id of Object.keys(lastWrites)) {
      const table = this._idTableMap.get(id);
      if (table !== undefined) {
        this._tablesWritten.add(table);
      }
    }

    return lastWrites;
  }

  private _mergeNestedCommittedWriteLevel(
    lastWrites: Record<DocumentId, StoredDocument | null>,
  ): DatabaseCommitResult {
    for (const [id, write] of Object.entries(lastWrites)) {
      this._addWriteRaw(id as DocumentId, write);
    }

    return {
      timestamp: this._timestamp,
      tablesWritten: new Set(this._tablesWritten),
      invalidation: { tables: new Set(), changes: [] },
      persisted: Promise.resolve(),
    };
  }

  private _buildCommittedWriteArtifacts(
    lastWrites: Record<DocumentId, StoredDocument | null>,
  ): CommittedWriteArtifacts {
    return Object.entries(lastWrites).reduce<CommittedWriteArtifacts>(
      (acc, [id, write]) => {
        const docId = id as DocumentId;
        const tableName = this._idTableMap.get(id) ?? "";
        const shouldMaterialize = true;
        const before =
          (this._documents.get(docId) as IdentityScopedDocument | undefined) ??
          null;

        if (write === null) {
          acc.deletes.push({ id, tableName });
          acc.rowChanges.push({
            tableName,
            id: docId,
            before,
            after: null,
            shouldMaterialize,
          });
          if (tableName) {
            if (shouldMaterialize) {
              acc.invalidation.changes.push({
                tableName,
                before: before ? this._stripIdentityScope(before) : null,
                after: null,
              });
              acc.invalidation.tables.add(tableName);
            }
            if (shouldMaterialize) {
              acc.stateChanges.push({
                tableName,
                id: docId,
                before,
                after: null,
              });
            }
          }
          return acc;
        }

        acc.puts.push({ doc: write, tableName });
        acc.rowChanges.push({
          tableName,
          id: docId,
          before,
          after: write as IdentityScopedDocument,
          shouldMaterialize,
        });
        if (tableName) {
          if (shouldMaterialize) {
            acc.invalidation.changes.push({
              tableName,
              before: before ? this._stripIdentityScope(before) : null,
              after: this._stripIdentityScope(write as IdentityScopedDocument),
            });
            acc.invalidation.tables.add(tableName);
          }
          if (shouldMaterialize) {
            acc.stateChanges.push({
              tableName,
              id: docId,
              before,
              after: write as IdentityScopedDocument,
            });
          }
        }
        return acc;
      },
      {
        puts: [] as Array<{ doc: StoredDocument; tableName: string }>,
        deletes: [] as Array<{ id: string; tableName: string }>,
        rowChanges: [] as CommittedRowChange[],
        stateChanges: [] as CommittedStateChange[],
        invalidation: { tables: new Set<string>(), changes: [] },
      },
    );
  }

  private _applyCommittedRowChanges(changes: CommittedRowChange[]): void {
    for (const change of changes) {
      const { tableName, id, after, shouldMaterialize } = change;
      if (after === null) {
        this._documents.delete(id);
        if (tableName) {
          this._removeCommittedIdFromTable(tableName, id);
        }
        this._idTableMap.delete(id);
        continue;
      }

      if (shouldMaterialize) {
        this._documents.set(id, after);
        if (tableName) {
          this._addCommittedIdToTable(tableName, id);
        }
      } else {
        this._documents.delete(id);
        if (tableName) {
          this._removeCommittedIdFromTable(tableName, id);
        }
      }
      if (tableName) {
        this._idTableMap.set(id, tableName);
      }
    }
  }

  private _applyCommittedIdHints(changes: CommittedRowChange[]): void {
    for (const change of changes) {
      const { tableName, id, after } = change;
      if (after === null) {
        this._idTableMap.delete(id);
        if (tableName) {
          this._removeCommittedIdFromTable(tableName, id);
        }
        continue;
      }
      if (tableName) {
        this._idTableMap.set(id, tableName);
      }
    }
  }

  private _persistCommitBatch(batch: CommitBatch): Promise<void> {
    if (this._storage === null) return Promise.resolve();
    if (batch.puts.length === 0 && batch.deletes.length === 0) {
      return Promise.resolve();
    }
    const write = (
      this._storage as { write?: (b: CommitBatch) => Promise<unknown> }
    ).write;
    if (typeof write !== "function") return Promise.resolve();
    return write.call(this._storage, batch).then(() => {});
  }

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
        const document = this._documents.get(id as DocumentId) as
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
      const document = this._documents.get(id as DocumentId) as
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
      const write = this._writes[i]![id];
      if (write !== undefined) {
        hasPendingWrite = true;
        document = write as IdentityScopedDocument | null;
        break;
      }
    }

    if (!hasPendingWrite) {
      document =
        (this._documents.get(id) as IdentityScopedDocument | undefined) ?? null;
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
    if (!(IDENTITY_SCOPE_FIELD in document)) {
      return document as StoredDocument;
    }
    const { [IDENTITY_SCOPE_FIELD]: _identityKey, ...rest } = document;
    return rest as StoredDocument;
  }

  private _stripIdentityScopes(
    documents: readonly StoredDocument[],
  ): StoredDocument[] {
    return documents.map((doc) =>
      this._stripIdentityScope(doc as IdentityScopedDocument),
    );
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

  private _rememberCommittedLookup(
    tableName: string,
    docs: readonly StoredDocument[],
  ): void {
    for (const doc of docs) {
      if (typeof doc._id === "string") {
        this._idTableMap.set(doc._id, tableName);
        this._cacheCommittedDocument(tableName, doc);
      }
    }
  }

  private _cacheCommittedDocument(
    tableName: string,
    doc: StoredDocument,
  ): void {
    const scoped =
      this._isIdentityScopedTable(tableName) &&
      (doc as IdentityScopedDocument)[IDENTITY_SCOPE_FIELD] === undefined
        ? this._withIdentityScope(tableName, doc)
        : (doc as IdentityScopedDocument);
    this._documents.set(doc._id as DocumentId, scoped);
    this._addCommittedIdToTable(tableName, doc._id);
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

  private _clearCommittedTable(tableName: string): void {
    for (const id of this._tableDocuments.get(tableName) ?? []) {
      this._documents.delete(id as DocumentId);
      this._idTableMap.delete(id);
    }
    this._tableDocuments.set(tableName, new Set());
  }

  private _replaceCommittedTableSnapshot(
    tableName: string,
    docs: readonly StoredDocument[],
  ): void {
    this._clearCommittedTable(tableName);
    for (const doc of docs) {
      this._documents.set(doc._id, this._withIdentityScope(tableName, doc));
      this._idTableMap.set(doc._id as string, tableName);
      this._addCommittedIdToTable(tableName, doc._id as string);
    }
    this._rebuildTableIndexes(tableName);
    this._rebuildTableSearchIndexes(tableName);
    this._rebuildTableVectorIndexes(tableName);
  }

  private _resetBlobState(): void {
    this._blobStorage.clear();
  }

  private _readOptimizedSource(
    source: SerializedQuery["source"],
    limit?: number | null,
    seek?: SeekBound,
  ): SourceEvaluationLike | null {
    if (source.type === "FullTableScan") {
      const indexName =
        source.order === "desc" ? "by_creation_time_desc" : "by_creation_time";
      const order = source.order ?? "asc";
      if (this._hasPendingWritesForTable(source.tableName)) {
        return {
          results: this._applySeekToOrderedDocs(
            this._getMergedIndexedDocuments(source.tableName, indexName),
            seek,
          ),
          fieldPathsToSortBy: [],
          order,
          presorted: true,
        };
      }
      const ids = this._indexedIds(source.tableName, indexName);
      if (ids === null) {
        return {
          results: this._applySeekToOrderedDocs(
            this.getIndexedDocuments(source.tableName, indexName),
            seek,
          ),
          fieldPathsToSortBy: [],
          order,
          presorted: true,
        };
      }
      return {
        results: this._readIndexWindow({
          ids,
          fields: ["_creationTime", "_id"],
          lower: null,
          upper: null,
          predicate: () => true,
          iterate: "forward",
          seek,
          limit: limit ?? null,
        }),
        fieldPathsToSortBy: [],
        order,
        presorted: true,
      };
    }

    if (source.type === "IndexRange") {
      const [tableName, indexName] = source.indexName.split(".") as [
        string,
        string,
      ];
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
      const hasPending = this._hasPendingWritesForTable(tableName);

      if (hasPending && source.order === "asc") {
        return {
          results: this._applySeekToOrderedDocs(
            this._collectMergedIndexRangeDocs(
              tableName,
              indexName,
              [],
              null,
              fields,
              lower,
              upper,
              predicate,
            ),
            seek,
          ),
          fieldPathsToSortBy: [],
          order: "asc",
          presorted: true,
        };
      }

      if (!hasPending) {
        const ids = this._indexedIds(tableName, indexName);
        if (ids !== null) {
          return {
            results: this._readIndexWindow({
              ids,
              fields,
              lower,
              upper,
              predicate,
              iterate: source.order === "desc" ? "backward" : "forward",
              seek,
              limit: limit ?? null,
            }),
            fieldPathsToSortBy: [],
            order: "asc",
            presorted: true,
          };
        }
      }

      const sourceDocs = hasPending
        ? this._getMergedIndexedDocuments(tableName, indexName)
        : this.getIndexedDocuments(tableName, indexName);
      const start = lower
        ? this._binarySearchLowerBound(sourceDocs, fields, lower)
        : 0;
      const end = upper
        ? this._binarySearchUpperBound(sourceDocs, fields, upper)
        : sourceDocs.length;
      const filteredDocs = sourceDocs.slice(start, end).filter(predicate);
      const ordered =
        source.order === "desc" ? [...filteredDocs].reverse() : filteredDocs;
      return {
        results: this._applySeekToOrderedDocs(ordered, seek),
        fieldPathsToSortBy: [],
        order: "asc",
        presorted: true,
      };
    }

    if (source.type === "Search") {
      const [tableName, indexName] = source.indexName.split(".") as [
        string,
        string,
      ];
      const state = this._searchIndexes.get(`${tableName}.${indexName}`);
      if (!state) return null;
      const args = {
        source,
        activeIdentityKey: this._activeIdentityKey,
        limit: limit ?? undefined,
      };
      const results = this._hasPendingWritesForTable(tableName)
        ? executeOverlaySearch(
            state,
            this._buildPendingSearchOverlay(tableName, state),
            args,
          )
        : executeSearch(state, args);
      return {
        results,
        fieldPathsToSortBy: [],
        order: "asc",
        presorted: true,
      };
    }

    return null;
  }

  private async _readOptimizedSourceAsync(
    source: SerializedQuery["source"],
    limit?: number | null,
    seek?: SeekBound,
  ): Promise<SourceEvaluationLike | null> {
    const sourceTable = sourceTableName(source);
    if (
      this.isTableHydrationAttempted(sourceTable) &&
      source.type !== "Search"
    ) {
      const inMemory = this._readOptimizedSource(source, limit, seek);
      if (inMemory !== null) return inMemory;
    }

    if (!this._hasPendingWritesForAnySource(source)) {
      const results = await this._store.source(source, {
        limit,
        indexFields: this._indexFieldsForSource(source) ?? undefined,
        searchDefinition: this._searchDefinitionForSource(source),
        activeIdentityKey: this._activeIdentityKey,
        seek: source.type === "Search" ? undefined : seek,
      });
      if (results !== null) {
        this._rememberCommittedLookup(sourceTableName(source), results);
        const order =
          source.type === "Search" ? "asc" : (source.order ?? "asc");
        return {
          results: this._stripIdentityScopes(results),
          fieldPathsToSortBy:
            source.type === "FullTableScan" ? ["_creationTime"] : [],
          order,
          presorted: true,
        };
      }
    }

    if (
      source.type === "FullTableScan" &&
      !this._hasPendingWritesForTable(source.tableName)
    ) {
      const docs = await this._store.getDocuments(
        source.tableName,
        this._storageReadOptions(source.tableName),
      );
      if (docs !== null) {
        this._rememberCommittedLookup(source.tableName, docs);
        const order = source.order ?? "asc";
        return {
          results: this._stripIdentityScopes(docs),
          fieldPathsToSortBy: ["_creationTime"],
          order,
          presorted: order === "asc",
        };
      }
    }

    if (
      this._hasPendingWritesForAnySource(source) &&
      this._isQueryableTable(sourceTable) &&
      !this.isTableHydrationAttempted(sourceTable)
    ) {
      const overlaid = await this._readPushdownWithPendingOverlay(
        source,
        limit,
        seek,
      );
      if (overlaid !== null) return overlaid;
    }

    return this._readOptimizedSource(source, limit);
  }

  private async _readPushdownWithPendingOverlay(
    source: SerializedQuery["source"],
    limit?: number | null,
    seek?: SeekBound,
  ): Promise<SourceEvaluationLike | null> {
    if (source.type === "Search") {
      return null;
    }
    const tableName = sourceTableName(source);
    const indexFields =
      source.type === "IndexRange"
        ? (this._getIndexDefinitions(splitIndexName(source.indexName)[0]).find(
            (entry) => entry.indexName === splitIndexName(source.indexName)[1],
          )?.fields ?? null)
        : null;
    const committed = await this._store.source(source, {
      limit,
      indexFields: indexFields ?? undefined,
      activeIdentityKey: this._activeIdentityKey,
      seek,
    });
    if (committed === null) {
      return null;
    }
    const { shadowedIds } = this._getPendingTableState(tableName);
    const rangePredicate =
      source.type === "IndexRange"
        ? this._buildRangePredicate(source.range)
        : () => true;
    const byId = new Map<string, StoredDocument>();
    for (const doc of committed) {
      if (!shadowedIds.has(doc._id as string)) {
        byId.set(doc._id as string, doc);
      }
    }
    for (const { doc } of this._getVisiblePendingDocs(tableName)) {
      if (rangePredicate(doc)) {
        byId.set(doc._id as string, doc);
      }
    }
    const merged = this._stripIdentityScopes([...byId.values()]);
    const sortIndexName =
      source.type === "IndexRange"
        ? splitIndexName(source.indexName)[1]
        : "by_creation_time";
    const sortFields =
      source.type === "IndexRange" && indexFields
        ? indexFields
        : ["_creationTime"];
    merged.sort((left, right) =>
      this._compareDocsForIndex(sortIndexName, sortFields, left, right),
    );
    if ((source.order ?? "asc") === "desc") {
      merged.reverse();
    }
    return {
      results: merged,
      fieldPathsToSortBy: [],
      order: source.order ?? "asc",
      presorted: true,
    };
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
      const [tableName, indexName] = query.source.indexName.split(".") as [
        string,
        string,
      ];
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

  private _indexFieldsForSource(
    source: SerializedQuery["source"],
  ): string[] | null {
    if (source.type !== "IndexRange") return null;
    const [tableName, indexName] = splitIndexName(source.indexName);
    return (
      this._getIndexDefinitions(tableName).find(
        (entry) => entry.indexName === indexName,
      )?.fields ?? null
    );
  }

  private _searchDefinitionForSource(
    source: SerializedQuery["source"],
  ): SearchIndexDefinition | undefined {
    if (source.type !== "Search") return undefined;
    const [tableName, indexName] = splitIndexName(source.indexName);
    return getSearchIndexDefinition(
      this._schema?.tables.get(tableName)?.searchIndexes,
      tableName,
      indexName,
    );
  }

  private async _readOptimizedQueryAsync(
    query: SerializedQuery,
  ): Promise<Array<GenericDocument> | null> {
    const { filters, limit } = this._extractNormalizedOperators(
      query.operators,
    );
    const queryTable = sourceTableName(query.source);

    if (
      query.source.type !== "Search" &&
      this.isTableHydrationAttempted(queryTable)
    ) {
      const inMemory = this._readOptimizedQuery(query);
      if (inMemory !== null) return inMemory;
    }

    if (
      (query.source.type === "FullTableScan" ||
        query.source.type === "IndexRange") &&
      !this._hasPendingWritesForAnySource(query.source)
    ) {
      const pushedDown = await this._store.query({
        source: query.source,
        filters,
        limit: limit ?? null,
        indexFields: this._indexFieldsForSource(query.source) ?? undefined,
        searchDefinition: undefined,
        activeIdentityKey: this._activeIdentityKey,
      });
      if (pushedDown !== null) {
        this._rememberCommittedLookup(
          sourceTableName(query.source),
          pushedDown,
        );
        return this._stripIdentityScopes(pushedDown);
      }
    }

    if (!this._hasPendingWritesForAnySource(query.source)) {
      const sourceResults = await this._store.source(query.source, {
        limit,
        indexFields: this._indexFieldsForSource(query.source) ?? undefined,
        searchDefinition: this._searchDefinitionForSource(query.source),
        activeIdentityKey: this._activeIdentityKey,
      });
      if (sourceResults !== null) {
        this._rememberCommittedLookup(
          sourceTableName(query.source),
          sourceResults,
        );
      }
    }

    if (
      query.source.type === "FullTableScan" &&
      !this._hasPendingWritesForTable(query.source.tableName)
    ) {
      const docs = await this._store.getDocuments(
        query.source.tableName,
        this._storageReadOptions(query.source.tableName),
      );
      if (docs !== null) {
        this._rememberCommittedLookup(query.source.tableName, docs);
        const orderedDocs =
          query.source.order === "desc" ? [...docs].reverse() : docs;
        return this._stripIdentityScopes(
          this._filterOrderedDocs(orderedDocs, filters, limit ?? null),
        );
      }
    }

    if (
      (query.source.type === "FullTableScan" ||
        query.source.type === "IndexRange") &&
      this._hasPendingWritesForAnySource(query.source) &&
      this._isQueryableTable(queryTable) &&
      !this.isTableHydrationAttempted(queryTable)
    ) {
      const overlaid = await this._readPushdownWithPendingOverlay(
        query.source,
        limit ?? null,
      );
      if (overlaid !== null) {
        return this._filterOrderedDocs(
          overlaid.results,
          filters,
          limit ?? null,
        );
      }
    }

    return this._readOptimizedQuery(query);
  }

  private _hasPendingWritesForAnySource(
    source: SerializedQuery["source"],
  ): boolean {
    if (source.type === "FullTableScan") {
      return this._hasPendingWritesForTable(source.tableName);
    }
    if (source.type === "IndexRange" || source.type === "Search") {
      const [tableName] = source.indexName.split(".") as [string];
      return this._hasPendingWritesForTable(tableName);
    }
    return this._hasPendingWrites();
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
    const seenIds = new Set<string>();
    const iterate = order === "desc" ? [...docs].reverse() : docs;

    for (const doc of iterate) {
      if (seenIds.has(doc._id as string)) {
        continue;
      }
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
      seenIds.add(doc._id as string);
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
    const seenIds = new Set<string>();

    let committedIndex = 0;
    let pendingIndex = 0;

    const nextCommittedDoc = (): StoredDocument | null => {
      while (committedIndex < committedIds.length) {
        const id = committedIds[committedIndex++]!;
        if (pendingState.shadowedIds.has(id)) {
          continue;
        }
        const raw = this._documents.get(id as DocumentId) as
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
      if (seenIds.has(doc._id as string)) {
        return false;
      }
      if (
        filters.length > 0 &&
        !filters.every((filter) => evaluateNormalizedFilter(doc, filter))
      ) {
        return false;
      }
      results.push(doc);
      seenIds.add(doc._id as string);
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
    const seenIds = new Set<string>();
    let committedIndex = 0;
    let pendingIndex = 0;

    const compareBounds = (doc: StoredDocument): boolean => {
      if (lower !== null) {
        const cmp = this._compareDocToBound(doc, fields, lower);
        if (lower.inclusive ? cmp < 0 : cmp <= 0) return false;
      }
      if (upper !== null) {
        const cmp = this._compareDocToBound(doc, fields, upper);
        if (upper.inclusive ? cmp > 0 : cmp >= 0) return false;
      }
      return true;
    };

    const nextCommittedDoc = (): StoredDocument | null => {
      while (committedIndex < committedIds.length) {
        const id = committedIds[committedIndex++]!;
        if (pendingState.shadowedIds.has(id)) {
          continue;
        }
        const raw = this._documents.get(id as DocumentId) as
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
      if (seenIds.has(doc._id as string)) {
        return false;
      }
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
      seenIds.add(doc._id as string);
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
    const seenIds = new Set<string>();
    let leftIndex = 0;
    let rightIndex = 0;

    const nextLeftDoc = (): StoredDocument | null => {
      while (leftIndex < leftIds.length) {
        const id = leftIds[leftIndex++]!;
        if (shadowedIds.has(id)) {
          continue;
        }
        const raw = this._documents.get(id as DocumentId) as
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
        if (!seenIds.has(leftDoc._id as string)) {
          merged.push(leftDoc);
          seenIds.add(leftDoc._id as string);
        }
        leftDoc = nextLeftDoc();
      } else {
        const doc = rightDocs[rightIndex]!;
        if (!seenIds.has(doc._id as string)) {
          merged.push(doc);
          seenIds.add(doc._id as string);
        }
        rightIndex += 1;
      }
    }

    while (leftDoc !== null) {
      if (!seenIds.has(leftDoc._id as string)) {
        merged.push(leftDoc);
        seenIds.add(leftDoc._id as string);
      }
      leftDoc = nextLeftDoc();
    }
    while (rightIndex < rightDocs.length) {
      const doc = rightDocs[rightIndex]!;
      if (!seenIds.has(doc._id as string)) {
        merged.push(doc);
        seenIds.add(doc._id as string);
      }
      rightIndex += 1;
    }

    return merged;
  }

  private _allKnownTableNames(): Set<string> {
    const names = new Set(this._tableDocuments.keys());
    if (this._schema) {
      for (const name of this._schema.tables.keys()) {
        names.add(name);
      }
    }
    return names;
  }

  private _rebuildAllIndexes(): void {
    this._indexDocuments.clear();
    for (const tableName of this._allKnownTableNames()) {
      const rowCount = this._tableDocuments.get(tableName)?.size ?? 0;
      withSpanSync(
        "convex-embedded.db.rebuildTableIndexes",
        () => this._rebuildTableIndexes(tableName),
        {
          attributes: {
            "convex.table": tableName,
            "convex.table.rows": rowCount,
          },
        },
      );
    }
  }

  private _rebuildAllSearchIndexes(): void {
    this._searchIndexes.clear();
    for (const tableName of this._allKnownTableNames()) {
      const rowCount = this._tableDocuments.get(tableName)?.size ?? 0;
      withSpanSync(
        "convex-embedded.db.rebuildTableSearchIndexes",
        () => this._rebuildTableSearchIndexes(tableName),
        {
          attributes: {
            "convex.table": tableName,
            "convex.table.rows": rowCount,
          },
        },
      );
    }
  }

  private _collectTableSearchIndexes(): Record<
    string,
    import("@/runtime/db/schema").SearchIndexDefinition[]
  > {
    const result: Record<
      string,
      import("@/runtime/db/schema").SearchIndexDefinition[]
    > = {};
    if (!this._schema) return result;
    for (const [tableName, tableSchema] of this._schema.tables) {
      if (tableSchema.searchIndexes && tableSchema.searchIndexes.length > 0) {
        result[tableName] = [...tableSchema.searchIndexes];
      }
    }
    return result;
  }

  private _collectTableVectorIndexes(): Record<
    string,
    import("@/runtime/db/schema").VectorIndexDefinition[]
  > {
    const result: Record<
      string,
      import("@/runtime/db/schema").VectorIndexDefinition[]
    > = {};
    if (!this._schema) return result;
    for (const [tableName, tableSchema] of this._schema.tables) {
      if (tableSchema.vectorIndexes && tableSchema.vectorIndexes.length > 0) {
        result[tableName] = [...tableSchema.vectorIndexes];
      }
    }
    return result;
  }

  private _rebuildAllVectorIndexes(): void {
    this._vectorIndexes.clear();
    for (const tableName of this._allKnownTableNames()) {
      const rowCount = this._tableDocuments.get(tableName)?.size ?? 0;
      withSpanSync(
        "convex-embedded.db.rebuildTableVectorIndexes",
        () => this._rebuildTableVectorIndexes(tableName),
        {
          attributes: {
            "convex.table": tableName,
            "convex.table.rows": rowCount,
          },
        },
      );
    }
  }

  private _rebuildTableIndexes(tableName: string): void {
    const ids: string[] = [];
    const docs = this._documents;
    for (const id of this._tableDocuments.get(tableName) ?? []) {
      if (docs.get(id as DocumentId) !== undefined) {
        ids.push(id);
      }
    }

    for (const { indexName, fields } of this._getIndexDefinitions(tableName)) {
      if (ids.length === 0) {
        this._indexDocuments.set(`${tableName}.${indexName}`, []);
        continue;
      }

      const keyed: Array<{ id: string; keys: Array<Value | undefined> }> =
        Array.from({ length: ids.length });
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        const doc = docs.get(id as DocumentId)!;
        const keys: Array<Value | undefined> = Array.from({
          length: fields.length,
        });
        for (let f = 0; f < fields.length; f++) {
          keys[f] = evaluateFieldPath(fields[f]!, doc) as Value | undefined;
        }
        keyed[i] = { id, keys };
      }

      const desc = indexName === "by_creation_time_desc";
      keyed.sort((left, right) => {
        for (let f = 0; f < fields.length; f++) {
          const cmp = compareValues(left.keys[f], right.keys[f]);
          if (cmp !== 0) {
            return desc ? -cmp : cmp;
          }
        }
        return 0;
      });

      const sortedIds: string[] = Array.from({ length: keyed.length });
      for (let i = 0; i < keyed.length; i++) {
        sortedIds[i] = keyed[i]!.id;
      }
      this._indexDocuments.set(`${tableName}.${indexName}`, sortedIds);
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
    if (searchIndexes.length === 0) {
      return;
    }
    const rawDocs = [...(this._tableDocuments.get(tableName) ?? [])]
      .map(
        (id) =>
          this._documents.get(id as DocumentId) as
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
          definition: getSearchIndexDefinition(
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
    if (vectorIndexes.length === 0) {
      return;
    }
    const rawDocs = [...(this._tableDocuments.get(tableName) ?? [])]
      .map(
        (id) =>
          this._documents.get(id as DocumentId) as
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
          definition: getVectorIndexDefinition(
            vectorIndexes,
            tableName,
            definition.indexDescriptor,
          ),
        }),
      );
    }
  }

  private _applyCommittedStateChanges(
    changes: CommittedStateChange[],
    options: { skipQueryable?: boolean } = {},
  ): void {
    withSpanSync("convex-embedded.db.applyIndexChanges", (span) => {
      span.setAttribute("convex.change_count", changes.length);
      this._applyCommittedStateChangesImpl(changes, options);
    });
  }

  private _applyCommittedStateChangesImpl(
    changes: CommittedStateChange[],
    options: { skipQueryable?: boolean } = {},
  ): void {
    const skipQueryable = options.skipQueryable ?? true;
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
      if (skipQueryable && this._isQueryableTable(tableName)) {
        continue;
      }

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

  private _isSystemTable(tableName: string): boolean {
    return tableName.startsWith("_");
  }

  private _storageReadOptions(tableName: string): ReadOptions | undefined {
    return this._isSystemTable(tableName)
      ? undefined
      : { activeIdentityKey: this._activeIdentityKey };
  }

  private _isQueryableTable(tableName: string): boolean {
    return this._store.isQueryable() && !tableName.startsWith("_");
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

      const idsToRemove = new Set<string>();
      for (const change of changes) {
        if (change.before !== null) {
          idsToRemove.add(change.id as string);
        }
      }
      if (idsToRemove.size > 0) {
        let write = 0;
        for (let read = 0; read < ids.length; read++) {
          if (!idsToRemove.has(ids[read]!)) {
            ids[write++] = ids[read]!;
          }
        }
        ids.length = write;
      }

      for (const change of changes) {
        if (change.after === null) {
          continue;
        }
        const changeId = change.id as string;
        const insertAt = this._binarySearchIndexInsertPosition(
          ids,
          indexName,
          fields,
          change.after,
        );
        if (insertAt > 0 && ids[insertAt - 1] === changeId) {
          log.warn(
            `duplicate incremental id detected for ${key}; rebuilding index`,
          );
          this._rebuildTableIndexes(tableName);
          return;
        }
        ids.splice(insertAt, 0, changeId);
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
        deleteDocumentFromVectorIndexState(state, change.id as string);
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
        deleteDocumentFromSearchIndexState(state, change.id as string);
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
      const current = this._documents.get(ids[mid] as DocumentId);
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
    const cached = this._indexDefsCache.get(tableName);
    if (cached !== undefined) {
      return cached;
    }

    const tableSchema = this._schema?.tables.get(tableName);
    const schemaIndexes =
      tableSchema?.indexes.map((index) => ({
        indexName: index.indexDescriptor,
        fields: [...index.fields, "_creationTime", "_id"],
      })) ?? [];
    const systemIndexes = SYSTEM_INDEX_DEFINITIONS[tableName] ?? [];

    const definitions = [
      { indexName: "by_creation_time", fields: ["_creationTime", "_id"] },
      { indexName: "by_creation_time_desc", fields: ["_creationTime", "_id"] },
      { indexName: "by_id", fields: ["_id"] },
      ...systemIndexes,
      ...schemaIndexes,
    ];
    this._indexDefsCache.set(tableName, definitions);
    return definitions;
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

  private _applySeekToOrderedDocs(
    docs: StoredDocument[],
    seek: SeekBound | undefined,
  ): StoredDocument[] {
    if (seek === undefined || docs.length === 0) {
      return docs;
    }
    const value = evaluateValue(seek.value);
    const keep = (doc: StoredDocument): boolean => {
      const comparison = compareValues(
        evaluateFieldPath(seek.field, doc),
        value,
      );
      if (seek.direction === "asc") {
        return seek.inclusive ? comparison >= 0 : comparison > 0;
      }
      return seek.inclusive ? comparison <= 0 : comparison < 0;
    };
    const start = this._seekStartIndex(docs, keep);
    return start === 0 ? docs : docs.slice(start);
  }

  private _seekStartIndex(
    docs: StoredDocument[],
    keep: (doc: StoredDocument) => boolean,
  ): number {
    let low = 0;
    let high = docs.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (keep(docs[mid]!)) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    return low;
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

    let prefixLength = values.length;
    for (let index = 0; index < values.length; index++) {
      if (values[index] === undefined) {
        prefixLength = index;
        break;
      }
    }
    values.length = prefixLength;

    return values.length === 0 ? null : { values, inclusive };
  }

  private _indexedIds(tableName: string, indexName: string): string[] | null {
    const ids = this._indexDocuments.get(`${tableName}.${indexName}`);
    return ids === undefined ? null : (ids as string[]);
  }

  private _materializeIndexedId(id: string): StoredDocument | null {
    const raw = this._documents.get(id as DocumentId) as
      | IdentityScopedDocument
      | undefined;
    return raw === undefined ? null : this._stripIdentityScope(raw);
  }

  private _readIndexWindow(input: {
    ids: string[];
    fields: string[];
    lower: { values: Array<Value | undefined>; inclusive: boolean } | null;
    upper: { values: Array<Value | undefined>; inclusive: boolean } | null;
    predicate: (doc: StoredDocument) => boolean;
    iterate: "forward" | "backward";
    seek: SeekBound | undefined;
    limit: number | null;
  }): StoredDocument[] {
    const { ids, fields, lower, upper, predicate, iterate, seek, limit } =
      input;
    const docAt = (index: number): StoredDocument | null =>
      this._materializeIndexedId(ids[index]!);
    const lowerIndex = lower
      ? this._binarySearchBoundIds(ids, fields, lower, docAt, "lower")
      : 0;
    const upperIndex = upper
      ? this._binarySearchBoundIds(ids, fields, upper, docAt, "upper")
      : ids.length;

    const seekValue =
      seek === undefined ? undefined : evaluateValue(seek.value);
    const passesSeek = (doc: StoredDocument): boolean => {
      if (seek === undefined) {
        return true;
      }
      const comparison = compareValues(
        evaluateFieldPath(seek.field, doc),
        seekValue,
      );
      if (seek.direction === "asc") {
        return seek.inclusive ? comparison >= 0 : comparison > 0;
      }
      return seek.inclusive ? comparison <= 0 : comparison < 0;
    };

    const results: StoredDocument[] = [];
    const step = iterate === "backward" ? -1 : 1;
    let index = iterate === "backward" ? upperIndex - 1 : lowerIndex;
    const stop = iterate === "backward" ? lowerIndex - 1 : upperIndex;

    if (iterate === "forward" && seek !== undefined) {
      index = this._seekIndexInRange(lowerIndex, upperIndex, docAt, passesSeek);
    } else if (iterate === "backward" && seek !== undefined) {
      index = this._seekIndexInRangeBackward(
        lowerIndex,
        upperIndex,
        docAt,
        passesSeek,
      );
    }
    for (; index !== stop; index += step) {
      const doc = docAt(index);
      if (doc === null || !predicate(doc) || !passesSeek(doc)) {
        continue;
      }
      results.push(doc);
      if (limit !== null && results.length >= limit) {
        break;
      }
    }
    return results;
  }

  private _seekIndexInRange(
    lowerIndex: number,
    upperIndex: number,
    docAt: (index: number) => StoredDocument | null,
    passesSeek: (doc: StoredDocument) => boolean,
  ): number {
    let low = lowerIndex;
    let high = upperIndex;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const doc = docAt(mid);
      if (doc !== null && passesSeek(doc)) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    return low;
  }

  private _seekIndexInRangeBackward(
    lowerIndex: number,
    upperIndex: number,
    docAt: (index: number) => StoredDocument | null,
    passesSeek: (doc: StoredDocument) => boolean,
  ): number {
    let low = lowerIndex;
    let high = upperIndex;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const doc = docAt(mid);
      if (doc !== null && passesSeek(doc)) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low - 1;
  }

  private _binarySearchBoundIds(
    ids: string[],
    fields: string[],
    bound: { values: Array<Value | undefined>; inclusive: boolean },
    docAt: (index: number) => StoredDocument | null,
    side: "lower" | "upper",
  ): number {
    let low = 0;
    let high = ids.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const doc = docAt(mid);
      const comparison =
        doc === null ? 0 : this._compareDocToBound(doc, fields, bound);
      const moveRight =
        side === "lower"
          ? bound.inclusive
            ? comparison < 0
            : comparison <= 0
          : bound.inclusive
            ? comparison <= 0
            : comparison < 0;
      if (moveRight) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
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
