/**
 * Shared types used across the embedded Convex runtime.
 */
import type { GenericDocument } from "convex/server";
import type { GenericId, JSONValue } from "convex/values";

// ---------------------------------------------------------------------------
// Document types
// ---------------------------------------------------------------------------

export type TableName = string;
export type DocumentId = GenericId<TableName>;

export type StoredDocument = GenericDocument & {
  _id: DocumentId;
  _creationTime: number;
};

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

export type FilterJson =
  | { $eq: [FilterJson, FilterJson] }
  | { $neq: [FilterJson, FilterJson] }
  | { $and: FilterJson[] }
  | { $or: FilterJson[] }
  | { $not: FilterJson }
  | { $gt: [FilterJson, FilterJson] }
  | { $gte: [FilterJson, FilterJson] }
  | { $lt: [FilterJson, FilterJson] }
  | { $lte: [FilterJson, FilterJson] }
  | { $add: [FilterJson, FilterJson] }
  | { $sub: [FilterJson, FilterJson] }
  | { $mul: [FilterJson, FilterJson] }
  | { $div: [FilterJson, FilterJson] }
  | { $mod: [FilterJson, FilterJson] }
  | { $field: string }
  | { $literal: JSONValue }
  | JSONValue;

export type QueryOperator = { filter: FilterJson } | { limit: number };

export type Source =
  | { type: "FullTableScan"; tableName: string; order: "asc" | "desc" | null }
  | {
      type: "IndexRange";
      indexName: string;
      range: ReadonlyArray<SerializedRangeExpression>;
      order: "asc" | "desc" | null;
    }
  | {
      type: "Search";
      indexName: string;
      filters: ReadonlyArray<SerializedSearchFilter>;
    };

export type SerializedQuery = {
  source: Source;
  operators: Array<QueryOperator>;
};

export type SerializedRangeExpression = {
  type: "Eq" | "Gt" | "Gte" | "Lt" | "Lte";
  fieldPath: string;
  value: JSONValue;
};

export type SerializedSearchFilter =
  | {
      type: "Search";
      fieldPath: string;
      value: string;
    }
  | {
      type: "Eq";
      fieldPath: string;
      value: JSONValue;
    };

export type QueryId = number;

// ---------------------------------------------------------------------------
// Index types
// ---------------------------------------------------------------------------

export type IndexInfo = {
  indexDescriptor: string;
  fields: string[];
};

export type VectorIndexInfo = {
  indexDescriptor: string;
  vectorField: string;
  dimensions: number;
  filterFields: string[];
};

// ---------------------------------------------------------------------------
// Timestamp / MVCC
// ---------------------------------------------------------------------------

/**
 * Monotonic timestamp for MVCC versioning.
 * Increments on each committed mutation.
 */
export type Timestamp = number;

// ---------------------------------------------------------------------------
// Bandwidth tracking
// ---------------------------------------------------------------------------

export const FUNCTION_MAX_BANDWIDTH_BYTES = 1 << 24; // 16 MiB
