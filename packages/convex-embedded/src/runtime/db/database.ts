import type { JSONValue, Value } from "convex/values";
import { jsonToConvex } from "convex/values";

import {
  createAmbientCryptoProvider,
  type EmbeddedCryptoProvider,
} from "@/runtime/crypto";
import type { AsyncReadBackend } from "@/runtime/db/backend";
import { compareValues } from "@/runtime/db/compare";
import { evaluateFieldPath } from "@/runtime/db/fieldpath";
import { createQueryEngine, type QueryEngine } from "@/runtime/db/query";
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

export interface Database {
  readonly queryEngine: QueryEngine;
  readonly timestamp: Timestamp;
  getTableVersion(tableName: string): number;
  bumpTableVersions(tableNames: Iterable<string>): void;
  setStorage(storage: StorageAdapter | null): void;
  setReadBackendForTests(readBackend: AsyncReadBackend | null): void;
  setActiveIdentityKey(identityKey: string | null): void;
  getActiveIdentityKey(): string | null;
  hydrate(options?: { tables?: string[] }): Promise<void>;
  hydrateSystemTables(): Promise<void>;
  isTableHydrationAttempted(tableName: string): boolean;
  tableHydrated(tableName: string): Promise<void>;
  replicateTable(tableName: string): Promise<void>;
  startTransaction(): void;
  commit(): DatabaseCommitResult;
  commitAsync(): Promise<DatabaseCommitResult>;
  waitForPersistence(): Promise<void>;
  rollbackWrites(): void;
  get(
    tableName: TableName | undefined,
    id: DocumentId,
    options?: { countRead?: boolean },
  ): StoredDocument | null;
  insert(table: TableName, value: Record<string, unknown>): DocumentId;
  patch(
    tableName: TableName | undefined,
    id: DocumentId,
    value: Record<string, unknown>,
  ): void;
  replace(
    tableName: TableName | undefined,
    id: DocumentId,
    value: Record<string, unknown>,
  ): void;
  delete(tableName: TableName | undefined, id: DocumentId): void;
  writeDocument(
    table: TableName,
    doc: Record<string, unknown> & { _id: string; _creationTime: number },
    options?: { validate?: boolean },
  ): void;
  deleteDocument(table: TableName, id: DocumentId): boolean;
  getDocumentsForTable(tableName: string): StoredDocument[];
  hasDocumentsForTable(tableName: string): boolean;
  getTableNames(): string[];
  getIndexDefinitions(
    tableName: string,
  ): Array<{ indexName: string; fields: string[] }>;
  migrateAnonymousDataToIdentity(identityKey: string): Set<string>;
  reStampAnonymousUserTablesInStorage(identityKey: string): Promise<string[]>;
  normalizeId(table: TableName, idString: string): DocumentId | null;
  getTableForId(id: string): string | undefined;
  storeFile(storageId: DocumentId, blob: Blob): Promise<void>;
  deleteBlob(storageId: string): void;
  loadFile(storageId: DocumentId): Promise<Blob | null>;
  startQuery(query: SerializedQuery): QueryId;
  startQueryAsync(query: SerializedQuery): QueryId;
  queryNext(queryId: QueryId): {
    value: GenericDocument | null;
    done: boolean;
  };
  queryNextAsync(queryId: QueryId): Promise<{
    value: GenericDocument | null;
    done: boolean;
  }>;
  queryCleanup(queryId: QueryId): void;
  paginateAsync(args: {
    query: SerializedQuery;
    cursor: string | null;
    endCursor?: string | null;
    pageSize: number;
    maximumRowsRead?: number | null;
    maximumBytesRead?: number | null;
  }): Promise<PaginateResult>;
  count(tableName: string): number;
  countAsync(tableName: string): Promise<number>;
  getAsync(
    tableName: TableName | undefined,
    id: DocumentId,
    options?: { countRead?: boolean },
  ): Promise<StoredDocument | null>;
  ensureCommittedDocumentForWrite(
    tableName: TableName,
    id: DocumentId,
  ): Promise<boolean>;
  listDocumentsAsync(tableName: TableName): Promise<StoredDocument[]>;
  listDocumentsForScopeAsync(
    tableName: TableName,
    scopeArgs: Record<string, unknown>,
  ): Promise<StoredDocument[] | null>;
  getCommittedTableCount(tableName: string): number;
  getIndexedDocuments(tableName: string, indexName: string): StoredDocument[];
  vectorSearch(
    tableAndIndexName: string,
    vector: number[],
    filter: VectorSearchExpression | null,
    limit?: number,
  ): Array<{ _id: string; _score: number }>;
  vectorSearchAsync(
    tableAndIndexName: string,
    vector: number[],
    filter: VectorSearchExpression | null,
    limit?: number,
  ): Promise<Array<{ _id: string; _score: number }>>;
  _indexDocuments: Map<string, string[]>;
  _idTableMap: Map<string, string>;
  _addWriteRaw(id: DocumentId, newValue: StoredDocument | null): void;
}

export function createDatabase(
  schema: ParsedSchema | null,
  storage?: StorageAdapter,
  crypto?: EmbeddedCryptoProvider,
): Database {
  const documents = new Map<DocumentId, StoredDocument>();
  const blobStorage = new Map<DocumentId, Blob>();
  const tableDocuments: Map<string, Set<string>> = new Map();
  const indexDocuments: Map<string, string[]> = new Map();
  const indexDefsCache: Map<
    string,
    Array<{ indexName: string; fields: string[] }>
  > = new Map();
  const searchIndexes: Map<string, SearchIndexState> = new Map();
  const vectorIndexes: Map<string, VectorIndexState> = new Map();
  const idTableMap: Map<string, string> = new Map();
  let lastCreationTime: number = 0;
  let activeIdentityKey: string | null = null;
  let timestamp: Timestamp = 0;
  const tableVersion: Map<string, number> = new Map();
  const tablesWritten: Set<string> = new Set();
  let storageAdapter: StorageAdapter | null = storage ?? null;
  let fullyHydrated = false;
  const hydrationAttemptedTables = new Set<string>();
  const tableHydrationPromises = new Map<string, Promise<void>>();
  const tableHydrationResolvers = new Map<string, () => void>();
  const cryptoProvider: EmbeddedCryptoProvider =
    crypto ?? createAmbientCryptoProvider();
  const writes: Array<Record<DocumentId, StoredDocument | null>> = [];
  let pendingWriteCount = 0;
  const writeCounts: number[] = [];
  const writeTables: Array<Map<string, Set<string>>> = [];
  const hydrationInFlight = new Map<string, Promise<void>>();
  let pendingPersistChain: Promise<void> = Promise.resolve();
  const pendingTableState: Map<string, PendingTableState> = new Map();
  const store = createStore();

  store.setStorage(storageAdapter);

  if (schema !== null) {
    validateSchemaDefinition(schema);
  }

  function getTableVersion(tableName: string): number {
    return tableVersion.get(tableName) ?? 0;
  }

  function bumpTableVersions(tableNames: Iterable<string>): void {
    for (const tableName of tableNames) {
      tableVersion.set(tableName, (tableVersion.get(tableName) ?? 0) + 1);
    }
  }

  function setStorage(next: StorageAdapter | null): void {
    storageAdapter = next;
    store.setStorage(next);
    resetBlobState();
  }

  function setReadBackendForTests(readBackend: AsyncReadBackend | null): void {
    store.setReadBackendForTests(readBackend);
  }

  function setActiveIdentityKey(identityKey: string | null): void {
    activeIdentityKey = identityKey;
  }

  function getActiveIdentityKey(): string | null {
    return activeIdentityKey;
  }

  async function hydrate(options?: { tables?: string[] }): Promise<void> {
    if (storageAdapter === null) return;
    const scopeKey = options?.tables
      ? [...options.tables].sort().join(",")
      : "__all__";
    const inFlight = hydrationInFlight.get(scopeKey);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const promise = withSpan("convex-embedded.db.hydrate", async (span) => {
      const started = performance.now();

      const tableNames = options?.tables;
      const scopedHydration = tableNames !== undefined;
      span.setAttributes({
        "convex.db.hydrate.scoped": scopedHydration,
        "convex.db.hydrate.scope": scopedHydration
          ? tableNames.join(",")
          : "all",
      });
      if (!scopedHydration || tableNames.includes("_storage")) {
        resetBlobState();
      }
      const { documents: loaded, meta } = await withSpan(
        "convex-embedded.db.hydrate.fetch",
        () =>
          store.load(scopedHydration ? { tables: tableNames } : undefined),
      );
      const fetched = performance.now();
      span.setAttributes({
        "convex.db.hydrate.docs": loaded.length,
        "convex.db.hydrate.fetch_ms": +(fetched - started).toFixed(1),
      });

      withSpanSync("convex-embedded.db.hydrate.populate", () => {
        if (scopedHydration) {
          for (const tableName of tableNames) {
            clearCommittedTable(tableName);
            hydrationAttemptedTables.add(tableName);
          }
        } else {
          documents.clear();
          idTableMap.clear();
          tableDocuments.clear();
          fullyHydrated = true;
        }

        for (const { doc, tableName } of loaded) {
          if (tableName) {
            idTableMap.set(doc._id as string, tableName);
          }
          documents.set(doc._id, doc);
          if (tableName) {
            addCommittedIdToTable(tableName, doc._id as string);
          }
        }
      });

      await withSpan("convex-embedded.db.hydrate.rebuildIndexes", async () => {
        if (scopedHydration) {
          for (const tableName of tableNames) {
            withSpanSync(
              "convex-embedded.db.rebuildTableIndexes",
              () => rebuildTableIndexes(tableName),
              { attributes: { "convex.table": tableName } },
            );
            withSpanSync(
              "convex-embedded.db.rebuildTableSearchIndexes",
              () => rebuildTableSearchIndexes(tableName),
              { attributes: { "convex.table": tableName } },
            );
            withSpanSync(
              "convex-embedded.db.rebuildTableVectorIndexes",
              () => rebuildTableVectorIndexes(tableName),
              { attributes: { "convex.table": tableName } },
            );
            resolveTableHydration(tableName);
          }
        } else {
          withSpanSync("convex-embedded.db.rebuildAllIndexes", () =>
            rebuildAllIndexes(),
          );
          withSpanSync("convex-embedded.db.rebuildAllSearchIndexes", () =>
            rebuildAllSearchIndexes(),
          );
          withSpanSync("convex-embedded.db.rebuildAllVectorIndexes", () =>
            rebuildAllVectorIndexes(),
          );
          resolveAllTableHydrations();
        }
      });

      if (meta !== null) {
        timestamp = meta.timestamp;
        lastCreationTime = meta.lastCreationTime;
      }

      const ended = performance.now();
      span.setAttributes({
        "convex.db.hydrate.total_ms": +(ended - started).toFixed(1),
        "convex.db.hydrate.rebuild_ms": +(ended - fetched).toFixed(1),
      });
      log.info(
        `hydrate: docs=${loaded.length}, scope=${tableNames?.length ? tableNames.join(",") : "all"}, blobs=lazy, fetch=${(fetched - started).toFixed(1)}ms total=${(ended - started).toFixed(1)}ms`,
      );
    });
    hydrationInFlight.set(scopeKey, promise);
    try {
      await promise;
    } finally {
      if (hydrationInFlight.get(scopeKey) === promise) {
        hydrationInFlight.delete(scopeKey);
      }
    }
  }

  async function hydrateSystemTables(): Promise<void> {
    if (storageAdapter === null) return;
    if (!store.isQueryable()) {
      return hydrate();
    }
    return hydrate({ tables: [...RUNTIME_SYSTEM_TABLES] });
  }

  function isTableHydrationAttempted(tableName: string): boolean {
    return fullyHydrated || hydrationAttemptedTables.has(tableName);
  }

  function tableHydrated(tableName: string): Promise<void> {
    if (
      storageAdapter === null ||
      fullyHydrated ||
      isQueryableTable(tableName)
    ) {
      return Promise.resolve();
    }
    return ensureTableHydrationEntry(tableName);
  }

  function ensureTableHydrationEntry(tableName: string): Promise<void> {
    const existing = tableHydrationPromises.get(tableName);
    if (existing !== undefined) {
      return existing;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    tableHydrationPromises.set(tableName, promise);
    tableHydrationResolvers.set(tableName, resolve);
    return promise;
  }

  function resolveTableHydration(tableName: string): void {
    const resolver = tableHydrationResolvers.get(tableName);
    if (resolver !== undefined) {
      resolver();
      tableHydrationResolvers.delete(tableName);
      return;
    }
    tableHydrationPromises.set(tableName, Promise.resolve());
  }

  function resolveAllTableHydrations(): void {
    for (const resolver of tableHydrationResolvers.values()) {
      resolver();
    }
    tableHydrationResolvers.clear();
  }

  async function replicateTable(tableName: string): Promise<void> {
    if (storageAdapter === null) return;

    const { docs, meta } = await store.refreshTable({ tableName });

    if (docs !== null) {
      const oldIds = tableDocuments.get(tableName);
      let changed = !oldIds || oldIds.size !== docs.length;
      if (!changed) {
        for (const doc of docs) {
          if (!oldIds!.has(doc._id as string)) {
            changed = true;
            break;
          }
          if (!structuralEqual(documents.get(doc._id), doc)) {
            changed = true;
            break;
          }
        }
      }

      for (const id of oldIds ?? []) {
        documents.delete(id as DocumentId);
        idTableMap.delete(id);
      }
      tableDocuments.set(tableName, new Set());

      for (const doc of docs) {
        documents.set(doc._id, doc);
        idTableMap.set(doc._id as string, tableName);
        addCommittedIdToTable(tableName, doc._id as string);
      }

      if (changed) {
        rebuildTableIndexes(tableName);
        rebuildTableSearchIndexes(tableName);
        rebuildTableVectorIndexes(tableName);
      }
    }

    if (meta !== null) {
      if (meta.timestamp > timestamp) {
        timestamp = meta.timestamp;
      }
      if (meta.lastCreationTime > lastCreationTime) {
        lastCreationTime = meta.lastCreationTime;
      }
    }
  }

  function startTransaction(): void {
    writes.push({});
    writeCounts.push(0);
    writeTables.push(new Map());
  }

  function commit(): DatabaseCommitResult {
    const lastWrites = popCommittedWriteLevel();

    if (writes.length === 0) {
      if (store.usesExternalCommitPath() && tablesWritten.size > 0) {
        throw new Error(
          "SQL-backed outer commits with adapter apply support must use commitAsync()",
        );
      }

      const { puts, deletes, rowChanges, stateChanges, invalidation } =
        buildCommittedWriteArtifacts(lastWrites);
      applyCommittedRowChanges(rowChanges);

      const written = new Set(tablesWritten);
      if (written.size > 0) {
        timestamp += 1;
        bumpTableVersions(written);
        applyCommittedStateChanges(stateChanges);
      }
      tablesWritten.clear();
      pendingTableState.clear();

      const persisted = persistCommitBatch({
        puts,
        deletes,
        meta: {
          timestamp,
          lastCreationTime,
        },
      });

      return {
        timestamp,
        tablesWritten: written,
        invalidation,
        persisted,
      };
    }

    return mergeNestedCommittedWriteLevel(lastWrites);
  }

  async function commitAsync(): Promise<DatabaseCommitResult> {
    return withSpan("convex-embedded.db.commit", () => {
      recordCounter("commit");
      return commitAsyncImpl();
    });
  }

  async function commitAsyncImpl(): Promise<DatabaseCommitResult> {
    const isSqlCommit = store.usesExternalCommitPath();
    if (!isSqlCommit) {
      return commit();
    }

    if (writes.length === 0) {
      throw new Error("Transaction already committed or rolled back");
    }

    if (writes.length > 1) {
      const lastWrites = popCommittedWriteLevel();
      return mergeNestedCommittedWriteLevel(lastWrites);
    }

    const lastWrites = writes[writes.length - 1] ?? {};
    const written = new Set(tablesWritten);
    for (const id of Object.keys(lastWrites)) {
      const tableName = idTableMap.get(id);
      if (tableName !== undefined) {
        written.add(tableName);
      }
    }

    if (written.size === 0) {
      popCommittedWriteLevel();
      tablesWritten.clear();
      return {
        timestamp,
        tablesWritten: written,
        invalidation: { tables: new Set(), changes: [] },
        persisted: Promise.resolve(),
      };
    }

    const { puts, deletes, rowChanges, stateChanges, invalidation } =
      buildCommittedWriteArtifacts(lastWrites);
    const nextTimestamp = timestamp + 1;
    bumpTableVersions(written);

    const batch = {
      puts,
      deletes,
      meta: {
        timestamp: nextTimestamp,
        lastCreationTime,
      },
    } satisfies CommitBatch;

    const materializedTables = Array.from(written).filter(
      (tableName) => !isQueryableTable(tableName),
    );

    const writeOptions = {
      materializedTables,
      tableSearchIndexes: collectTableSearchIndexes(),
      tableVectorIndexes: collectTableVectorIndexes(),
    };

    const allWrittenTablesAlreadyHydrated = materializedTables.every(
      (tableName) => isTableHydrationAttempted(tableName),
    );

    if (allWrittenTablesAlreadyHydrated) {
      popCommittedWriteLevel();
      applyCommittedIdHints(rowChanges);
      timestamp = nextTimestamp;
      lastCreationTime = batch.meta.lastCreationTime;
      if (rowChanges.length > 0) {
        applyCommittedRowChanges(rowChanges);
        applyCommittedStateChanges(stateChanges, {
          skipQueryable: false,
        });
      }
      tablesWritten.clear();

      const persisted = enqueueAsyncCommit(batch, writeOptions);

      return {
        timestamp,
        tablesWritten: written,
        invalidation,
        persisted,
      };
    }

    const applied = await store.write(batch, writeOptions);
    if (applied === null) {
      throw new Error(
        "[convex-embedded] expected committed store to apply external top-level commit",
      );
    }

    popCommittedWriteLevel();
    applyCommittedIdHints(rowChanges);
    timestamp = applied.meta.timestamp;
    lastCreationTime = applied.meta.lastCreationTime;
    for (const snapshot of applied.tables) {
      replaceCommittedTableSnapshot(snapshot.tableName, snapshot.docs);
    }
    const queryableRowChanges = rowChanges.filter(
      (change) => change.tableName !== "" && isQueryableTable(change.tableName),
    );
    if (queryableRowChanges.length > 0) {
      applyCommittedRowChanges(queryableRowChanges);
      const dirtyTables = new Set<string>();
      for (const change of queryableRowChanges) {
        dirtyTables.add(change.tableName);
      }
      for (const tableName of dirtyTables) {
        rebuildTableIndexes(tableName);
        rebuildTableSearchIndexes(tableName);
        rebuildTableVectorIndexes(tableName);
      }
    }
    tablesWritten.clear();

    return {
      timestamp,
      tablesWritten: written,
      invalidation,
      persisted: Promise.resolve(),
    };
  }

  function enqueueAsyncCommit(
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
    const previous = pendingPersistChain;
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await store.write(batch, options);
      });
    pendingPersistChain = next.catch(() => undefined);
    return next;
  }

  async function waitForPersistence(): Promise<void> {
    await pendingPersistChain;
  }

  function rollbackWrites(): void {
    if (writes.length === 0) {
      throw new Error("Transaction already committed or rolled back");
    }
    writes.pop();
    pendingWriteCount -= writeCounts.pop() ?? 0;
    writeTables.pop();
    pendingTableState.clear();
  }

  function get(
    tableName: TableName | undefined,
    id: DocumentId,
    _options: { countRead?: boolean } = {},
  ): StoredDocument | null {
    if (!validateId(tableName, id)) {
      return null;
    }

    const document = getRaw(id);
    if (document === null || !isVisibleInScope(tableName, document)) {
      return null;
    }

    return stripIdentityScope(document);
  }

  function insert(table: TableName, value: Record<string, unknown>): DocumentId {
    validate(table, value as GenericDocument);
    let _id: DocumentId | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = cryptoProvider.randomUUID() as unknown as DocumentId;
      if (
        !idTableMap.has(candidate as string) &&
        getRaw(candidate) === null
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
    idTableMap.set(_id as string, table);
    const now = Date.now();
    const _creationTime =
      now <= lastCreationTime ? lastCreationTime + 0.001 : now;
    lastCreationTime = _creationTime;
    addWrite(
      _id,
      withIdentityScope(table, { ...value, _id, _creationTime }),
    );
    return _id;
  }

  function patch(
    tableName: TableName | undefined,
    id: DocumentId,
    value: Record<string, unknown>,
  ): void {
    const idText = formatValueForError(id);
    if (!validateId(tableName, id)) {
      throw patchMissingDocError("Patch", tableName, idText);
    }

    if (typeof value !== "object" || value === null) {
      throw new Error(
        `Invalid argument \`value\` in \`db.patch\`, expected object but got '${typeof value}': ${String(value)}`,
      );
    }

    const rawDocument = getRaw(id);
    if (rawDocument === null || !isVisibleInScope(tableName, rawDocument)) {
      throw patchMissingDocError("Patch", tableName, idText);
    }
    const document = stripIdentityScope(rawDocument);

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
    validate(idTableMap.get(_id as string)!, merged as GenericDocument);
    addWrite(
      id,
      withIdentityScope(tableName, { _id, _creationTime, ...merged }),
    );
  }

  function replace(
    tableName: TableName | undefined,
    id: DocumentId,
    value: Record<string, unknown>,
  ): void {
    const idText = formatValueForError(id);
    if (!validateId(tableName, id)) {
      throw patchMissingDocError("Replace", tableName, idText);
    }

    if (typeof value !== "object" || value === null) {
      throw new Error(
        `Invalid argument \`value\` in \`db.replace\`, expected object but got '${typeof value}': ${String(value)}`,
      );
    }

    const rawDocument = getRaw(id);
    if (rawDocument === null || !isVisibleInScope(tableName, rawDocument)) {
      throw patchMissingDocError("Replace", tableName, idText);
    }
    const document = stripIdentityScope(rawDocument);

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

    validate(
      idTableMap.get(document._id as string)!,
      convexValue as GenericDocument,
    );
    addWrite(
      id,
      withIdentityScope(tableName, {
        ...convexValue,
        _id: document._id,
        _creationTime: document._creationTime,
      }),
    );
  }

  function deleteDoc(
    tableName: TableName | undefined,
    id: DocumentId,
  ): void {
    if (!validateId(tableName, id)) {
      throw new Error("Delete on non-existent doc");
    }

    const rawDocument = getRaw(id);
    if (rawDocument === null || !isVisibleInScope(tableName, rawDocument)) {
      throw new Error("Delete on non-existent doc");
    }
    addWrite(id, null);
  }

  function writeDocument(
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
      validate(table, userFields as GenericDocument);
    }

    const existingTable = idTableMap.get(_id);

    if (existingTable !== undefined) {
      if (existingTable !== table) {
        throw new Error(
          `writeDocument: ID "${_id}" belongs to table "${existingTable}", ` +
            `not "${table}"`,
        );
      }
      addWrite(
        docId,
        withIdentityScope(table, {
          _id: docId,
          _creationTime,
          ...userFields,
        }),
      );
    } else {
      idTableMap.set(_id, table);

      if (_creationTime > lastCreationTime) {
        lastCreationTime = _creationTime;
      }

      addWrite(
        docId,
        withIdentityScope(table, {
          _id: docId,
          _creationTime,
          ...userFields,
        }),
      );
    }
  }

  function deleteDocument(table: TableName, id: DocumentId): boolean {
    const existingTable = idTableMap.get(id as string);
    if (existingTable === undefined) {
      return false;
    }

    if (existingTable !== table) {
      throw new Error(
        `deleteDocument: ID "${id}" belongs to table "${existingTable}", ` +
          `not "${table}"`,
      );
    }

    const rawDocument = getRaw(id);
    if (rawDocument === null || !isVisibleInScope(table, rawDocument)) {
      return false;
    }

    addWrite(id, null);
    return true;
  }

  function getDocumentsForTable(tableName: string): StoredDocument[] {
    const results: StoredDocument[] = [];
    iterateDocs(tableName, (doc) => results.push(doc));
    return results;
  }

  function hasDocumentsForTable(tableName: string): boolean {
    return (tableDocuments.get(tableName)?.size ?? 0) > 0;
  }

  function getTableNames(): string[] {
    const names = new Set<string>();
    if (schema) {
      for (const name of schema.tables.keys()) {
        names.add(name);
      }
    }
    for (const name of tableDocuments.keys()) {
      names.add(name);
    }
    return [...names].sort();
  }

  function getIndexDefinitions(
    tableName: string,
  ): Array<{ indexName: string; fields: string[] }> {
    return getIndexDefinitionsInternal(tableName).map((definition) => ({
      indexName: definition.indexName,
      fields: [...definition.fields],
    }));
  }

  function migrateAnonymousDataToIdentity(identityKey: string): Set<string> {
    const written = new Set<string>();
    for (const [id, doc] of documents) {
      const tableName = idTableMap.get(id);
      if (!tableName || !isIdentityScopedTable(tableName)) {
        continue;
      }
      if ((doc as IdentityScopedDocument)[IDENTITY_SCOPE_FIELD] != null) {
        continue;
      }
      addWrite(id as DocumentId, {
        ...(doc as IdentityScopedDocument),
        [IDENTITY_SCOPE_FIELD]: identityKey,
      });
      written.add(tableName);
    }
    return written;
  }

  async function reStampAnonymousUserTablesInStorage(
    identityKey: string,
  ): Promise<string[]> {
    const adapter = storageAdapter as
      | (StorageAdapter & {
          reStampAnonymousIdentity?: (key: string) => Promise<string[]>;
        })
      | null;
    if (!adapter?.reStampAnonymousIdentity) {
      return [];
    }
    const changed = await adapter.reStampAnonymousIdentity(identityKey);
    for (const tableName of changed) {
      evictCommittedTable(tableName);
    }
    return changed;
  }

  function evictCommittedTable(tableName: string): void {
    const ids = tableDocuments.get(tableName);
    if (!ids) {
      return;
    }
    for (const id of ids) {
      documents.delete(id as DocumentId);
    }
    tableDocuments.delete(tableName);
  }

  function normalizeId(table: TableName, idString: string): DocumentId | null {
    if (typeof idString !== "string") return null;
    return idTableMap.get(idString) === table
      ? (idString as DocumentId)
      : null;
  }

  function getTableForId(id: string): string | undefined {
    return idTableMap.get(id);
  }

  async function storeFile(storageId: DocumentId, blob: Blob): Promise<void> {
    blobStorage.set(storageId, blob);

    if (storageAdapter) {
      await storageAdapter.storeBlob(storageId as string, blob);
    }
  }

  function deleteBlob(storageId: string): void {
    blobStorage.delete(storageId as DocumentId);

    if (storageAdapter) {
      storageAdapter.deleteBlob(storageId).catch((error) => {
        log.error("blob delete failed:", error);
      });
    }
  }

  async function loadFile(storageId: DocumentId): Promise<Blob | null> {
    if (get("_storage", storageId) === null) {
      return null;
    }

    const cached = blobStorage.get(storageId) ?? null;
    if (cached !== null) {
      return cached;
    }

    if (storageAdapter === null) {
      return null;
    }

    const blob = await storageAdapter.getBlob(storageId as string);
    if (blob !== null) {
      blobStorage.set(storageId, blob);
    }
    return blob;
  }

  function startQuery(query: SerializedQuery): QueryId {
    return queryEngine.startQuery(query);
  }

  function startQueryAsync(query: SerializedQuery): QueryId {
    return queryEngine.startQueryAsync(query);
  }

  function queryNext(queryId: QueryId): {
    value: GenericDocument | null;
    done: boolean;
  } {
    return queryEngine.queryNext(queryId);
  }

  function queryNextAsync(queryId: QueryId): Promise<{
    value: GenericDocument | null;
    done: boolean;
  }> {
    return queryEngine.queryNextAsync(queryId);
  }

  function queryCleanup(queryId: QueryId): void {
    queryEngine.queryCleanup(queryId);
  }

  function paginateAsync(args: {
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
      const result = await queryEngine.paginateAsync(args);
      span.setAttribute("convex.page.returned", result.page.length);
      span.setAttribute("convex.page.is_done", result.isDone);
      return result;
    });
  }

  function count(tableName: string): number {
    return queryEngine.count(tableName);
  }

  function countAsync(tableName: string): Promise<number> {
    if (!hasPendingWritesForTable(tableName)) {
      return store
        .countDocuments(
          tableName as TableName,
          storageReadOptions(tableName),
        )
        .then((c) => c ?? count(tableName));
    }
    return Promise.resolve(count(tableName));
  }

  async function getAsync(
    tableName: TableName | undefined,
    id: DocumentId,
    options: { countRead?: boolean } = {},
  ): Promise<StoredDocument | null> {
    let resolvedTable =
      tableName ?? (idTableMap.get(id as string) as TableName | undefined);
    if (
      resolvedTable !== undefined &&
      isTableHydrationAttempted(resolvedTable) &&
      !hasPendingWritesForTable(resolvedTable)
    ) {
      const inMemory = getRaw(id);
      if (inMemory !== null) {
        return visibleDocumentInScope(resolvedTable, inMemory);
      }
    }
    if (resolvedTable === undefined) {
      resolvedTable = (await findTableForIdViaBackend(id)) as
        | TableName
        | undefined;
    }
    if (
      resolvedTable !== undefined &&
      !hasPendingWritesForTable(resolvedTable)
    ) {
      const document = await store.getDocument(
        resolvedTable,
        id,
        storageReadOptions(resolvedTable),
      );
      if (document !== null) {
        rememberCommittedLookup(resolvedTable, [document]);
      }
      if (document !== null) {
        return stripIdentityScope(document as IdentityScopedDocument);
      }
    }
    return get(resolvedTable, id, options);
  }

  async function findTableForIdViaBackend(
    id: DocumentId,
  ): Promise<string | undefined> {
    if (!schema) {
      return undefined;
    }
    for (const [tableName] of schema.tables) {
      if (isSystemTable(tableName)) {
        continue;
      }
      const found = await store.getDocument(
        tableName,
        id,
        storageReadOptions(tableName),
      );
      if (found !== null) {
        idTableMap.set(id as string, tableName);
        return tableName;
      }
    }
    return undefined;
  }

  async function ensureCommittedDocumentForWrite(
    tableName: TableName,
    id: DocumentId,
  ): Promise<boolean> {
    if (getRaw(id) !== null) {
      return true;
    }

    if (isTableHydrationAttempted(tableName)) {
      return false;
    }

    const document = await store.getDocument(
      tableName,
      id,
      storageReadOptions(tableName),
    );
    if (document === null) {
      return false;
    }

    idTableMap.set(id, tableName);
    cacheCommittedDocument(tableName, document);
    return true;
  }

  async function listDocumentsAsync(
    tableName: TableName,
  ): Promise<StoredDocument[]> {
    if (isTableHydrationAttempted(tableName)) {
      return getDocumentsForTable(tableName);
    }
    if (!hasPendingWritesForTable(tableName)) {
      const docs = await store.getDocuments(
        tableName,
        storageReadOptions(tableName),
      );
      if (docs !== null) {
        rememberCommittedLookup(tableName, docs);
        return stripIdentityScopes(docs);
      }
    }
    return getDocumentsForTable(tableName);
  }

  async function listDocumentsForScopeAsync(
    tableName: TableName,
    scopeArgs: Record<string, unknown>,
  ): Promise<StoredDocument[] | null> {
    const scopeKeys = Object.keys(scopeArgs);
    if (scopeKeys.length === 0) {
      return listDocumentsAsync(tableName);
    }
    const wantedKeys = new Set(scopeKeys);
    const index = getIndexDefinitions(tableName).find((definition) => {
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
    const evaluation = await readOptimizedSourceAsync(source);
    return evaluation?.results ?? null;
  }

  function getCommittedTableCount(tableName: string): number {
    return tableDocuments.get(tableName)?.size ?? 0;
  }

  function getIndexedDocuments(
    tableName: string,
    indexName: string,
  ): StoredDocument[] {
    const indexKey = `${tableName}.${indexName}`;
    const ids = indexDocuments.get(indexKey);
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
    if (ids.length === 0) {
      return [];
    }
    if (ids.length === 1) {
      const doc = documents.get(ids[0] as DocumentId);
      return doc === undefined
        ? []
        : [stripIdentityScope(doc as IdentityScopedDocument)];
    }

    const uniqueIds: string[] = [];
    const seenIds = new Set<string>();
    for (const id of ids) {
      const key = id as string;
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      uniqueIds.push(key);
    }

    if (uniqueIds.length !== ids.length) {
      const duplicates = new Set<string>();
      const seen = new Set<string>();
      for (const id of ids) {
        const key = id as string;
        if (seen.has(key)) duplicates.add(key);
        else seen.add(key);
      }
      log.warn(
        `duplicate committed ids detected for ${indexKey}: ${Array.from(duplicates).join(", ")}; rebuilding index`,
      );
      rebuildTableIndexes(tableName);
      return lookupAndStrip(indexDocuments.get(indexKey) ?? []);
    }

    return lookupAndStrip(uniqueIds);
  }

  function vectorSearch(
    tableAndIndexName: string,
    vector: number[],
    filter: VectorSearchExpression | null,
    limit?: number,
  ): Array<{ _id: string; _score: number }> {
    const [tableName, indexName] = tableAndIndexName.split(".") as [
      string,
      string,
    ];
    const state = vectorIndexes.get(`${tableName}.${indexName}`);
    if (state) {
      getVectorIndexDefinition(
        schema?.tables.get(tableName)?.vectorIndexes,
        tableName,
        indexName,
      );

      if (!hasPendingWritesForTable(tableName)) {
        return executeVectorSearch(state, {
          vector,
          limit,
          filter,
          activeIdentityKey,
        });
      }

      return executeOverlayVectorSearch(
        state,
        buildPendingVectorOverlay(tableName, state),
        {
          vector,
          limit,
          filter,
          activeIdentityKey,
        },
      );
    }

    return queryEngine.vectorSearch(tableAndIndexName, vector, filter, limit);
  }

  async function vectorSearchAsync(
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
      schema?.tables.get(tableName)?.vectorIndexes,
      tableName,
      indexName,
    );

    if (isQueryableTable(tableName)) {
      const candidates =
        (await store.vectorSearch({
          tableName,
          indexName,
          definition,
          filter,
          activeIdentityKey,
        })) ?? [];
      rememberCommittedLookup(tableName, candidates);
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
      if (!hasPendingWritesForTable(tableName)) {
        return executeVectorSearch(baseState, {
          vector,
          limit,
          filter,
          activeIdentityKey,
        });
      }
      return executeOverlayVectorSearch(
        baseState,
        buildPendingVectorOverlay(tableName, baseState),
        {
          vector,
          limit,
          filter,
          activeIdentityKey,
        },
      );
    }

    return vectorSearch(tableAndIndexName, vector, filter, limit);
  }

  function validateId(
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

    const actualTableName = idTableMap.get(id);
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

  function patchMissingDocError(
    op: "Patch" | "Replace",
    tableName: TableName | undefined,
    idText: string,
  ): Error {
    if (
      typeof tableName === "string" &&
      isQueryableTable(tableName) &&
      !tableDocuments.has(tableName)
    ) {
      return new Error(
        `[convex-embedded] ${op} on SQL-backed table "${tableName}" requires the document to be hydrated first (id ${idText}). ` +
          `Await a read (e.g. db.get / db.query) on this table before calling ${op.toLowerCase()} so committed rows are materialized.`,
      );
    }
    return new Error(`${op} on non-existent document with ID "${idText}"`);
  }

  function validate(tableName: string, doc: GenericDocument): void {
    if (schema === null || !schema.schemaValidation) {
      return;
    }
    const validator = schema.tables.get(tableName)?.documentType;
    if (validator === undefined) {
      return;
    }
    validateValidator(validator, doc, (id) => idTableMap.get(id));
  }

  function addWrite(id: DocumentId, newValue: StoredDocument | null): void {
    if (writes.length === 0) {
      throw new Error(`Write outside of transaction ${id}`);
    }
    registerWrite(writes.length - 1, id, newValue);
  }

  function addWriteRaw(id: DocumentId, newValue: StoredDocument | null): void {
    registerWrite(writes.length - 1, id, newValue);
  }

  function registerWrite(
    level: number,
    id: DocumentId,
    newValue: StoredDocument | null,
  ): void {
    const levelWrites = writes[level]!;
    if (levelWrites[id] === undefined) {
      pendingWriteCount += 1;
      writeCounts[level] = (writeCounts[level] ?? 0) + 1;
      const tableName = idTableMap.get(id as string);
      if (tableName) {
        pendingTableState.delete(tableName);
        let ids = writeTables[level]?.get(tableName);
        if (!ids) {
          ids = new Set();
          writeTables[level]?.set(tableName, ids);
        }
        ids.add(id as string);
      }
    }

    levelWrites[id] = newValue;
  }

  function popCommittedWriteLevel(): Record<DocumentId, StoredDocument | null> {
    const lastWrites = writes.pop();
    const lastWriteCount = writeCounts.pop();
    writeTables.pop();
    if (lastWrites === undefined) {
      throw new Error("Transaction already committed or rolled back");
    }
    pendingWriteCount -= lastWriteCount ?? 0;
    pendingTableState.clear();

    for (const id of Object.keys(lastWrites)) {
      const table = idTableMap.get(id);
      if (table !== undefined) {
        tablesWritten.add(table);
      }
    }

    return lastWrites;
  }

  function mergeNestedCommittedWriteLevel(
    lastWrites: Record<DocumentId, StoredDocument | null>,
  ): DatabaseCommitResult {
    for (const [id, write] of Object.entries(lastWrites)) {
      addWriteRaw(id as DocumentId, write);
    }

    return {
      timestamp,
      tablesWritten: new Set(tablesWritten),
      invalidation: { tables: new Set(), changes: [] },
      persisted: Promise.resolve(),
    };
  }

  function buildCommittedWriteArtifacts(
    lastWrites: Record<DocumentId, StoredDocument | null>,
  ): CommittedWriteArtifacts {
    return Object.entries(lastWrites).reduce<CommittedWriteArtifacts>(
      (acc, [id, write]) => {
        const docId = id as DocumentId;
        const tableName = idTableMap.get(id) ?? "";
        const shouldMaterialize = true;
        const before =
          (documents.get(docId) as IdentityScopedDocument | undefined) ?? null;

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
                before: before ? stripIdentityScope(before) : null,
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
              before: before ? stripIdentityScope(before) : null,
              after: stripIdentityScope(write as IdentityScopedDocument),
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

  function applyCommittedRowChanges(changes: CommittedRowChange[]): void {
    for (const change of changes) {
      const { tableName, id, after, shouldMaterialize } = change;
      if (after === null) {
        documents.delete(id);
        if (tableName) {
          removeCommittedIdFromTable(tableName, id);
        }
        idTableMap.delete(id);
        continue;
      }

      if (shouldMaterialize) {
        documents.set(id, after);
        if (tableName) {
          addCommittedIdToTable(tableName, id);
        }
      } else {
        documents.delete(id);
        if (tableName) {
          removeCommittedIdFromTable(tableName, id);
        }
      }
      if (tableName) {
        idTableMap.set(id, tableName);
      }
    }
  }

  function applyCommittedIdHints(changes: CommittedRowChange[]): void {
    for (const change of changes) {
      const { tableName, id, after } = change;
      if (after === null) {
        idTableMap.delete(id);
        if (tableName) {
          removeCommittedIdFromTable(tableName, id);
        }
        continue;
      }
      if (tableName) {
        idTableMap.set(id, tableName);
      }
    }
  }

  function persistCommitBatch(batch: CommitBatch): Promise<void> {
    if (storageAdapter === null) return Promise.resolve();
    if (batch.puts.length === 0 && batch.deletes.length === 0) {
      return Promise.resolve();
    }
    const write = (
      storageAdapter as { write?: (b: CommitBatch) => Promise<unknown> }
    ).write;
    if (typeof write !== "function") return Promise.resolve();
    return write.call(storageAdapter, batch).then(() => {});
  }

  function iterateDocs(
    tableName: string,
    callback: (doc: StoredDocument) => void,
  ): void {
    if (!hasPendingWritesForTable(tableName)) {
      for (const id of tableDocuments.get(tableName) ?? []) {
        const document = documents.get(id as DocumentId) as
          | IdentityScopedDocument
          | undefined;
        const visible =
          document === undefined
            ? null
            : visibleDocumentInScope(tableName, document);
        if (visible !== null) {
          callback(visible);
        }
      }
      return;
    }

    const seen = new Set<string>();
    for (let level = writes.length - 1; level >= 0; level -= 1) {
      const ids = writeTables[level]?.get(tableName);
      if (!ids) {
        continue;
      }

      for (const id of ids) {
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);

        const document = writes[level]?.[id as DocumentId] as
          | IdentityScopedDocument
          | null
          | undefined;
        const visible =
          document === undefined || document === null
            ? null
            : visibleDocumentInScope(tableName, document);
        if (visible !== null) {
          callback(visible);
        }
      }
    }

    for (const id of tableDocuments.get(tableName) ?? []) {
      if (seen.has(id)) {
        continue;
      }
      const document = documents.get(id as DocumentId) as
        | IdentityScopedDocument
        | undefined;
      const visible =
        document === undefined
          ? null
          : visibleDocumentInScope(tableName, document);
      if (visible !== null) {
        callback(visible);
      }
    }
  }

  function getRaw(id: DocumentId): IdentityScopedDocument | null {
    let hasPendingWrite = false;
    let document: IdentityScopedDocument | null = null;

    for (let i = writes.length - 1; i >= 0; i--) {
      const write = writes[i]![id];
      if (write !== undefined) {
        hasPendingWrite = true;
        document = write as IdentityScopedDocument | null;
        break;
      }
    }

    if (!hasPendingWrite) {
      document =
        (documents.get(id) as IdentityScopedDocument | undefined) ?? null;
    }

    return document;
  }

  function isIdentityScopedTable(tableName: TableName | undefined): boolean {
    return typeof tableName === "string" && !tableName.startsWith("_");
  }

  function isVisibleInScope(
    tableName: TableName | undefined,
    document: IdentityScopedDocument,
  ): boolean {
    if (!isIdentityScopedTable(tableName)) {
      return true;
    }
    return (document[IDENTITY_SCOPE_FIELD] ?? null) === activeIdentityKey;
  }

  function withIdentityScope<T extends Record<string, unknown>>(
    tableName: TableName | undefined,
    document: T,
  ): T & { [IDENTITY_SCOPE_FIELD]?: string | null } {
    if (!isIdentityScopedTable(tableName)) {
      return document;
    }

    return {
      ...document,
      [IDENTITY_SCOPE_FIELD]: activeIdentityKey,
    };
  }

  function stripIdentityScope(
    document: IdentityScopedDocument,
  ): StoredDocument {
    if (!(IDENTITY_SCOPE_FIELD in document)) {
      return document as StoredDocument;
    }
    const { [IDENTITY_SCOPE_FIELD]: _identityKey, ...rest } = document;
    return rest as StoredDocument;
  }

  function stripIdentityScopes(
    docs: readonly StoredDocument[],
  ): StoredDocument[] {
    return docs.map((doc) => stripIdentityScope(doc as IdentityScopedDocument));
  }

  function lookupAndStrip(ids: readonly string[]): StoredDocument[] {
    const out: StoredDocument[] = [];
    for (let i = 0; i < ids.length; i++) {
      const doc = documents.get(ids[i] as DocumentId);
      if (doc !== undefined)
        out.push(stripIdentityScope(doc as IdentityScopedDocument));
    }
    return out;
  }

  function visibleDocumentInScope(
    tableName: TableName | undefined,
    document: IdentityScopedDocument,
  ): StoredDocument | null {
    return isVisibleInScope(tableName, document)
      ? stripIdentityScope(document)
      : null;
  }

  function getPendingTableState(tableName: string): PendingTableState {
    const cached = pendingTableState.get(tableName);
    if (cached) {
      return cached;
    }

    const shadowedIds = new Set<string>();
    const rawVisibleDocs = new Map<string, IdentityScopedDocument>();
    for (let level = writes.length - 1; level >= 0; level -= 1) {
      const ids = writeTables[level]?.get(tableName);
      if (!ids) {
        continue;
      }

      for (const id of ids) {
        if (shadowedIds.has(id)) {
          continue;
        }
        shadowedIds.add(id);

        const document = writes[level]?.[id as DocumentId] as
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
    pendingTableState.set(tableName, state);
    return state;
  }

  function getVisiblePendingDocs(tableName: string): Array<{
    doc: StoredDocument;
    identityKey: string | null;
  }> {
    const pending = getPendingTableState(tableName);
    if (pending.visiblePendingDocs) {
      return pending.visiblePendingDocs;
    }

    const docs: Array<{ doc: StoredDocument; identityKey: string | null }> = [];
    for (const document of pending.rawVisibleDocs.values()) {
      const visible = visibleDocumentInScope(tableName, document);
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

  function rememberCommittedLookup(
    tableName: string,
    docs: readonly StoredDocument[],
  ): void {
    for (const doc of docs) {
      if (typeof doc._id === "string") {
        idTableMap.set(doc._id, tableName);
        cacheCommittedDocument(tableName, doc);
      }
    }
  }

  function cacheCommittedDocument(
    tableName: string,
    doc: StoredDocument,
  ): void {
    const scoped =
      isIdentityScopedTable(tableName) &&
      (doc as IdentityScopedDocument)[IDENTITY_SCOPE_FIELD] === undefined
        ? withIdentityScope(tableName, doc)
        : (doc as IdentityScopedDocument);
    documents.set(doc._id as DocumentId, scoped);
    addCommittedIdToTable(tableName, doc._id);
  }

  function addCommittedIdToTable(tableName: string, id: string): void {
    let ids = tableDocuments.get(tableName);
    if (!ids) {
      ids = new Set();
      tableDocuments.set(tableName, ids);
    }
    ids.add(id);
  }

  function removeCommittedIdFromTable(tableName: string, id: string): void {
    const ids = tableDocuments.get(tableName);
    if (!ids) {
      return;
    }
    ids.delete(id);
    if (ids.size === 0) {
      tableDocuments.delete(tableName);
    }
  }

  function clearCommittedTable(tableName: string): void {
    for (const id of tableDocuments.get(tableName) ?? []) {
      documents.delete(id as DocumentId);
      idTableMap.delete(id);
    }
    tableDocuments.set(tableName, new Set());
  }

  function replaceCommittedTableSnapshot(
    tableName: string,
    docs: readonly StoredDocument[],
  ): void {
    clearCommittedTable(tableName);
    for (const doc of docs) {
      documents.set(doc._id, withIdentityScope(tableName, doc));
      idTableMap.set(doc._id as string, tableName);
      addCommittedIdToTable(tableName, doc._id as string);
    }
    rebuildTableIndexes(tableName);
    rebuildTableSearchIndexes(tableName);
    rebuildTableVectorIndexes(tableName);
  }

  function resetBlobState(): void {
    blobStorage.clear();
  }

  function readOptimizedSource(
    source: SerializedQuery["source"],
    limit?: number | null,
    seek?: SeekBound,
  ): SourceEvaluationLike | null {
    if (source.type === "FullTableScan") {
      const indexName =
        source.order === "desc" ? "by_creation_time_desc" : "by_creation_time";
      const order = source.order ?? "asc";
      if (hasPendingWritesForTable(source.tableName)) {
        return {
          results: applySeekToOrderedDocs(
            getMergedIndexedDocuments(source.tableName, indexName),
            seek,
          ),
          fieldPathsToSortBy: [],
          order,
          presorted: true,
        };
      }
      const ids = indexedIds(source.tableName, indexName);
      if (ids === null) {
        return {
          results: applySeekToOrderedDocs(
            getIndexedDocuments(source.tableName, indexName),
            seek,
          ),
          fieldPathsToSortBy: [],
          order,
          presorted: true,
        };
      }
      return {
        results: readIndexWindow({
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
      const fields = getIndexDefinitionsInternal(tableName).find(
        (entry) => entry.indexName === indexName,
      )?.fields;
      if (!fields) {
        throw new Error(
          `Cannot use index "${indexName}" for table "${tableName}" because it is not declared in the schema.`,
        );
      }

      const lower = buildRangeBound([...source.range], fields, "lower");
      const upper = buildRangeBound([...source.range], fields, "upper");
      const predicate = buildRangePredicate(source.range);
      const hasPending = hasPendingWritesForTable(tableName);

      if (hasPending && source.order === "asc") {
        return {
          results: applySeekToOrderedDocs(
            collectMergedIndexRangeDocs(
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
        const ids = indexedIds(tableName, indexName);
        if (ids !== null) {
          return {
            results: readIndexWindow({
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
        ? getMergedIndexedDocuments(tableName, indexName)
        : getIndexedDocuments(tableName, indexName);
      const start = lower
        ? binarySearchLowerBound(sourceDocs, fields, lower)
        : 0;
      const end = upper
        ? binarySearchUpperBound(sourceDocs, fields, upper)
        : sourceDocs.length;
      const filteredDocs = sourceDocs.slice(start, end).filter(predicate);
      const ordered =
        source.order === "desc" ? [...filteredDocs].reverse() : filteredDocs;
      return {
        results: applySeekToOrderedDocs(ordered, seek),
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
      const state = searchIndexes.get(`${tableName}.${indexName}`);
      if (!state) return null;
      const args = {
        source,
        activeIdentityKey,
        limit: limit ?? undefined,
      };
      const results = hasPendingWritesForTable(tableName)
        ? executeOverlaySearch(
            state,
            buildPendingSearchOverlay(tableName, state),
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

  async function readOptimizedSourceAsync(
    source: SerializedQuery["source"],
    limit?: number | null,
    seek?: SeekBound,
  ): Promise<SourceEvaluationLike | null> {
    const sourceTable = sourceTableName(source);
    if (isTableHydrationAttempted(sourceTable) && source.type !== "Search") {
      const inMemory = readOptimizedSource(source, limit, seek);
      if (inMemory !== null) return inMemory;
    }

    if (!hasPendingWritesForAnySource(source)) {
      const results = await store.source(source, {
        limit,
        indexFields: indexFieldsForSource(source) ?? undefined,
        searchDefinition: searchDefinitionForSource(source),
        activeIdentityKey,
        seek: source.type === "Search" ? undefined : seek,
      });
      if (results !== null) {
        rememberCommittedLookup(sourceTableName(source), results);
        const order =
          source.type === "Search" ? "asc" : (source.order ?? "asc");
        return {
          results: stripIdentityScopes(results),
          fieldPathsToSortBy:
            source.type === "FullTableScan" ? ["_creationTime"] : [],
          order,
          presorted: true,
        };
      }
    }

    if (
      source.type === "FullTableScan" &&
      !hasPendingWritesForTable(source.tableName)
    ) {
      const docs = await store.getDocuments(
        source.tableName,
        storageReadOptions(source.tableName),
      );
      if (docs !== null) {
        rememberCommittedLookup(source.tableName, docs);
        const order = source.order ?? "asc";
        return {
          results: stripIdentityScopes(docs),
          fieldPathsToSortBy: ["_creationTime"],
          order,
          presorted: order === "asc",
        };
      }
    }

    if (
      hasPendingWritesForAnySource(source) &&
      isQueryableTable(sourceTable) &&
      !isTableHydrationAttempted(sourceTable)
    ) {
      const overlaid = await readPushdownWithPendingOverlay(
        source,
        limit,
        seek,
      );
      if (overlaid !== null) return overlaid;
    }

    return readOptimizedSource(source, limit);
  }

  async function readPushdownWithPendingOverlay(
    source: SerializedQuery["source"],
    limit?: number | null,
    seek?: SeekBound,
  ): Promise<SourceEvaluationLike | null> {
    if (source.type === "Search") {
      return null;
    }
    const tableName = sourceTableName(source);
    const indexParts =
      source.type === "IndexRange" ? splitIndexName(source.indexName) : null;
    const indexFields =
      indexParts !== null
        ? (getIndexDefinitionsInternal(indexParts[0]).find(
            (entry) => entry.indexName === indexParts[1],
          )?.fields ?? null)
        : null;
    const committed = await store.source(source, {
      limit,
      indexFields: indexFields ?? undefined,
      activeIdentityKey,
      seek,
    });
    if (committed === null) {
      return null;
    }
    const { shadowedIds } = getPendingTableState(tableName);
    const rangePredicate =
      source.type === "IndexRange"
        ? buildRangePredicate(source.range)
        : () => true;
    const byId = new Map<string, StoredDocument>();
    for (const doc of committed) {
      if (!shadowedIds.has(doc._id as string)) {
        byId.set(doc._id as string, doc);
      }
    }
    for (const { doc } of getVisiblePendingDocs(tableName)) {
      if (rangePredicate(doc)) {
        byId.set(doc._id as string, doc);
      }
    }
    const merged = stripIdentityScopes([...byId.values()]);
    const sortIndexName =
      indexParts !== null ? indexParts[1] : "by_creation_time";
    const sortFields =
      source.type === "IndexRange" && indexFields
        ? indexFields
        : ["_creationTime"];
    merged.sort((left, right) =>
      compareDocsForIndex(sortIndexName, sortFields, left, right),
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

  function readOptimizedQuery(
    query: SerializedQuery,
  ): Array<GenericDocument> | null {
    const { filters, limit } = extractNormalizedOperators(query.operators);
    if (query.source.type === "FullTableScan") {
      const indexName =
        query.source.order === "desc"
          ? "by_creation_time_desc"
          : "by_creation_time";
      if (hasPendingWritesForTable(query.source.tableName)) {
        return collectMergedIndexDocs(
          query.source.tableName,
          indexName,
          filters,
          limit,
        );
      }

      const docs = getIndexedDocuments(query.source.tableName, indexName);
      return filterOrderedDocs(docs, filters, limit);
    }

    if (query.source.type === "IndexRange") {
      const [tableName, indexName] = query.source.indexName.split(".") as [
        string,
        string,
      ];
      const fields = getIndexDefinitionsInternal(tableName).find(
        (entry) => entry.indexName === indexName,
      )?.fields;
      if (!fields) {
        return null;
      }

      const lower = buildRangeBound([...query.source.range], fields, "lower");
      const upper = buildRangeBound([...query.source.range], fields, "upper");
      const predicate = buildRangePredicate(query.source.range);
      const hasPending = hasPendingWritesForTable(tableName);
      if (hasPending && query.source.order === "asc") {
        return collectMergedIndexRangeDocs(
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

      const docs = hasPending
        ? getMergedIndexedDocuments(tableName, indexName)
        : getIndexedDocuments(tableName, indexName);
      const start = lower
        ? binarySearchLowerBound(docs, fields, lower)
        : 0;
      const end = upper
        ? binarySearchUpperBound(docs, fields, upper)
        : docs.length;

      return filterOrderedDocs(
        docs.slice(start, end),
        filters,
        limit,
        predicate,
        query.source.order ?? undefined,
      );
    }

    return null;
  }

  function indexFieldsForSource(
    source: SerializedQuery["source"],
  ): string[] | null {
    if (source.type !== "IndexRange") return null;
    const [tableName, indexName] = splitIndexName(source.indexName);
    return (
      getIndexDefinitionsInternal(tableName).find(
        (entry) => entry.indexName === indexName,
      )?.fields ?? null
    );
  }

  function searchDefinitionForSource(
    source: SerializedQuery["source"],
  ): SearchIndexDefinition | undefined {
    if (source.type !== "Search") return undefined;
    const [tableName, indexName] = splitIndexName(source.indexName);
    return getSearchIndexDefinition(
      schema?.tables.get(tableName)?.searchIndexes,
      tableName,
      indexName,
    );
  }

  async function readOptimizedQueryAsync(
    query: SerializedQuery,
  ): Promise<Array<GenericDocument> | null> {
    const { filters, limit } = extractNormalizedOperators(query.operators);
    const queryTable = sourceTableName(query.source);
    const indexFields = indexFieldsForSource(query.source);
    const hasPendingForAnySource = hasPendingWritesForAnySource(query.source);

    if (
      query.source.type !== "Search" &&
      isTableHydrationAttempted(queryTable)
    ) {
      const inMemory = readOptimizedQuery(query);
      if (inMemory !== null) return inMemory;
    }

    if (
      (query.source.type === "FullTableScan" ||
        query.source.type === "IndexRange") &&
      !hasPendingForAnySource
    ) {
      const pushedDown = await store.query({
        source: query.source,
        filters,
        limit: limit ?? null,
        indexFields: indexFields ?? undefined,
        searchDefinition: undefined,
        activeIdentityKey,
      });
      if (pushedDown !== null) {
        rememberCommittedLookup(queryTable, pushedDown);
        return stripIdentityScopes(pushedDown);
      }
    }

    if (!hasPendingForAnySource) {
      const sourceResults = await store.source(query.source, {
        limit,
        indexFields: indexFields ?? undefined,
        searchDefinition: searchDefinitionForSource(query.source),
        activeIdentityKey,
      });
      if (sourceResults !== null) {
        rememberCommittedLookup(queryTable, sourceResults);
        if (query.source.type !== "Search") {
          const stripped = stripIdentityScopes(sourceResults);
          const ordered =
            query.source.order === "desc" ? [...stripped].reverse() : stripped;
          return filterOrderedDocs(ordered, filters, limit ?? null);
        }
      }
    }

    if (
      query.source.type === "FullTableScan" &&
      !hasPendingWritesForTable(query.source.tableName)
    ) {
      const docs = await store.getDocuments(
        query.source.tableName,
        storageReadOptions(query.source.tableName),
      );
      if (docs !== null) {
        rememberCommittedLookup(query.source.tableName, docs);
        const orderedDocs =
          query.source.order === "desc" ? [...docs].reverse() : docs;
        return stripIdentityScopes(
          filterOrderedDocs(orderedDocs, filters, limit ?? null),
        );
      }
    }

    if (
      (query.source.type === "FullTableScan" ||
        query.source.type === "IndexRange") &&
      hasPendingForAnySource &&
      isQueryableTable(queryTable) &&
      !isTableHydrationAttempted(queryTable)
    ) {
      const overlaid = await readPushdownWithPendingOverlay(
        query.source,
        limit ?? null,
      );
      if (overlaid !== null) {
        return filterOrderedDocs(overlaid.results, filters, limit ?? null);
      }
    }

    return readOptimizedQuery(query);
  }

  function hasPendingWritesForAnySource(
    source: SerializedQuery["source"],
  ): boolean {
    if (source.type === "FullTableScan") {
      return hasPendingWritesForTable(source.tableName);
    }
    if (source.type === "IndexRange" || source.type === "Search") {
      const [tableName] = source.indexName.split(".") as [string];
      return hasPendingWritesForTable(tableName);
    }
    return hasPendingWrites();
  }

  function extractNormalizedOperators(
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

  function filterOrderedDocs(
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

  function collectMergedIndexDocs(
    tableName: string,
    indexName: string,
    filters: FilterNode[],
    limit: number | null,
  ): StoredDocument[] {
    const indexDefinition = getIndexDefinitionsInternal(tableName).find(
      (entry) => entry.indexName === indexName,
    );
    if (!indexDefinition) {
      throw new Error(
        `Cannot use index "${indexName}" for table "${tableName}" because it is not declared in the schema.`,
      );
    }

    const pendingState = getPendingTableState(tableName);
    const pendingDocs = getVisiblePendingDocs(tableName)
      .map(({ doc }) => doc)
      .sort((left, right) =>
        compareDocsForIndex(indexName, indexDefinition.fields, left, right),
      );
    const committedIds = indexDocuments.get(`${tableName}.${indexName}`) ?? [];
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
        const raw = documents.get(id as DocumentId) as
          | IdentityScopedDocument
          | undefined;
        const visible =
          raw === undefined
            ? null
            : visibleDocumentInScope(idTableMap.get(id), raw);
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
        compareDocsForIndex(
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

  function collectMergedIndexRangeDocs(
    tableName: string,
    indexName: string,
    filters: FilterNode[],
    limit: number | null,
    fields: string[],
    lower: { values: Array<Value | undefined>; inclusive: boolean } | null,
    upper: { values: Array<Value | undefined>; inclusive: boolean } | null,
    predicate: (doc: StoredDocument) => boolean,
  ): StoredDocument[] {
    const pendingState = getPendingTableState(tableName);
    const pendingDocs = getVisiblePendingDocs(tableName)
      .map(({ doc }) => doc)
      .sort((left, right) =>
        compareDocsForIndex(indexName, fields, left, right),
      );
    const committedIds = indexDocuments.get(`${tableName}.${indexName}`) ?? [];
    const results: StoredDocument[] = [];
    const seenIds = new Set<string>();
    let committedIndex = 0;
    let pendingIndex = 0;

    const compareBounds = (doc: StoredDocument): boolean => {
      if (lower !== null) {
        const cmp = compareDocToBound(doc, fields, lower);
        if (lower.inclusive ? cmp < 0 : cmp <= 0) return false;
      }
      if (upper !== null) {
        const cmp = compareDocToBound(doc, fields, upper);
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
        const raw = documents.get(id as DocumentId) as
          | IdentityScopedDocument
          | undefined;
        const visible =
          raw === undefined
            ? null
            : visibleDocumentInScope(idTableMap.get(id), raw);
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
        compareDocsForIndex(
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

  function buildPendingVectorOverlay(
    tableName: string,
    baseState: VectorIndexState,
  ): VectorOverlayState {
    const pendingState = getPendingTableState(tableName);
    const key = baseState.definition.indexDescriptor;
    const cached = pendingState.vectorOverlays.get(key);
    if (cached) {
      return cached;
    }

    const overlay: VectorOverlayState = {
      shadowedIds: pendingState.shadowedIds,
      state: buildVectorIndexState({
        docs: getVisiblePendingDocs(tableName),
        definition: baseState.definition,
      }),
    };
    pendingState.vectorOverlays.set(key, overlay);
    return overlay;
  }

  function buildPendingSearchOverlay(
    tableName: string,
    baseState: SearchIndexState,
  ): SearchOverlayState {
    const pendingState = getPendingTableState(tableName);
    const key = baseState.definition.indexDescriptor;
    const cached = pendingState.searchOverlays.get(key);
    if (cached) {
      return cached;
    }

    const overlay: SearchOverlayState = {
      shadowedIds: pendingState.shadowedIds,
      state: buildSearchIndexState({
        docs: getVisiblePendingDocs(tableName),
        definition: baseState.definition,
      }),
    };
    pendingState.searchOverlays.set(key, overlay);
    return overlay;
  }

  function getMergedIndexedDocuments(
    tableName: string,
    indexName: string,
  ): StoredDocument[] {
    const pendingState = getPendingTableState(tableName);
    const cached = pendingState.mergedIndexes.get(indexName);
    if (cached) {
      return cached;
    }

    const committedIds = indexDocuments.get(`${tableName}.${indexName}`) ?? [];
    const indexDefinition = getIndexDefinitionsInternal(tableName).find(
      (entry) => entry.indexName === indexName,
    );

    if (!indexDefinition) {
      throw new Error(
        `Cannot use index "${indexName}" for table "${tableName}" because it is not declared in the schema.`,
      );
    }

    const pendingDocs = getVisiblePendingDocs(tableName)
      .map(({ doc }) => doc)
      .sort((left, right) =>
        compareDocsForIndex(indexName, indexDefinition.fields, left, right),
      );

    const merged = mergeCommittedIdsAndPendingDocs(
      committedIds,
      pendingDocs,
      pendingState.shadowedIds,
      (left, right) =>
        compareDocsForIndex(indexName, indexDefinition.fields, left, right),
    );
    pendingState.mergedIndexes.set(indexName, merged);
    return merged;
  }

  function mergeCommittedIdsAndPendingDocs(
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
        const raw = documents.get(id as DocumentId) as
          | IdentityScopedDocument
          | undefined;
        const visible =
          raw === undefined
            ? null
            : visibleDocumentInScope(idTableMap.get(id), raw);
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

  function allKnownTableNames(): Set<string> {
    const names = new Set(tableDocuments.keys());
    if (schema) {
      for (const name of schema.tables.keys()) {
        names.add(name);
      }
    }
    return names;
  }

  function rebuildAllIndexes(): void {
    indexDocuments.clear();
    for (const tableName of allKnownTableNames()) {
      const rowCount = tableDocuments.get(tableName)?.size ?? 0;
      withSpanSync(
        "convex-embedded.db.rebuildTableIndexes",
        () => rebuildTableIndexes(tableName),
        {
          attributes: {
            "convex.table": tableName,
            "convex.table.rows": rowCount,
          },
        },
      );
    }
  }

  function rebuildAllSearchIndexes(): void {
    searchIndexes.clear();
    for (const tableName of allKnownTableNames()) {
      const rowCount = tableDocuments.get(tableName)?.size ?? 0;
      withSpanSync(
        "convex-embedded.db.rebuildTableSearchIndexes",
        () => rebuildTableSearchIndexes(tableName),
        {
          attributes: {
            "convex.table": tableName,
            "convex.table.rows": rowCount,
          },
        },
      );
    }
  }

  function collectTableSearchIndexes(): Record<
    string,
    import("@/runtime/db/schema").SearchIndexDefinition[]
  > {
    const result: Record<
      string,
      import("@/runtime/db/schema").SearchIndexDefinition[]
    > = {};
    if (!schema) return result;
    for (const [tableName, tableSchema] of schema.tables) {
      if (tableSchema.searchIndexes && tableSchema.searchIndexes.length > 0) {
        result[tableName] = [...tableSchema.searchIndexes];
      }
    }
    return result;
  }

  function collectTableVectorIndexes(): Record<
    string,
    import("@/runtime/db/schema").VectorIndexDefinition[]
  > {
    const result: Record<
      string,
      import("@/runtime/db/schema").VectorIndexDefinition[]
    > = {};
    if (!schema) return result;
    for (const [tableName, tableSchema] of schema.tables) {
      if (tableSchema.vectorIndexes && tableSchema.vectorIndexes.length > 0) {
        result[tableName] = [...tableSchema.vectorIndexes];
      }
    }
    return result;
  }

  function rebuildAllVectorIndexes(): void {
    vectorIndexes.clear();
    for (const tableName of allKnownTableNames()) {
      const rowCount = tableDocuments.get(tableName)?.size ?? 0;
      withSpanSync(
        "convex-embedded.db.rebuildTableVectorIndexes",
        () => rebuildTableVectorIndexes(tableName),
        {
          attributes: {
            "convex.table": tableName,
            "convex.table.rows": rowCount,
          },
        },
      );
    }
  }

  function rebuildTableIndexes(tableName: string): void {
    const ids: string[] = [];
    const docs = documents;
    for (const id of tableDocuments.get(tableName) ?? []) {
      if (docs.get(id as DocumentId) !== undefined) {
        ids.push(id);
      }
    }

    for (const { indexName, fields } of getIndexDefinitionsInternal(tableName)) {
      if (ids.length === 0) {
        indexDocuments.set(`${tableName}.${indexName}`, []);
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
      indexDocuments.set(`${tableName}.${indexName}`, sortedIds);
    }
  }

  function rebuildTableSearchIndexes(tableName: string): void {
    const tableSearchIndexes =
      schema?.tables.get(tableName)?.searchIndexes ?? [];
    for (const key of searchIndexes.keys()) {
      if (key.startsWith(`${tableName}.`)) {
        searchIndexes.delete(key);
      }
    }
    if (tableSearchIndexes.length === 0) {
      return;
    }
    const rawDocs = [...(tableDocuments.get(tableName) ?? [])]
      .map(
        (id) =>
          documents.get(id as DocumentId) as
            | IdentityScopedDocument
            | undefined,
      )
      .filter((doc): doc is IdentityScopedDocument => doc !== undefined);

    for (const definition of tableSearchIndexes) {
      searchIndexes.set(
        `${tableName}.${definition.indexDescriptor}`,
        buildSearchIndexState({
          docs: rawDocs.map((doc) => ({
            doc: stripIdentityScope(doc),
            identityKey: doc[IDENTITY_SCOPE_FIELD] ?? null,
          })),
          definition: getSearchIndexDefinition(
            tableSearchIndexes,
            tableName,
            definition.indexDescriptor,
          ),
        }),
      );
    }
  }

  function rebuildTableVectorIndexes(tableName: string): void {
    const tableVectorIndexes =
      schema?.tables.get(tableName)?.vectorIndexes ?? [];
    for (const key of vectorIndexes.keys()) {
      if (key.startsWith(`${tableName}.`)) {
        vectorIndexes.delete(key);
      }
    }
    if (tableVectorIndexes.length === 0) {
      return;
    }
    const rawDocs = [...(tableDocuments.get(tableName) ?? [])]
      .map(
        (id) =>
          documents.get(id as DocumentId) as
            | IdentityScopedDocument
            | undefined,
      )
      .filter((doc): doc is IdentityScopedDocument => doc !== undefined);

    for (const definition of tableVectorIndexes) {
      vectorIndexes.set(
        `${tableName}.${definition.indexDescriptor}`,
        buildVectorIndexState({
          docs: rawDocs.map((doc) => ({
            doc: stripIdentityScope(doc),
            identityKey: doc[IDENTITY_SCOPE_FIELD] ?? null,
          })),
          definition: getVectorIndexDefinition(
            tableVectorIndexes,
            tableName,
            definition.indexDescriptor,
          ),
        }),
      );
    }
  }

  function applyCommittedStateChanges(
    changes: CommittedStateChange[],
    options: { skipQueryable?: boolean } = {},
  ): void {
    withSpanSync("convex-embedded.db.applyIndexChanges", (span) => {
      span.setAttribute("convex.change_count", changes.length);
      applyCommittedStateChangesImpl(changes, options);
    });
  }

  function applyCommittedStateChangesImpl(
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
      if (skipQueryable && isQueryableTable(tableName)) {
        continue;
      }

      const committedCount = getCommittedTableCount(tableName);
      const hasCommittedState = indexDocuments.has(
        `${tableName}.by_creation_time`,
      );
      const shouldRebuild =
        !hasCommittedState ||
        tableChanges.length > Math.max(32, committedCount >> 3);

      if (shouldRebuild) {
        rebuildTableIndexes(tableName);
        rebuildTableSearchIndexes(tableName);
        rebuildTableVectorIndexes(tableName);
        continue;
      }

      applyIncrementalIndexChanges(tableName, tableChanges);
      applyIncrementalSearchChanges(tableName, tableChanges);
      applyIncrementalVectorChanges(tableName, tableChanges);
    }
  }

  function isSystemTable(tableName: string): boolean {
    return tableName.startsWith("_");
  }

  function storageReadOptions(tableName: string): ReadOptions | undefined {
    return isSystemTable(tableName)
      ? undefined
      : { activeIdentityKey };
  }

  function isQueryableTable(tableName: string): boolean {
    return store.isQueryable() && !tableName.startsWith("_");
  }

  function applyIncrementalIndexChanges(
    tableName: string,
    changes: CommittedStateChange[],
  ): void {
    for (const { indexName, fields } of getIndexDefinitionsInternal(tableName)) {
      const key = `${tableName}.${indexName}`;
      const ids = indexDocuments.get(key);
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
        const insertAt = binarySearchIndexInsertPosition(
          ids,
          indexName,
          fields,
          change.after,
        );
        if (insertAt > 0 && ids[insertAt - 1] === changeId) {
          log.warn(
            `duplicate incremental id detected for ${key}; rebuilding index`,
          );
          rebuildTableIndexes(tableName);
          return;
        }
        ids.splice(insertAt, 0, changeId);
      }
    }
  }

  function applyIncrementalVectorChanges(
    tableName: string,
    changes: CommittedStateChange[],
  ): void {
    const tableVectorIndexes =
      schema?.tables.get(tableName)?.vectorIndexes ?? [];
    for (const definition of tableVectorIndexes) {
      const state = vectorIndexes.get(
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
            doc: stripIdentityScope(change.after),
            identityKey: change.after[IDENTITY_SCOPE_FIELD] ?? null,
          });
        }
      }
    }
  }

  function applyIncrementalSearchChanges(
    tableName: string,
    changes: CommittedStateChange[],
  ): void {
    const tableSearchIndexes =
      schema?.tables.get(tableName)?.searchIndexes ?? [];
    for (const definition of tableSearchIndexes) {
      const state = searchIndexes.get(
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
            doc: stripIdentityScope(change.after),
            identityKey: change.after[IDENTITY_SCOPE_FIELD] ?? null,
          });
        }
      }
    }
  }

  function compareDocsForIndex(
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

  function binarySearchIndexInsertPosition(
    ids: string[],
    indexName: string,
    fields: string[],
    target: StoredDocument,
  ): number {
    let low = 0;
    let high = ids.length;

    while (low < high) {
      const mid = (low + high) >> 1;
      const current = documents.get(ids[mid] as DocumentId);
      if (current === undefined) {
        ids.splice(mid, 1);
        high = ids.length;
        continue;
      }
      const comparison = compareDocsForIndex(
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

  function getIndexDefinitionsInternal(
    tableName: string,
  ): Array<{ indexName: string; fields: string[] }> {
    const cached = indexDefsCache.get(tableName);
    if (cached !== undefined) {
      return cached;
    }

    const tableSchema = schema?.tables.get(tableName);
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
    indexDefsCache.set(tableName, definitions);
    return definitions;
  }

  function hasPendingWrites(): boolean {
    return pendingWriteCount > 0;
  }

  function hasPendingWritesForTable(tableName: string): boolean {
    if (!hasPendingWrites()) {
      return false;
    }

    return writeTables.some((tables) => tables.has(tableName));
  }

  function buildRangePredicate(
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

  function applySeekToOrderedDocs(
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
    const start = seekStartIndex(docs, keep);
    return start === 0 ? docs : docs.slice(start);
  }

  function seekStartIndex(
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

  function buildRangeBound(
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

  function indexedIds(tableName: string, indexName: string): string[] | null {
    const ids = indexDocuments.get(`${tableName}.${indexName}`);
    return ids === undefined ? null : (ids as string[]);
  }

  function materializeIndexedId(id: string): StoredDocument | null {
    const raw = documents.get(id as DocumentId) as
      | IdentityScopedDocument
      | undefined;
    return raw === undefined ? null : stripIdentityScope(raw);
  }

  function readIndexWindow(input: {
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
      materializeIndexedId(ids[index]!);
    const lowerIndex = lower
      ? binarySearchBoundIds(ids, fields, lower, docAt, "lower")
      : 0;
    const upperIndex = upper
      ? binarySearchBoundIds(ids, fields, upper, docAt, "upper")
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
      index = seekIndexInRange(lowerIndex, upperIndex, docAt, passesSeek);
    } else if (iterate === "backward" && seek !== undefined) {
      index = seekIndexInRangeBackward(
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

  function seekIndexInRange(
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

  function seekIndexInRangeBackward(
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

  function binarySearchBoundIds(
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
        doc === null ? 0 : compareDocToBound(doc, fields, bound);
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

  function compareDocToBound(
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

  function binarySearchLowerBound(
    docs: StoredDocument[],
    fields: string[],
    bound: { values: Array<Value | undefined>; inclusive: boolean },
  ): number {
    let low = 0;
    let high = docs.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const comparison = compareDocToBound(docs[mid]!, fields, bound);
      const moveRight = bound.inclusive ? comparison < 0 : comparison <= 0;
      if (moveRight) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  function binarySearchUpperBound(
    docs: StoredDocument[],
    fields: string[],
    bound: { values: Array<Value | undefined>; inclusive: boolean },
  ): number {
    let low = 0;
    let high = docs.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const comparison = compareDocToBound(docs[mid]!, fields, bound);
      const keepLeft = bound.inclusive ? comparison > 0 : comparison >= 0;
      if (keepLeft) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    return low;
  }

  const iterateDocsReader: DocumentIterator = (tableName, callback) => {
    iterateDocs(tableName, callback);
  };
  const countTable: TableCountReader = (tableName) =>
    hasPendingWritesForTable(tableName) || isIdentityScopedTable(tableName)
      ? getDocumentsForTable(tableName).length
      : (tableDocuments.get(tableName)?.size ?? 0);
  const countTableAsync: AsyncTableCountReader = async (tableName) => {
    if (
      hasPendingWritesForTable(tableName) ||
      isIdentityScopedTable(tableName)
    ) {
      return getDocumentsForTable(tableName).length;
    }
    if (isTableHydrationAttempted(tableName)) {
      return tableDocuments.get(tableName)?.size ?? 0;
    }
    const storeCount = await store.countDocuments(
      tableName,
      storageReadOptions(tableName),
    );
    if (storeCount !== null) return storeCount;
    return tableDocuments.get(tableName)?.size ?? 0;
  };
  const queryReader: QueryReader = (query) => readOptimizedQuery(query);
  const readQueryAsync: AsyncQueryReader = (query) =>
    readOptimizedQueryAsync(query);
  const sourceReader: SourceReader = (source, limit, seek) =>
    readOptimizedSource(source, limit, seek);
  const readSourceAsync: AsyncSourceReader = (source, limit, seek) =>
    readOptimizedSourceAsync(source, limit, seek);

  const queryEngine: QueryEngine = createQueryEngine(
    schema,
    iterateDocsReader,
    countTable,
    queryReader,
    sourceReader,
    countTableAsync,
    readQueryAsync,
    readSourceAsync,
    (tableName: string) => getTableVersion(tableName),
  );

  return {
    queryEngine,
    get timestamp() {
      return timestamp;
    },
    getTableVersion,
    bumpTableVersions,
    setStorage,
    setReadBackendForTests,
    setActiveIdentityKey,
    getActiveIdentityKey,
    hydrate,
    hydrateSystemTables,
    isTableHydrationAttempted,
    tableHydrated,
    replicateTable,
    startTransaction,
    commit,
    commitAsync,
    waitForPersistence,
    rollbackWrites,
    get,
    insert,
    patch,
    replace,
    delete: deleteDoc,
    writeDocument,
    deleteDocument,
    getDocumentsForTable,
    hasDocumentsForTable,
    getTableNames,
    getIndexDefinitions,
    migrateAnonymousDataToIdentity,
    reStampAnonymousUserTablesInStorage,
    normalizeId,
    getTableForId,
    storeFile,
    deleteBlob,
    loadFile,
    startQuery,
    startQueryAsync,
    queryNext,
    queryNextAsync,
    queryCleanup,
    paginateAsync,
    count,
    countAsync,
    getAsync,
    ensureCommittedDocumentForWrite,
    listDocumentsAsync,
    listDocumentsForScopeAsync,
    getCommittedTableCount,
    getIndexedDocuments,
    vectorSearch,
    vectorSearchAsync,
    _indexDocuments: indexDocuments,
    _idTableMap: idTableMap,
    _addWriteRaw: addWriteRaw,
  };
}
