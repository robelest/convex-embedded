import type {
  SearchIndexDefinition,
  VectorIndexDefinition,
} from "@/runtime/db/schema";
import { buildSearchIndexState, executeSearch } from "@/runtime/db/search";
import { sourceTableName } from "@/runtime/db/sql_pushdown";
import type { StoredDocument } from "@/runtime/db/types";
import { buildVectorFilterSqlClauseGroups } from "@/runtime/db/vector";
import type {
  CommitBatch,
  DatabaseMeta,
  PersistenceQueryRead,
  PersistenceReadOptions,
  PersistenceVectorRead,
  SqlCommitApplyOptions,
  SqlCommitApplyResult,
  SqlPersistenceAdapter,
  StoredDocumentWithTable,
} from "@/storage/adapter";

import type { SqliteDriver, SqliteStatement } from "./driver";

const IDENTITY_SCOPE_FIELD = "__identityKey";
const SQLITE_ADAPTER_SCHEMA_VERSION = 3;
const SQLITE_ADAPTER_META_TABLE = "_convex_sqlite_adapter_meta";
const SQLITE_TABLE_ROUTING_TABLE = "_convex_sqlite_table_routing";

const LEGACY_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    table_name TEXT NOT NULL DEFAULT '',
    creation_time REAL NOT NULL DEFAULT 0,
    identity_key TEXT,
    data TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS documents_by_table_name ON documents(table_name)",
  "CREATE INDEX IF NOT EXISTS documents_by_table_name_and_creation_time ON documents(table_name, creation_time, id)",
  "CREATE INDEX IF NOT EXISTS documents_by_table_name_and_identity_key ON documents(table_name, identity_key, id)",
  `CREATE TABLE IF NOT EXISTS meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    timestamp REAL NOT NULL,
    last_creation_time REAL NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY,
    data BLOB NOT NULL
  )`,
] as const;

const ROUTING_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ${SQLITE_ADAPTER_META_TABLE} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${SQLITE_TABLE_ROUTING_TABLE} (
    table_name TEXT PRIMARY KEY,
    physical_table_name TEXT NOT NULL
  )`,
] as const;

export const SEARCH_ENTRIES_LOGICAL_NAME = "_search_entries";
export const SEARCH_ENTRIES_PHYSICAL_NAME = "internal__search_entries";
export const SEARCH_BUCKETS_LOGICAL_NAME = "_search_filter_buckets";
export const SEARCH_BUCKETS_PHYSICAL_NAME = "internal__search_filter_buckets";
export const VECTOR_ENTRIES_LOGICAL_NAME = "_vector_entries";
export const VECTOR_ENTRIES_PHYSICAL_NAME = "internal__vector_entries";
export const VECTOR_BUCKETS_LOGICAL_NAME = "_vector_filter_buckets";
export const VECTOR_BUCKETS_PHYSICAL_NAME = "internal__vector_filter_buckets";

const SEARCH_ENTRIES_PHYSICAL = SEARCH_ENTRIES_PHYSICAL_NAME;
const SEARCH_BUCKETS_PHYSICAL = SEARCH_BUCKETS_PHYSICAL_NAME;
const VECTOR_ENTRIES_PHYSICAL = VECTOR_ENTRIES_PHYSICAL_NAME;
const VECTOR_BUCKETS_PHYSICAL = VECTOR_BUCKETS_PHYSICAL_NAME;

const SEARCH_VECTOR_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(SEARCH_ENTRIES_PHYSICAL)} (
    entry_id TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    index_name TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    identity_key TEXT,
    creation_time REAL NOT NULL DEFAULT 0,
    data TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${SEARCH_ENTRIES_PHYSICAL}_by_index`)} ON ${quoteIdentifier(SEARCH_ENTRIES_PHYSICAL)}(table_name, index_name, identity_key)`,
  `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${SEARCH_ENTRIES_PHYSICAL}_by_doc`)} ON ${quoteIdentifier(SEARCH_ENTRIES_PHYSICAL)}(table_name, doc_id)`,
  `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(SEARCH_BUCKETS_PHYSICAL)} (
    bucket_id TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    index_name TEXT NOT NULL,
    field_path TEXT NOT NULL,
    bucket_key TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    identity_key TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${SEARCH_BUCKETS_PHYSICAL}_by_lookup`)} ON ${quoteIdentifier(SEARCH_BUCKETS_PHYSICAL)}(table_name, index_name, field_path, bucket_key)`,
  `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${SEARCH_BUCKETS_PHYSICAL}_by_doc`)} ON ${quoteIdentifier(SEARCH_BUCKETS_PHYSICAL)}(table_name, doc_id)`,
  `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(VECTOR_ENTRIES_PHYSICAL)} (
    entry_id TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    index_name TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    identity_key TEXT,
    creation_time REAL NOT NULL DEFAULT 0,
    data TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${VECTOR_ENTRIES_PHYSICAL}_by_index`)} ON ${quoteIdentifier(VECTOR_ENTRIES_PHYSICAL)}(table_name, index_name, identity_key)`,
  `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${VECTOR_ENTRIES_PHYSICAL}_by_doc`)} ON ${quoteIdentifier(VECTOR_ENTRIES_PHYSICAL)}(table_name, doc_id)`,
  `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(VECTOR_BUCKETS_PHYSICAL)} (
    bucket_id TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    index_name TEXT NOT NULL,
    field_path TEXT NOT NULL,
    bucket_key TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    identity_key TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${VECTOR_BUCKETS_PHYSICAL}_by_lookup`)} ON ${quoteIdentifier(VECTOR_BUCKETS_PHYSICAL)}(table_name, index_name, field_path, bucket_key)`,
  `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${VECTOR_BUCKETS_PHYSICAL}_by_doc`)} ON ${quoteIdentifier(VECTOR_BUCKETS_PHYSICAL)}(table_name, doc_id)`,
] as const;

type SearchVectorIndexRegistry = {
  search: Map<string, SearchIndexDefinition[]>;
  vector: Map<string, VectorIndexDefinition[]>;
};

type SideTableKind = "search" | "vector";

type SideTableDefinition = Pick<
  SearchIndexDefinition | VectorIndexDefinition,
  "indexDescriptor" | "filterFields"
>;

type TableStorageTarget = {
  kind: "physical";
  tableName: string;
  fromClause: string;
  physicalTableName: string;
  internalSpec: InternalTableSpec | null;
};

type TableRouteRow = {
  table_name: string;
  physical_table_name: string;
};

const SIDE_TABLE_PHYSICAL_NAMES = {
  search: {
    entries: SEARCH_ENTRIES_PHYSICAL,
    buckets: SEARCH_BUCKETS_PHYSICAL,
  },
  vector: {
    entries: VECTOR_ENTRIES_PHYSICAL,
    buckets: VECTOR_BUCKETS_PHYSICAL,
  },
} as const satisfies Record<
  SideTableKind,
  { entries: string; buckets: string }
>;

function decodeStoredDocument(data: string): StoredDocument {
  return JSON.parse(data) as StoredDocument;
}

function documentCreationTime(doc: StoredDocument): number {
  return typeof doc._creationTime === "number" ? doc._creationTime : 0;
}

function documentIdentityKey(doc: StoredDocument): string | null {
  const identityKey = (doc as Record<string, unknown>)[IDENTITY_SCOPE_FIELD];
  return typeof identityKey === "string" ? identityKey : null;
}

function decodeBlob(value: unknown): Blob {
  if (value instanceof Uint8Array) {
    return new Blob([Uint8Array.from(value)]);
  }
  if (value instanceof ArrayBuffer) {
    return new Blob([new Uint8Array(value)]);
  }
  if (typeof Buffer !== "undefined" && value instanceof Buffer) {
    return new Blob([value]);
  }
  throw new Error("[convex-embedded] sqlite blob row was not binary data.");
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function physicalTableNameFor(tableName: string): string {
  const internal = INTERNAL_TABLE_SPECS[tableName];
  if (internal) {
    return internal.physicalTableName;
  }
  return `documents__${tableName}`;
}

type InternalFieldSpec = {
  column: string;
  sqlType: string;
  notNull?: boolean;
  defaultSql?: string;
  preserveNull?: boolean;
};

type InternalTableSpec = {
  physicalTableName: string;
  fields: Record<string, InternalFieldSpec>;
  indexes: Array<{ name: string; columns: string[]; unique?: boolean }>;
};

const INTERNAL_TABLE_SPECS: Record<string, InternalTableSpec> = {
  _resolve_id_map: {
    physicalTableName: "internal__resolve_id_map",
    fields: {
      identityKey: {
        column: "identity_key",
        sqlType: "TEXT",
        preserveNull: true,
      },
      localId: { column: "local_id", sqlType: "TEXT", notNull: true },
      remoteId: { column: "remote_id", sqlType: "TEXT", notNull: true },
      table: { column: "table_name", sqlType: "TEXT", notNull: true },
    },
    indexes: [
      {
        name: "by_identity_key_and_local_id",
        columns: ["identity_key", "local_id", "creation_time", "id"],
        unique: true,
      },
    ],
  },
  _resolve_pending: {
    physicalTableName: "internal__resolve_pending",
    fields: {
      identityKey: {
        column: "identity_key",
        sqlType: "TEXT",
        preserveNull: true,
      },
      ref: { column: "ref", sqlType: "TEXT", notNull: true },
      args: { column: "args_json", sqlType: "TEXT", notNull: true },
      localResult: {
        column: "local_result_json",
        sqlType: "TEXT",
        notNull: true,
      },
      table: { column: "table_name", sqlType: "TEXT", notNull: true },
      payloadVersion: {
        column: "payload_version",
        sqlType: "INTEGER",
        notNull: true,
        defaultSql: "1",
      },
      state: { column: "state", sqlType: "TEXT" },
      owner: { column: "owner", sqlType: "TEXT" },
      processingStartedAt: { column: "processing_started_at", sqlType: "REAL" },
      leaseExpiresAt: { column: "lease_expires_at", sqlType: "REAL" },
      blockedReason: { column: "blocked_reason", sqlType: "TEXT" },
      createdAt: {
        column: "created_at",
        sqlType: "REAL",
        notNull: true,
        defaultSql: "0",
      },
    },
    indexes: [
      {
        name: "by_identity_key_and_creation_time",
        columns: ["identity_key", "creation_time", "id"],
      },
      { name: "by_owner", columns: ["owner", "id"] },
    ],
  },
  _resolve_processors: {
    physicalTableName: "internal__resolve_processors",
    fields: {
      identityKey: {
        column: "identity_key",
        sqlType: "TEXT",
        preserveNull: true,
      },
      processorId: { column: "processor_id", sqlType: "TEXT", notNull: true },
      lastSeenAt: {
        column: "last_seen_at",
        sqlType: "REAL",
        notNull: true,
        defaultSql: "0",
      },
    },
    indexes: [
      {
        name: "by_identity_key_and_processor_id",
        columns: ["identity_key", "processor_id", "creation_time", "id"],
        unique: true,
      },
    ],
  },
  _resolve_collection_metadata: {
    physicalTableName: "internal__resolve_collection_metadata",
    fields: {
      identityKey: {
        column: "identity_key",
        sqlType: "TEXT",
        preserveNull: true,
      },
      collection: { column: "collection", sqlType: "TEXT", notNull: true },
      schemaVersion: {
        column: "schema_version",
        sqlType: "INTEGER",
        notNull: true,
      },
      seq: { column: "seq", sqlType: "REAL", notNull: true, defaultSql: "0" },
    },
    indexes: [
      {
        name: "by_identity_key_and_collection",
        columns: [
          "identity_key",
          "collection",
          "schema_version",
          "creation_time",
          "id",
        ],
        unique: true,
      },
    ],
  },
  _resolve_document_metadata: {
    physicalTableName: "internal__resolve_document_metadata",
    fields: {
      identityKey: {
        column: "identity_key",
        sqlType: "TEXT",
        preserveNull: true,
      },
      collection: { column: "collection", sqlType: "TEXT", notNull: true },
      docId: { column: "doc_id", sqlType: "TEXT", notNull: true },
      schemaVersion: {
        column: "schema_version",
        sqlType: "INTEGER",
        notNull: true,
      },
      seq: { column: "seq", sqlType: "REAL", notNull: true, defaultSql: "0" },
    },
    indexes: [
      {
        name: "by_identity_key_and_collection_and_doc_id",
        columns: [
          "identity_key",
          "collection",
          "doc_id",
          "schema_version",
          "creation_time",
          "id",
        ],
        unique: true,
      },
    ],
  },
  _resolve_schema_versions: {
    physicalTableName: "internal__resolve_schema_versions",
    fields: {
      table: { column: "table_name", sqlType: "TEXT", notNull: true },
      version: {
        column: "version",
        sqlType: "INTEGER",
        notNull: true,
        defaultSql: "1",
      },
    },
    indexes: [
      { name: "by_table", columns: ["table_name", "creation_time", "id"] },
    ],
  },
  _resolve_store_versions: {
    physicalTableName: "internal__resolve_store_versions",
    fields: {
      store: { column: "store", sqlType: "TEXT", notNull: true },
      scope: { column: "scope", sqlType: "TEXT", notNull: true },
      identityKey: {
        column: "identity_key",
        sqlType: "TEXT",
        preserveNull: true,
      },
      version: {
        column: "version",
        sqlType: "INTEGER",
        notNull: true,
        defaultSql: "1",
      },
    },
    indexes: [
      {
        name: "by_store_scope_and_identity",
        columns: ["store", "scope", "identity_key", "creation_time", "id"],
      },
    ],
  },
  _resolve_auth_state: {
    physicalTableName: "internal__resolve_auth_state",
    fields: {
      activeIdentityKey: {
        column: "active_identity_key",
        sqlType: "TEXT",
        preserveNull: true,
      },
      updatedAt: {
        column: "updated_at",
        sqlType: "REAL",
        notNull: true,
        defaultSql: "0",
      },
    },
    indexes: [],
  },
};

function buildPhysicalTableSchema(tableName: string): SqliteStatement[] {
  const internal = INTERNAL_TABLE_SPECS[tableName];
  if (internal) {
    const quotedTable = quoteIdentifier(internal.physicalTableName);
    const fieldColumns = Object.values(internal.fields).map((field) => {
      const parts = [quoteIdentifier(field.column), field.sqlType];
      if (field.notNull) {
        parts.push("NOT NULL");
      }
      if (field.defaultSql) {
        parts.push(`DEFAULT ${field.defaultSql}`);
      }
      return parts.join(" ");
    });
    return [
      {
        sql: `CREATE TABLE IF NOT EXISTS ${quotedTable} (
          id TEXT PRIMARY KEY,
          creation_time REAL NOT NULL DEFAULT 0,
          ${fieldColumns.join(",\n          ")}
        )`,
      },
      ...internal.indexes.map((index) => ({
        sql: `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdentifier(`${internal.physicalTableName}_${index.name}`)} ON ${quotedTable}(${index.columns.map(quoteIdentifier).join(", ")})`,
      })),
    ];
  }
  const physicalTableName = physicalTableNameFor(tableName);
  const quotedTable = quoteIdentifier(physicalTableName);
  return [
    {
      sql: `CREATE TABLE IF NOT EXISTS ${quotedTable} (
        id TEXT PRIMARY KEY,
        creation_time REAL NOT NULL DEFAULT 0,
        identity_key TEXT,
        data TEXT NOT NULL
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${physicalTableName}_by_creation_time`)} ON ${quotedTable}(creation_time, id)`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${physicalTableName}_by_identity_key`)} ON ${quotedTable}(identity_key, id)`,
    },
  ];
}

function internalFieldExpression(
  target: TableStorageTarget,
  fieldPath: string,
): string {
  if (fieldPath === "_id") return "id";
  if (fieldPath === "_creationTime") return "creation_time";
  if (target.internalSpec) {
    const mapped = target.internalSpec.fields[fieldPath];
    if (mapped) {
      return quoteIdentifier(mapped.column);
    }
  }
  if (fieldPath === "__identityKey") {
    return "identity_key";
  }
  return `json_extract(data, '$.${fieldPath.split(".").join(".")}')`;
}

function internalOrderByClause(
  target: TableStorageTarget,
  fields: string[],
  order: "asc" | "desc",
): string {
  const direction = order.toUpperCase();
  const parts = fields.map(
    (field) => `${internalFieldExpression(target, field)} ${direction}`,
  );
  if (!fields.includes("_id")) {
    parts.push(`id ${direction}`);
  }
  return parts.join(", ");
}

function internalRangeWhereClause(input: {
  target: TableStorageTarget;
  range: Extract<PersistenceQueryRead["source"], { type: "IndexRange" }>;
  params: unknown[];
}): string[] {
  const clauses: string[] = [];
  for (const expression of input.range.range) {
    const fieldExpr = internalFieldExpression(
      input.target,
      expression.fieldPath,
    );
    // Rewrite `= NULL` to `IS NULL` since SQL equality against NULL is
    // UNKNOWN. Our range type excludes Neq, so no IS NOT NULL case here.
    if (expression.value === null && expression.type === "Eq") {
      clauses.push(`${fieldExpr} IS NULL`);
      continue;
    }
    const operator =
      expression.type === "Eq"
        ? "="
        : expression.type === "Gt"
          ? ">"
          : expression.type === "Gte"
            ? ">="
            : expression.type === "Lt"
              ? "<"
              : "<=";
    clauses.push(`${fieldExpr} ${operator} ?`);
    input.params.push(expression.value);
  }
  return clauses;
}

function internalFilterWhereClause(
  target: TableStorageTarget,
  filter: import("@/runtime/db/query").FilterNode,
  params: unknown[],
): string | null {
  if (filter._tag === "And") {
    const children = filter.children
      .map((child) => internalFilterWhereClause(target, child, params))
      .filter((clause): clause is string => clause !== null);
    return children.length > 0 ? `(${children.join(" AND ")})` : null;
  }
  if (filter._tag === "Or") {
    const children = filter.children
      .map((child) => internalFilterWhereClause(target, child, params))
      .filter((clause): clause is string => clause !== null);
    return children.length > 0 ? `(${children.join(" OR ")})` : null;
  }
  if (filter._tag === "Not") {
    const child = internalFilterWhereClause(target, filter.child, params);
    return child ? `(NOT ${child})` : null;
  }
  const binaryOperators = {
    Eq: "=",
    Neq: "!=",
    Gt: ">",
    Gte: ">=",
    Lt: "<",
    Lte: "<=",
  } as const;
  if (
    filter._tag !== "Eq" &&
    filter._tag !== "Neq" &&
    filter._tag !== "Gt" &&
    filter._tag !== "Gte" &&
    filter._tag !== "Lt" &&
    filter._tag !== "Lte"
  ) {
    return null;
  }
  const left = filter.left;
  const right = filter.right;
  const op = binaryOperators[filter._tag];
  if (left._tag === "Field" && right._tag === "Literal") {
    if (right.value === null && filter._tag === "Eq") {
      return `${internalFieldExpression(target, left.fieldPath)} IS NULL`;
    }
    if (right.value === null && filter._tag === "Neq") {
      return `${internalFieldExpression(target, left.fieldPath)} IS NOT NULL`;
    }
    params.push(right.value);
    return `${internalFieldExpression(target, left.fieldPath)} ${op} ?`;
  }
  if (left._tag === "Literal" && right._tag === "Field") {
    if (left.value === null && filter._tag === "Eq") {
      return `${internalFieldExpression(target, right.fieldPath)} IS NULL`;
    }
    if (left.value === null && filter._tag === "Neq") {
      return `${internalFieldExpression(target, right.fieldPath)} IS NOT NULL`;
    }
    params.push(left.value);
    return `? ${op} ${internalFieldExpression(target, right.fieldPath)}`;
  }
  return null;
}

function decodeInternalRow(
  target: TableStorageTarget,
  row: Record<string, unknown>,
): StoredDocument {
  const doc: Record<string, unknown> = {
    _id: String(row.id),
    _creationTime: Number(row.creation_time ?? 0),
  };
  if (!target.internalSpec) {
    return doc as StoredDocument;
  }
  for (const [field, spec] of Object.entries(target.internalSpec.fields)) {
    const value = row[spec.column];
    if (value === null && !spec.preserveNull) {
      continue;
    }
    if (value !== undefined) {
      doc[field] = value;
    }
  }
  return doc as StoredDocument;
}

function buildStoredDocumentSelectSql(
  target: TableStorageTarget,
  fromClause: string = target.fromClause,
): string {
  if (!target.internalSpec) {
    return `SELECT data FROM ${fromClause}`;
  }

  const fieldColumns = Object.values(target.internalSpec.fields)
    .map((field) => `, ${quoteIdentifier(field.column)}`)
    .join("");
  return `SELECT id, creation_time${fieldColumns} FROM ${fromClause}`;
}

function decodeStoredRows(
  target: TableStorageTarget,
  rows: Record<string, unknown>[],
): StoredDocument[] {
  if (target.internalSpec) {
    return rows.map((row) => decodeInternalRow(target, row));
  }
  return rows.map((row) => decodeStoredDocument(String(row.data)));
}

async function queryStoredDocuments(
  driver: SqliteDriver,
  target: TableStorageTarget,
  statement: SqliteStatement,
): Promise<StoredDocument[]> {
  const rows = await driver.query<Record<string, unknown>>(
    statement.sql,
    statement.params,
  );
  return decodeStoredRows(target, rows);
}

function isConvexUndefined(value: unknown): boolean {
  if (value === undefined || value === null) {
    return value === undefined;
  }
  if (typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.$undefined === true || record.$undefined === null;
}

function internalInsertStatement(
  target: TableStorageTarget,
  doc: StoredDocument,
): SqliteStatement {
  const spec = target.internalSpec;
  if (!spec) {
    throw new Error(
      "internalInsertStatement requires an internal table target",
    );
  }
  const columns = [
    "id",
    "creation_time",
    ...Object.values(spec.fields).map((field) => field.column),
  ];
  const params: unknown[] = [String(doc._id), documentCreationTime(doc)];
  for (const fieldName of Object.keys(spec.fields)) {
    const value = (doc as Record<string, unknown>)[fieldName];
    params.push(isConvexUndefined(value) ? null : (value as unknown));
  }
  return {
    sql: `INSERT OR REPLACE INTO ${target.fromClause} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    params,
  };
}

async function tableExists(
  driver: SqliteDriver,
  tableName: string,
): Promise<boolean> {
  const rows = await driver.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName],
  );
  return rows.length > 0;
}

async function inferAdapterSchemaVersion(
  driver: SqliteDriver,
): Promise<number | null> {
  if (await tableExists(driver, SQLITE_ADAPTER_META_TABLE)) {
    const rows = await driver.query<{ schema_version: number }>(
      `SELECT schema_version FROM ${SQLITE_ADAPTER_META_TABLE} WHERE id = 1`,
    );
    const schemaVersion = Number(rows[0]?.schema_version);
    if (Number.isFinite(schemaVersion)) {
      return schemaVersion;
    }
  }

  const hasLegacyDocuments = await tableExists(driver, "documents");
  const hasLegacyMeta = await tableExists(driver, "meta");
  const hasLegacyBlobs = await tableExists(driver, "blobs");
  return hasLegacyDocuments || hasLegacyMeta || hasLegacyBlobs ? 1 : null;
}

async function ensureLegacyDocumentColumns(
  driver: SqliteDriver,
): Promise<void> {
  const documentColumns = await driver.query<{ name: string }>(
    "PRAGMA table_info(documents)",
  );
  const columnNames = new Set(documentColumns.map((column) => column.name));

  if (!columnNames.has("creation_time")) {
    await driver.execute(
      "ALTER TABLE documents ADD COLUMN creation_time REAL NOT NULL DEFAULT 0",
    );
  }
  if (!columnNames.has("identity_key")) {
    await driver.execute("ALTER TABLE documents ADD COLUMN identity_key TEXT");
  }

  await driver.execute(
    "UPDATE documents SET creation_time = COALESCE(CAST(json_extract(data, '$._creationTime') AS REAL), 0) WHERE creation_time IS NULL OR creation_time = 0",
  );
  await driver.execute(
    "UPDATE documents SET identity_key = json_extract(data, '$.__identityKey') WHERE identity_key IS NULL",
  );
}

function buildSearchCandidateStatement(input: {
  source: Extract<PersistenceQueryRead["source"], { type: "Search" }>;
  activeIdentityKey?: string | null;
  target: TableStorageTarget;
}): SqliteStatement {
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (input.activeIdentityKey === null) {
    clauses.push("identity_key IS NULL");
  } else if (typeof input.activeIdentityKey === "string") {
    clauses.push("identity_key = ?");
    params.push(input.activeIdentityKey);
  }

  for (const filter of input.source.filters) {
    if (filter.type !== "Eq") {
      continue;
    }
    const expression = internalFilterWhereClause(
      input.target,
      {
        _tag: "Eq",
        left: { _tag: "Field", fieldPath: filter.fieldPath },
        right: { _tag: "Literal", value: filter.value },
      },
      params,
    );
    if (expression) {
      clauses.push(expression);
    }
  }

  return {
    sql: `SELECT data FROM ${input.target.fromClause}${clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""}`,
    params,
  };
}

function sideTableEntryId(
  tableName: string,
  indexName: string,
  docId: string,
): string {
  return `${tableName}\x00${indexName}\x00${docId}`;
}

function sideTableBucketId(
  tableName: string,
  indexName: string,
  docId: string,
  fieldPath: string,
): string {
  return `${tableName}\x00${indexName}\x00${docId}\x00${fieldPath}`;
}

function evaluateDocFieldPath(doc: StoredDocument, fieldPath: string): unknown {
  if (fieldPath === "_id") return doc._id;
  if (fieldPath === "_creationTime") return doc._creationTime;
  const parts = fieldPath.split(".");
  let current: unknown = doc;
  for (const part of parts) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function canonicalBucketKey(value: unknown): string {
  if (value === undefined) {
    return JSON.stringify({ $undefined: true });
  }
  return JSON.stringify(value);
}

function deleteSideTableEntryStatements(
  kind: SideTableKind,
  tableName: string,
  docId: string,
): SqliteStatement[] {
  const names = SIDE_TABLE_PHYSICAL_NAMES[kind];
  return [
    {
      sql: `DELETE FROM ${quoteIdentifier(names.entries)} WHERE table_name = ? AND doc_id = ?`,
      params: [tableName, docId],
    },
    {
      sql: `DELETE FROM ${quoteIdentifier(names.buckets)} WHERE table_name = ? AND doc_id = ?`,
      params: [tableName, docId],
    },
  ];
}

function upsertSideTableEntryStatements(input: {
  kind: SideTableKind;
  tableName: string;
  definition: SideTableDefinition;
  doc: StoredDocument;
}): SqliteStatement[] {
  const { kind, tableName, definition, doc } = input;
  const names = SIDE_TABLE_PHYSICAL_NAMES[kind];
  const docId = String(doc._id);
  const indexName = definition.indexDescriptor;
  const identityKey = documentIdentityKey(doc);
  const creationTime = documentCreationTime(doc);
  const statements: SqliteStatement[] = [
    {
      sql: `INSERT OR REPLACE INTO ${quoteIdentifier(names.entries)} (entry_id, table_name, index_name, doc_id, identity_key, creation_time, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        sideTableEntryId(tableName, indexName, docId),
        tableName,
        indexName,
        docId,
        identityKey,
        creationTime,
        JSON.stringify(doc),
      ],
    },
    {
      sql: `DELETE FROM ${quoteIdentifier(names.buckets)} WHERE table_name = ? AND index_name = ? AND doc_id = ?`,
      params: [tableName, indexName, docId],
    },
  ];
  for (const fieldPath of definition.filterFields) {
    const value = evaluateDocFieldPath(doc, fieldPath);
    statements.push({
      sql: `INSERT OR REPLACE INTO ${quoteIdentifier(names.buckets)} (bucket_id, table_name, index_name, field_path, bucket_key, doc_id, identity_key) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        sideTableBucketId(tableName, indexName, docId, fieldPath),
        tableName,
        indexName,
        fieldPath,
        canonicalBucketKey(value),
        docId,
        identityKey,
      ],
    });
  }
  return statements;
}

async function countSideTableEntries(input: {
  driver: SqliteDriver;
  kind: SideTableKind;
  tableName: string;
  indexName?: string;
}): Promise<number> {
  const { driver, kind, tableName, indexName } = input;
  const names = SIDE_TABLE_PHYSICAL_NAMES[kind];
  const clauses = ["table_name = ?"];
  const params: unknown[] = [tableName];
  if (indexName) {
    clauses.push("index_name = ?");
    params.push(indexName);
  }
  const rows = await driver.query<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${quoteIdentifier(names.entries)} WHERE ${clauses.join(" AND ")}`,
    params,
  );
  return rows[0]?.count ?? 0;
}

async function rebuildSideTableFromDocuments<
  TDefinition extends SideTableDefinition,
>(input: {
  driver: SqliteDriver;
  kind: SideTableKind;
  tableName: string;
  definitions: TDefinition[];
  docsReader: (tableName: string) => Promise<StoredDocument[]>;
}): Promise<void> {
  const { driver, kind, tableName, definitions, docsReader } = input;
  if (definitions.length === 0) {
    return;
  }
  if (
    (await countSideTableEntries({
      driver,
      kind,
      tableName,
    })) > 0
  ) {
    return;
  }
  const docs = await docsReader(tableName);
  if (docs.length === 0) {
    return;
  }
  const statements: SqliteStatement[] = [];
  for (const doc of docs) {
    for (const definition of definitions) {
      statements.push(
        ...upsertSideTableEntryStatements({ kind, tableName, definition, doc }),
      );
    }
  }
  if (statements.length > 0) {
    await driver.executeBatch(statements);
  }
}

async function readSearchCandidatesFromSideTable(input: {
  driver: SqliteDriver;
  tableName: string;
  definition: SearchIndexDefinition;
  source: Extract<PersistenceQueryRead["source"], { type: "Search" }>;
  activeIdentityKey?: string | null;
}): Promise<StoredDocument[]> {
  const { driver, tableName, definition, source, activeIdentityKey } = input;
  const indexName = definition.indexDescriptor;
  const names = SIDE_TABLE_PHYSICAL_NAMES.search;

  const params: unknown[] = [tableName, indexName];
  let sql = `SELECT data FROM ${quoteIdentifier(names.entries)} entries WHERE entries.table_name = ? AND entries.index_name = ?`;

  if (activeIdentityKey === null) {
    sql += " AND entries.identity_key IS NULL";
  } else if (typeof activeIdentityKey === "string") {
    sql += " AND entries.identity_key = ?";
    params.push(activeIdentityKey);
  }

  for (const filter of source.filters) {
    if (filter.type !== "Eq") {
      continue;
    }
    if (!definition.filterFields.includes(filter.fieldPath)) {
      continue;
    }
    sql += ` AND EXISTS (SELECT 1 FROM ${quoteIdentifier(names.buckets)} buckets WHERE buckets.table_name = entries.table_name AND buckets.index_name = entries.index_name AND buckets.doc_id = entries.doc_id AND buckets.field_path = ? AND buckets.bucket_key = ?)`;
    params.push(filter.fieldPath);
    params.push(canonicalBucketKey(filter.value));
  }

  const rows = await driver.query<{ data: string }>(sql, params);
  return rows.map(({ data }) => decodeStoredDocument(data));
}

async function readVectorCandidatesFromSideTable(input: {
  driver: SqliteDriver;
  tableName: string;
  args: PersistenceVectorRead;
}): Promise<StoredDocument[]> {
  const { driver, tableName, args } = input;
  const indexName = args.definition.indexDescriptor;
  const names = SIDE_TABLE_PHYSICAL_NAMES.vector;

  const params: unknown[] = [tableName, indexName];
  let sql = `SELECT DISTINCT entries.data FROM ${quoteIdentifier(names.entries)} entries WHERE entries.table_name = ? AND entries.index_name = ?`;

  if (args.activeIdentityKey === null) {
    sql += " AND entries.identity_key IS NULL";
  } else if (typeof args.activeIdentityKey === "string") {
    sql += " AND entries.identity_key = ?";
    params.push(args.activeIdentityKey);
  }

  const groups = buildVectorFilterSqlClauseGroups(args.filter, args.definition);
  for (const group of groups) {
    if (group.clauses.length === 0) {
      continue;
    }
    const expressions: string[] = [];
    for (const clause of group.clauses) {
      expressions.push(`(buckets.field_path = ? AND buckets.bucket_key = ?)`);
      params.push(clause.fieldPath);
      params.push(clause.bucketKey);
    }
    sql += ` AND EXISTS (SELECT 1 FROM ${quoteIdentifier(names.buckets)} buckets WHERE buckets.table_name = entries.table_name AND buckets.index_name = entries.index_name AND buckets.doc_id = entries.doc_id AND (${expressions.join(" OR ")}))`;
  }

  const rows = await driver.query<{ data: string }>(sql, params);
  return rows.map(({ data }) => decodeStoredDocument(data));
}

async function readSearch(
  driver: SqliteDriver,
  source: Extract<PersistenceQueryRead["source"], { type: "Search" }>,
  options: PersistenceReadOptions,
  target: TableStorageTarget,
): Promise<StoredDocument[] | null> {
  const definition = options.searchDefinition;
  if (!definition) {
    return null;
  }
  const statement = buildSearchCandidateStatement({
    source,
    activeIdentityKey: options.activeIdentityKey,
    target,
  });
  const rows = await driver.query<{ data: string }>(
    statement.sql,
    statement.params,
  );
  return executeSearch(
    buildSearchIndexState({
      docs: rows.map(({ data }) => {
        const doc = decodeStoredDocument(data) as StoredDocument &
          Record<string, unknown>;
        const raw = doc[IDENTITY_SCOPE_FIELD];
        return {
          doc,
          identityKey: typeof raw === "string" ? raw : null,
        };
      }),
      definition,
    }),
    {
      source,
      activeIdentityKey: options.activeIdentityKey ?? null,
      limit: options.limit ?? undefined,
    },
  );
}

async function readVectorCandidates(
  driver: SqliteDriver,
  target: TableStorageTarget,
  args: PersistenceVectorRead,
): Promise<StoredDocument[]> {
  if (target.internalSpec) {
    return [];
  }
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (args.activeIdentityKey === null) {
    clauses.push("identity_key IS NULL");
  } else if (typeof args.activeIdentityKey === "string") {
    clauses.push("identity_key = ?");
    params.push(args.activeIdentityKey);
  }

  for (const group of buildVectorFilterSqlClauseGroups(
    args.filter,
    args.definition,
  )) {
    const expressions = group.clauses.map((clause) => {
      params.push(JSON.parse(clause.bucketKey));
      return `${internalFieldExpression(target, clause.fieldPath)} = ?`;
    });
    if (expressions.length > 0) {
      clauses.push(`(${expressions.join(" OR ")})`);
    }
  }

  let sql = `SELECT data FROM ${target.fromClause}`;
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(" AND ")}`;
  }
  const rows = await driver.query<{ data: string }>(sql, params);
  return rows.map(({ data }) => decodeStoredDocument(data));
}

async function readTableDocuments(
  driver: SqliteDriver,
  target: TableStorageTarget,
): Promise<StoredDocument[]> {
  return queryStoredDocuments(driver, target, {
    sql: `${buildStoredDocumentSelectSql(target)} ORDER BY creation_time ASC, id ASC`,
  });
}

async function applyCommitBatch(
  driver: SqliteDriver,
  batch: CommitBatch,
  resolveTarget: (tableName: string) => Promise<TableStorageTarget>,
  registry: SearchVectorIndexRegistry,
): Promise<void> {
  const statements: SqliteStatement[] = [];
  for (const { doc, tableName } of batch.puts) {
    const target = await resolveTarget(tableName);
    statements.push(
      target.internalSpec
        ? internalInsertStatement(target, doc)
        : {
            sql: `INSERT OR REPLACE INTO ${target.fromClause} (id, creation_time, identity_key, data) VALUES (?, ?, ?, ?)`,
            params: [
              String(doc._id),
              documentCreationTime(doc),
              documentIdentityKey(doc),
              JSON.stringify(doc),
            ],
          },
    );
    const searchDefs = registry.search.get(tableName);
    if (searchDefs && searchDefs.length > 0) {
      for (const definition of searchDefs) {
        statements.push(
          ...upsertSideTableEntryStatements({
            kind: "search",
            tableName,
            definition,
            doc,
          }),
        );
      }
    }
    const vectorDefs = registry.vector.get(tableName);
    if (vectorDefs && vectorDefs.length > 0) {
      for (const definition of vectorDefs) {
        // Persist candidate rows even when the vector field is absent; the
        // runtime ranking path filters them out during materialization.
        statements.push(
          ...upsertSideTableEntryStatements({
            kind: "vector",
            tableName,
            definition,
            doc,
          }),
        );
      }
    }
  }
  for (const { id, tableName } of batch.deletes) {
    const target = await resolveTarget(tableName);
    statements.push({
      sql: `DELETE FROM ${target.fromClause} WHERE id = ?`,
      params: [id],
    });
    statements.push(...deleteSideTableEntryStatements("search", tableName, id));
    statements.push(...deleteSideTableEntryStatements("vector", tableName, id));
  }
  statements.push({
    sql: "INSERT OR REPLACE INTO meta (id, timestamp, last_creation_time) VALUES (1, ?, ?)",
    params: [batch.meta.timestamp, batch.meta.lastCreationTime],
  });
  await driver.executeBatch(statements);
}

function sourceQuerySql(
  source: Exclude<PersistenceQueryRead["source"], { type: "Search" }>,
  options: PersistenceReadOptions,
  target: TableStorageTarget,
): SqliteStatement {
  const params: unknown[] = [];
  let sql = buildStoredDocumentSelectSql(target);

  if (source.type === "FullTableScan") {
    sql += ` ORDER BY ${internalOrderByClause(target, ["_creationTime"], source.order ?? "asc")}`;
  } else {
    const clauses = internalRangeWhereClause({ target, range: source, params });
    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(" AND ")}`;
    }
    sql += ` ORDER BY ${internalOrderByClause(target, options.indexFields ?? [], source.order ?? "asc")}`;
  }

  if (typeof options.limit === "number") {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  return { sql, params };
}

function pushedQuerySql(
  args: PersistenceQueryRead,
  target: TableStorageTarget,
): SqliteStatement | null {
  if (args.source.type === "Search") {
    return null;
  }
  const params: unknown[] = [];
  const clauses: string[] = [];
  let sql = buildStoredDocumentSelectSql(target);

  if (args.source.type !== "FullTableScan") {
    clauses.push(
      ...internalRangeWhereClause({ target, range: args.source, params }),
    );
  }

  for (const filter of args.filters) {
    const clause = internalFilterWhereClause(target, filter, params);
    if (clause === null) {
      return null;
    }
    clauses.push(clause);
  }

  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(" AND ")}`;
  }
  const orderFields =
    args.source.type === "FullTableScan"
      ? ["_creationTime"]
      : (args.indexFields ?? []);
  sql += ` ORDER BY ${internalOrderByClause(target, orderFields, args.source.order ?? "asc")}`;
  if (typeof args.limit === "number") {
    sql += " LIMIT ?";
    params.push(args.limit);
  }
  return { sql, params };
}

async function ensureSqliteSchema(driver: SqliteDriver): Promise<void> {
  await driver.execute("PRAGMA journal_mode = WAL");

  const schemaVersion = await inferAdapterSchemaVersion(driver);

  for (const statement of LEGACY_SCHEMA_STATEMENTS) {
    await driver.execute(statement);
  }
  await ensureLegacyDocumentColumns(driver);
  for (const statement of ROUTING_SCHEMA_STATEMENTS) {
    await driver.execute(statement);
  }
  for (const statement of SEARCH_VECTOR_SCHEMA_STATEMENTS) {
    await driver.execute(statement);
  }

  if (schemaVersion === null || schemaVersion < SQLITE_ADAPTER_SCHEMA_VERSION) {
    await driver.execute(
      `INSERT OR REPLACE INTO ${SQLITE_ADAPTER_META_TABLE} (id, schema_version) VALUES (1, ?)`,
      [SQLITE_ADAPTER_SCHEMA_VERSION],
    );
  }
}

async function listTableRoutes(driver: SqliteDriver): Promise<TableRouteRow[]> {
  return driver.query<TableRouteRow>(
    `SELECT table_name, physical_table_name FROM ${SQLITE_TABLE_ROUTING_TABLE}`,
  );
}

async function listLegacySharedTables(driver: SqliteDriver): Promise<string[]> {
  const rows = await driver.query<{ table_name: string }>(
    "SELECT DISTINCT table_name FROM documents WHERE table_name IS NOT NULL AND table_name != ''",
  );
  return rows.map((row) => row.table_name);
}

export async function createSqlitePersistenceAdapter(input: {
  driver: SqliteDriver;
}): Promise<SqlPersistenceAdapter> {
  const { driver } = input;
  await ensureSqliteSchema(driver);

  const tableRouteCache = new Map<string, string | null>();
  const indexRegistry: SearchVectorIndexRegistry = {
    search: new Map(),
    vector: new Map(),
  };

  function updateRegistry(options: SqlCommitApplyOptions | undefined): void {
    if (options?.tableSearchIndexes) {
      for (const [tableName, definitions] of Object.entries(
        options.tableSearchIndexes,
      )) {
        indexRegistry.search.set(tableName, definitions ?? []);
      }
    }
    if (options?.tableVectorIndexes) {
      for (const [tableName, definitions] of Object.entries(
        options.tableVectorIndexes,
      )) {
        indexRegistry.vector.set(tableName, definitions ?? []);
      }
    }
  }

  async function getPhysicalTableName(
    tableName: string,
  ): Promise<string | null> {
    if (tableRouteCache.has(tableName)) {
      return tableRouteCache.get(tableName) ?? null;
    }
    const rows = await driver.query<{ physical_table_name: string }>(
      `SELECT physical_table_name FROM ${SQLITE_TABLE_ROUTING_TABLE} WHERE table_name = ?`,
      [tableName],
    );
    const physicalTableName = rows[0]?.physical_table_name ?? null;
    tableRouteCache.set(tableName, physicalTableName);
    return physicalTableName;
  }

  async function getStorageTarget(
    tableName: string,
  ): Promise<TableStorageTarget> {
    const physicalTableName = await ensurePhysicalTableRoute(tableName);
    return {
      kind: "physical",
      tableName,
      physicalTableName,
      fromClause: quoteIdentifier(physicalTableName),
      internalSpec: INTERNAL_TABLE_SPECS[tableName] ?? null,
    };
  }

  async function ensurePhysicalTableRoute(tableName: string): Promise<string> {
    const existing = await getPhysicalTableName(tableName);
    if (existing) {
      const desired = physicalTableNameFor(tableName);
      const internal = INTERNAL_TABLE_SPECS[tableName];
      if (internal && existing !== desired) {
        const target = {
          kind: "physical" as const,
          tableName,
          physicalTableName: desired,
          fromClause: quoteIdentifier(desired),
          internalSpec: internal,
        };
        const legacyRows = await driver.query<{ data: string }>(
          `SELECT data FROM ${quoteIdentifier(existing)}`,
        );
        await driver.executeBatch([
          ...buildPhysicalTableSchema(tableName),
          ...legacyRows.map(({ data }) =>
            internalInsertStatement(target, decodeStoredDocument(data)),
          ),
          {
            sql: `INSERT OR REPLACE INTO ${SQLITE_TABLE_ROUTING_TABLE} (table_name, physical_table_name) VALUES (?, ?)`,
            params: [tableName, desired],
          },
        ]);
        tableRouteCache.set(tableName, desired);
        return desired;
      }
      return existing;
    }

    const physicalTableName = physicalTableNameFor(tableName);
    const internal = INTERNAL_TABLE_SPECS[tableName];
    const target = {
      kind: "physical" as const,
      tableName,
      physicalTableName,
      fromClause: quoteIdentifier(physicalTableName),
      internalSpec: internal ?? null,
    };
    const legacyRows = await driver.query<{ data: string }>(
      "SELECT data FROM documents WHERE table_name = ?",
      [tableName],
    );
    await driver.executeBatch([
      ...buildPhysicalTableSchema(tableName),
      {
        sql: `INSERT OR REPLACE INTO ${SQLITE_TABLE_ROUTING_TABLE} (table_name, physical_table_name) VALUES (?, ?)`,
        params: [tableName, physicalTableName],
      },
      ...(internal
        ? legacyRows.map(({ data }) =>
            internalInsertStatement(target, decodeStoredDocument(data)),
          )
        : [
            {
              sql: `INSERT OR REPLACE INTO ${quoteIdentifier(physicalTableName)} (id, creation_time, identity_key, data)
                    SELECT id, creation_time, identity_key, data FROM documents WHERE table_name = ?`,
              params: [tableName],
            },
          ]),
      {
        sql: "DELETE FROM documents WHERE table_name = ?",
        params: [tableName],
      },
    ]);
    tableRouteCache.set(tableName, physicalTableName);
    return physicalTableName;
  }

  async function migrateLegacySharedTablesToPhysical(): Promise<void> {
    const legacyTables = await listLegacySharedTables(driver);
    for (const tableName of legacyTables) {
      await ensurePhysicalTableRoute(tableName);
    }
  }

  async function getAllDocuments(): Promise<StoredDocumentWithTable[]> {
    const results: StoredDocumentWithTable[] = [];

    for (const route of await listTableRoutes(driver)) {
      tableRouteCache.set(route.table_name, route.physical_table_name);
      const target: TableStorageTarget = {
        kind: "physical",
        tableName: route.table_name,
        physicalTableName: route.physical_table_name,
        fromClause: quoteIdentifier(route.physical_table_name),
        internalSpec: INTERNAL_TABLE_SPECS[route.table_name] ?? null,
      };
      const tableRows = await readTableDocuments(driver, target);
      results.push(
        ...tableRows.map((doc) => ({
          doc,
          tableName: route.table_name,
        })),
      );
    }

    return results;
  }

  await migrateLegacySharedTablesToPhysical();

  return {
    kind: "sql",
    async getDocuments(): Promise<StoredDocumentWithTable[]> {
      return getAllDocuments();
    },
    async getDocumentsByTable(tableName: string): Promise<StoredDocument[]> {
      const target = await getStorageTarget(tableName);
      return readTableDocuments(driver, target);
    },
    async hasAnyDocuments(tableName: string): Promise<boolean> {
      const physicalTableName = await getPhysicalTableName(tableName);
      if (!physicalTableName) {
        return false;
      }
      const rows = await driver.query<{ exists_marker: number }>(
        `SELECT 1 AS exists_marker FROM ${quoteIdentifier(physicalTableName)} LIMIT 1`,
      );
      return rows.length > 0;
    },
    async listDocuments(tableName: string): Promise<StoredDocument[]> {
      const target = await getStorageTarget(tableName);
      return readTableDocuments(driver, target);
    },
    async getDocument(
      tableName: string,
      id: string,
    ): Promise<StoredDocument | null> {
      const target = await getStorageTarget(tableName);
      const docs = await queryStoredDocuments(driver, target, {
        sql: `${buildStoredDocumentSelectSql(target)} WHERE id = ?`,
        params: [id],
      });
      return docs[0] ?? null;
    },
    async getDocumentsByTables(
      tableNames: string[],
    ): Promise<StoredDocumentWithTable[]> {
      if (tableNames.length === 0) return [];
      const results: StoredDocumentWithTable[] = [];
      for (const tableName of tableNames) {
        const target = await getStorageTarget(tableName);
        const docs = await readTableDocuments(driver, target);
        results.push(...docs.map((doc) => ({ doc, tableName })));
      }
      return results;
    },
    async getMeta(): Promise<DatabaseMeta | null> {
      const rows = await driver.query<{
        timestamp: number;
        last_creation_time: number;
      }>("SELECT timestamp, last_creation_time FROM meta WHERE id = 1");
      const row = rows[0];
      return row
        ? { timestamp: row.timestamp, lastCreationTime: row.last_creation_time }
        : null;
    },
    async countDocuments(tableName: string): Promise<number> {
      const target = await getStorageTarget(tableName);
      const rows = await driver.query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${target.fromClause}`,
      );
      return rows[0]?.count ?? 0;
    },
    async readSource(source, options = {}): Promise<StoredDocument[] | null> {
      const target = await getStorageTarget(sourceTableName(source));
      if (source.type === "Search") {
        const definition = options.searchDefinition;
        if (!definition) {
          return null;
        }
        await rebuildSideTableFromDocuments({
          driver,
          kind: "search",
          tableName: target.tableName,
          definitions: [definition],
          docsReader: async (tableName) =>
            readTableDocuments(driver, await getStorageTarget(tableName)),
        });
        if (
          (await countSideTableEntries({
            driver,
            kind: "search",
            tableName: target.tableName,
            indexName: definition.indexDescriptor,
          })) === 0
        ) {
          return readSearch(driver, source, options, target);
        }
        const candidates = await readSearchCandidatesFromSideTable({
          driver,
          tableName: target.tableName,
          definition,
          source,
          activeIdentityKey: options.activeIdentityKey,
        });
        return executeSearch(
          buildSearchIndexState({
            docs: candidates.map((doc) => {
              const record = doc as StoredDocument & Record<string, unknown>;
              return {
                doc: record,
                identityKey:
                  (record[IDENTITY_SCOPE_FIELD] as string | null | undefined) ??
                  null,
              };
            }),
            definition,
          }),
          {
            source,
            activeIdentityKey: options.activeIdentityKey ?? null,
            limit: options.limit ?? undefined,
          },
        );
      }
      const statement = sourceQuerySql(source, options, target);
      return queryStoredDocuments(driver, target, statement);
    },
    async readQuery(args): Promise<StoredDocument[] | null> {
      if (args.source.type === "Search") {
        return null;
      }
      const target = await getStorageTarget(sourceTableName(args.source));
      const statement = pushedQuerySql(args, target);
      if (statement === null) {
        return null;
      }
      return queryStoredDocuments(driver, target, statement);
    },
    async readVectorCandidates(
      args: PersistenceVectorRead,
    ): Promise<StoredDocument[] | null> {
      const target = await getStorageTarget(args.tableName);
      if (target.internalSpec) {
        return [];
      }
      await rebuildSideTableFromDocuments({
        driver,
        kind: "vector",
        tableName: args.tableName,
        definitions: [args.definition],
        docsReader: async (tableName) =>
          readTableDocuments(driver, await getStorageTarget(tableName)),
      });
      if (
        (await countSideTableEntries({
          driver,
          kind: "vector",
          tableName: args.tableName,
          indexName: args.definition.indexDescriptor,
        })) === 0
      ) {
        return readVectorCandidates(driver, target, args);
      }
      return readVectorCandidatesFromSideTable({
        driver,
        tableName: args.tableName,
        args,
      });
    },
    async getBlobs(): Promise<Array<{ id: string; blob: Blob }>> {
      const rows = await driver.query<{ id: string; data: unknown }>(
        "SELECT id, data FROM blobs",
      );
      return rows.map(({ id, data }) => ({ id, blob: decodeBlob(data) }));
    },
    async getBlob(id: string): Promise<Blob | null> {
      const rows = await driver.query<{ data: unknown }>(
        "SELECT data FROM blobs WHERE id = ?",
        [id],
      );
      return rows[0] ? decodeBlob(rows[0].data) : null;
    },
    async commit(batch: CommitBatch): Promise<void> {
      for (const { tableName } of batch.puts) {
        await ensurePhysicalTableRoute(tableName);
      }
      for (const { tableName } of batch.deletes) {
        await ensurePhysicalTableRoute(tableName);
      }

      await applyCommitBatch(driver, batch, getStorageTarget, indexRegistry);
    },
    async applyCommit(
      batch: CommitBatch,
      options: SqlCommitApplyOptions,
    ): Promise<SqlCommitApplyResult> {
      updateRegistry(options);
      for (const { tableName } of batch.puts) {
        await ensurePhysicalTableRoute(tableName);
      }
      for (const { tableName } of batch.deletes) {
        await ensurePhysicalTableRoute(tableName);
      }

      await applyCommitBatch(driver, batch, getStorageTarget, indexRegistry);

      const tables = await Promise.all(
        options.materializedTables.map(async (tableName) => ({
          tableName,
          docs: await readTableDocuments(
            driver,
            await getStorageTarget(tableName),
          ),
        })),
      );

      return {
        meta: batch.meta,
        tables,
      };
    },
    async storeBlob(id: string, blob: Blob): Promise<void> {
      await driver.execute(
        "INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)",
        [id, new Uint8Array(await blob.arrayBuffer())],
      );
    },
    async deleteBlob(id: string): Promise<void> {
      await driver.execute("DELETE FROM blobs WHERE id = ?", [id]);
    },
    async clear(): Promise<void> {
      const routes = await listTableRoutes(driver);
      await driver.executeBatch([
        ...routes.map((route) => ({
          sql: `DELETE FROM ${quoteIdentifier(route.physical_table_name)}`,
        })),
        { sql: `DELETE FROM ${SQLITE_TABLE_ROUTING_TABLE}` },
        { sql: "DELETE FROM documents" },
        { sql: "DELETE FROM meta" },
        { sql: "DELETE FROM blobs" },
        { sql: `DELETE FROM ${quoteIdentifier(SEARCH_ENTRIES_PHYSICAL)}` },
        { sql: `DELETE FROM ${quoteIdentifier(SEARCH_BUCKETS_PHYSICAL)}` },
        { sql: `DELETE FROM ${quoteIdentifier(VECTOR_ENTRIES_PHYSICAL)}` },
        { sql: `DELETE FROM ${quoteIdentifier(VECTOR_BUCKETS_PHYSICAL)}` },
      ]);
      tableRouteCache.clear();
      indexRegistry.search.clear();
      indexRegistry.vector.clear();
    },
    close: async () => {
      await driver.close?.();
    },
  };
}
