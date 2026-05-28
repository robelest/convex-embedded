/**
 * Shared types used across the embedded Convex runtime.
 */
import type { GenericId, JSONValue, Value } from "convex/values";

/** Equivalent to `GenericDocument` from `convex/server`, defined locally to avoid pulling in `convex/server` in browser/expo bundles. */
export type GenericDocument = Record<string, Value>;

export type TableName = string;
export type DocumentId = GenericId<TableName>;

export type StoredDocument = GenericDocument & {
  _id: DocumentId;
  _creationTime: number;
};

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

export type SeekBound = {
  field: string;
  value: JSONValue;
  inclusive: boolean;
  direction: "asc" | "desc";
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

export type VectorSearchExpression =
  | {
      $eq: [VectorSearchExpression, VectorSearchExpression];
    }
  | {
      $or: VectorSearchExpression[];
    }
  | {
      $field: string;
    }
  | {
      $literal: JSONValue;
    };

export type QueryId = number;

export type QueryDependency =
  | {
      type: "FullTableScan";
      tableName: string;
    }
  | {
      type: "DocumentRead";
      tableName: string;
      id: string;
    }
  | {
      type: "IndexRange";
      tableName: string;
      indexName: string;
      range: ReadonlyArray<SerializedRangeExpression>;
      order: "asc" | "desc" | null;
    }
  | {
      type: "Search";
      tableName: string;
      indexName: string;
      filters: ReadonlyArray<SerializedSearchFilter>;
    }
  | {
      type: "VectorSearch";
      tableName: string;
      indexName: string;
      filter: VectorSearchExpression | null;
    };

/**
 * Monotonic timestamp for MVCC versioning.
 * Increments on each committed mutation.
 */
export type Timestamp = number;
