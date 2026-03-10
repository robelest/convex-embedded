/**
 * Query evaluation engine.
 *
 * Ported from convex-test. Evaluates SerializedQuery against an
 * in-memory document set: full table scans, index range scans,
 * full-text search, filters, ordering, pagination, and vector search.
 */
import type { GenericDocument } from "convex/server";
import type { JSONValue, Value } from "convex/values";
import { jsonToConvex } from "convex/values";

import { compareValues } from "@/core/compare";
import type { ParsedSchema } from "@/core/schema";
import type {
  FilterJson,
  IndexInfo,
  QueryId,
  SerializedQuery,
  SerializedRangeExpression,
  SerializedSearchFilter,
  Source,
  StoredDocument,
  VectorIndexInfo,
} from "@/core/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSimpleObject(value: unknown): boolean {
  const isObject = typeof value === "object";
  const prototype = Object.getPrototypeOf(value);
  const isSimple =
    prototype === null ||
    prototype === Object.prototype ||
    prototype?.constructor?.name === "Object";
  return isObject && isSimple;
}

/** Walk a dot-separated field path on a document. */
export function evaluateFieldPath(
  fieldPath: string,
  document: GenericDocument,
): Value | undefined {
  const pathParts = fieldPath.split(".");
  let result: Value | undefined = document as Value;
  for (const p of pathParts) {
    result =
      result !== undefined && result !== null && isSimpleObject(result)
        ? ((result as Record<string, Value | undefined>)[p] as
            | Value
            | undefined)
        : undefined;
  }
  return result;
}

/** Convert a JSONValue to a Convex value, handling $undefined. */
function evaluateValue(value: JSONValue): Value | undefined {
  if (typeof value === "object" && value !== null && "$undefined" in value) {
    return undefined;
  }
  return jsonToConvex(value);
}

// ---------------------------------------------------------------------------
// Filter evaluation
// ---------------------------------------------------------------------------

export function evaluateFilter(
  document: GenericDocument,
  filter: FilterJson,
): Value | undefined {
  // FilterJson is a discriminated union of operator objects | JSONValue.
  // TypeScript can't narrow the union via property access because JSONValue
  // includes `{ [key: string]: JSONValue }`. We cast to `any` at the boundary
  // and access operator fields directly — this is a runtime interpreter.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f = filter as any;
  if (f.$eq !== undefined) {
    return (
      compareValues(
        evaluateFilter(document, f.$eq[0]),
        evaluateFilter(document, f.$eq[1]),
      ) === 0
    );
  }
  if (f.$neq !== undefined) {
    return (
      compareValues(
        evaluateFilter(document, f.$neq[0]),
        evaluateFilter(document, f.$neq[1]),
      ) !== 0
    );
  }
  if (f.$and !== undefined) {
    return f.$and.every((child: FilterJson) => evaluateFilter(document, child));
  }
  if (f.$or !== undefined) {
    return f.$or.some((child: FilterJson) => evaluateFilter(document, child));
  }
  if (f.$not !== undefined) {
    return !evaluateFilter(document, f.$not);
  }
  if (f.$gt !== undefined) {
    return (
      evaluateFilter(document, f.$gt[0])! > evaluateFilter(document, f.$gt[1])!
    );
  }
  if (f.$gte !== undefined) {
    return (
      evaluateFilter(document, f.$gte[0])! >=
      evaluateFilter(document, f.$gte[1])!
    );
  }
  if (f.$lt !== undefined) {
    return (
      evaluateFilter(document, f.$lt[0])! < evaluateFilter(document, f.$lt[1])!
    );
  }
  if (f.$lte !== undefined) {
    return (
      evaluateFilter(document, f.$lte[0])! <=
      evaluateFilter(document, f.$lte[1])!
    );
  }
  if (f.$add !== undefined) {
    return (
      (evaluateFilter(document, f.$add[0]) as number) +
      (evaluateFilter(document, f.$add[1]) as number)
    );
  }
  if (f.$sub !== undefined) {
    return (
      (evaluateFilter(document, f.$sub[0]) as number) -
      (evaluateFilter(document, f.$sub[1]) as number)
    );
  }
  if (f.$mul !== undefined) {
    return (
      (evaluateFilter(document, f.$mul[0]) as number) *
      (evaluateFilter(document, f.$mul[1]) as number)
    );
  }
  if (f.$div !== undefined) {
    return (
      (evaluateFilter(document, f.$div[0]) as number) /
      (evaluateFilter(document, f.$div[1]) as number)
    );
  }
  if (f.$mod !== undefined) {
    return (
      (evaluateFilter(document, f.$mod[0]) as number) %
      (evaluateFilter(document, f.$mod[1]) as number)
    );
  }
  if (f.$field !== undefined) {
    return evaluateFieldPath(f.$field, document);
  }
  if (f.$literal !== undefined) {
    return evaluateValue(f.$literal);
  }
  throw new Error(`not implemented: ${JSON.stringify(filter)}`);
}

// ---------------------------------------------------------------------------
// Range filter evaluation (for index scans)
// ---------------------------------------------------------------------------

function evaluateRangeFilter(
  document: GenericDocument,
  expr: SerializedRangeExpression,
): boolean {
  const result = evaluateFieldPath(expr.fieldPath, document);
  const value = evaluateValue(expr.value);
  switch (expr.type) {
    case "Eq":
      return compareValues(result, value) === 0;
    case "Gt":
      return compareValues(result, value) > 0;
    case "Gte":
      return compareValues(result, value) >= 0;
    case "Lt":
      return compareValues(result, value) < 0;
    case "Lte":
      return compareValues(result, value) <= 0;
  }
}

// ---------------------------------------------------------------------------
// Search filter evaluation
// ---------------------------------------------------------------------------

function evaluateSearchFilter(
  document: GenericDocument,
  filter: SerializedSearchFilter,
): boolean {
  const result = evaluateFieldPath(filter.fieldPath, document);
  switch (filter.type) {
    case "Eq":
      return compareValues(result, evaluateValue(filter.value)) === 0;
    case "Search": {
      const queryTerms = filter.value
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length > 0);
      const documentWords = (result as string)
        .split(/\s+/)
        .map((word) => word.toLowerCase());
      return queryTerms.some((queryTerm) =>
        documentWords.some((word) => word.startsWith(queryTerm)),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Index range validation
// ---------------------------------------------------------------------------

function validateIndexRangeExpression(
  source: Source & { type: "IndexRange" },
  fields: string[],
): void {
  let fieldIndex = 0;
  let state: "eq" | "gt" | "lt" | "done" = "eq";

  for (const [filterIndex, filter] of source.range.entries()) {
    if (state === "done") {
      throw new Error(
        `Incorrect operator used in \`withIndex\`, cannot chain ` +
          `more operators after both \`.gt\` and \`.lt\` were already used, ` +
          `got \`${printIndexOperator(filter)}\`.`,
      );
    }

    const filterType: "eq" | "gt" | "lt" =
      filter.type === "Gt" || filter.type === "Gte"
        ? "gt"
        : filter.type === "Lt" || filter.type === "Lte"
          ? "lt"
          : "eq";

    switch (`${state}|${filterType}`) {
      case "eq|eq":
      case "eq|gt":
      case "eq|lt":
        if (filter.fieldPath === fields[fieldIndex]) {
          fieldIndex += 1;
          state = filterType;
          continue;
        }
        throw new Error(
          `Incorrect field used in \`withIndex\`, ` +
            `expected "${fields[fieldIndex]}", got "${filter.fieldPath}"`,
        );

      case "lt|gt":
      case "gt|lt":
        if (fieldIndex > 0 && filter.fieldPath === fields[fieldIndex - 1]) {
          state = "done";
          continue;
        }
        throw new Error(
          `Incorrect field used in \`withIndex\`, ` +
            `\`.gt\` and \`.lt\` must operate on the same field, ` +
            `expected "${fields[fieldIndex - 1]}", got "${filter.fieldPath}"`,
        );

      default:
        throw new Error(
          `Incorrect operator used in \`withIndex\`, ` +
            `cannot chain \`.${filter.type.toLowerCase()}()\` ` +
            `after \`.${source.range[filterIndex - 1].type.toLowerCase()}()\``,
        );
    }
  }
}

function printIndexOperator(filter: SerializedRangeExpression): string {
  return `.${filter.type.toLowerCase()}(${filter.fieldPath}, ${JSON.stringify(filter.value)})`;
}

// ---------------------------------------------------------------------------
// Cosine similarity (for vector search)
// ---------------------------------------------------------------------------

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// QueryEngine
// ---------------------------------------------------------------------------

export type DocumentIterator = (
  tableName: string,
  callback: (doc: StoredDocument) => void,
) => void;

/**
 * Stateful query engine. Manages active streaming queries and
 * evaluates them against documents provided by a callback.
 */
export class QueryEngine {
  private _nextQueryId: QueryId = 1;
  private _queryResults: Record<QueryId, Array<GenericDocument>> = {};

  constructor(
    private _schema: ParsedSchema | null,
    private _iterateDocs: DocumentIterator,
  ) {}

  /** Update the document iterator (e.g. after a schema or docs change). */
  setDocumentIterator(iter: DocumentIterator): void {
    this._iterateDocs = iter;
  }

  // -------------------------------------------------------------------------
  // Streaming query
  // -------------------------------------------------------------------------

  startQuery(query: SerializedQuery): QueryId {
    const id = this._nextQueryId;
    const results = this._evaluateQuery(query);
    this._queryResults[id] = results;
    this._nextQueryId += 1;
    return id;
  }

  queryNext(queryId: QueryId): {
    value: GenericDocument | null;
    done: boolean;
  } {
    const results = this._queryResults[queryId];
    if (results === undefined) {
      throw new Error("Bad queryId");
    }
    if (results.length === 0) {
      return { value: null, done: true };
    }
    return { value: results.shift()!, done: false };
  }

  queryCleanup(_queryId: QueryId): void {
    // No-op for now; could free memory.
  }

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  paginate({
    query,
    cursor,
    pageSize,
  }: {
    query: SerializedQuery;
    cursor: string | null;
    pageSize: number;
  }): { page: GenericDocument[]; isDone: boolean; continueCursor: string } {
    const queryId = this.startQuery(query);
    const page: GenericDocument[] = [];
    let isInPage = cursor === null;
    let isDone = false;
    let continueCursor = "_end_cursor";

    for (;;) {
      const { value, done } = this.queryNext(queryId);
      if (done) {
        isDone = true;
        continueCursor = "_end_cursor";
        break;
      }
      if (isInPage) {
        page.push(value!);
        if (page.length >= pageSize) {
          continueCursor = value!._id as string;
          break;
        }
      }
      if (value!._id === cursor) {
        isInPage = true;
      }
    }
    return { page, isDone, continueCursor };
  }

  // -------------------------------------------------------------------------
  // Count
  // -------------------------------------------------------------------------

  count(tableName: string): number {
    const queryId = this.startQuery({
      source: { type: "FullTableScan", tableName, order: "asc" },
      operators: [],
    });
    let count = 0;
    while (true) {
      const { done } = this.queryNext(queryId);
      if (done) break;
      count += 1;
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Vector search
  // -------------------------------------------------------------------------

  vectorSearch(
    tableAndIndexName: string,
    vector: number[],
    expressions: SerializedRangeExpression[],
    limit: number,
  ): Array<{ _id: string; _score: number }> {
    const results: GenericDocument[] = [];
    const [tableName, indexName] = tableAndIndexName.split(".");
    this._iterateDocs(tableName, (doc) => {
      if (expressions.every((filter) => evaluateFilter(doc, filter))) {
        results.push(doc);
      }
    });

    const vectorIndexes = this._schema?.tables.get(tableName)?.vectorIndexes;
    const vectorIndex = vectorIndexes?.find(
      ({ indexDescriptor }) => indexDescriptor === indexName,
    );
    if (vectorIndex === undefined) {
      throw new Error(
        `Cannot use vector index "${indexName}" for table "${tableName}" because ` +
          `it is not declared in the schema.`,
      );
    }

    const { vectorField } = vectorIndex;
    const idsAndScores = results.map((doc) => {
      const score = cosineSimilarity(vector, doc[vectorField] as number[]);
      return { _id: doc._id as string, _score: score };
    });
    idsAndScores.sort((a, b) => b._score - a._score);
    return idsAndScores.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Core evaluation
  // -------------------------------------------------------------------------

  private _evaluateQuery(query: SerializedQuery): Array<GenericDocument> {
    const source = query.source;
    let results: GenericDocument[] = [];
    let fieldPathsToSortBy: string[];
    let order: "asc" | "desc";

    switch (source.type) {
      case "FullTableScan": {
        this._iterateDocs(source.tableName, (doc) => {
          results.push(doc);
        });
        order = source.order ?? "asc";
        fieldPathsToSortBy = ["_creationTime"];
        break;
      }

      case "IndexRange": {
        const [tableName, indexName] = source.indexName.split(".");
        order = source.order ?? "asc";
        let fields: string[];

        if (indexName === "by_creation_time") {
          fields = ["_creationTime", "_id"];
        } else if (indexName === "by_id") {
          fields = ["_id"];
        } else {
          const indexes = this._schema?.tables.get(tableName)?.indexes;
          const index = indexes?.find(
            ({ indexDescriptor }) => indexDescriptor === indexName,
          );
          if (index === undefined) {
            throw new Error(
              `Cannot use index "${indexName}" for table "${tableName}" because ` +
                `it is not declared in the schema.`,
            );
          }
          fields = index.fields.concat(["_creationTime", "_id"]);
        }
        fieldPathsToSortBy = fields;

        validateIndexRangeExpression(source, fields);

        this._iterateDocs(tableName, (doc) => {
          if (
            source.range.every((filter) => evaluateRangeFilter(doc, filter))
          ) {
            results.push(doc);
          }
        });
        break;
      }

      case "Search": {
        const [tableName] = source.indexName.split(".");
        this._iterateDocs(tableName, (doc) => {
          if (
            source.filters.every((filter) => evaluateSearchFilter(doc, filter))
          ) {
            results.push(doc);
          }
        });
        fieldPathsToSortBy = [];
        order = "asc";
        break;
      }
    }

    // Apply operator filters.
    const filters = query.operators
      .filter(
        (operator): operator is { filter: FilterJson } => "filter" in operator,
      )
      .map((operator) => operator.filter);

    const limit =
      query.operators.filter(
        (operator): operator is { limit: number } => "limit" in operator,
      )[0] ?? null;

    results = results.filter((v) => filters.every((f) => evaluateFilter(v, f)));

    // Sort.
    results.sort((a, b) => {
      const orderMultiplier = order === "asc" ? 1 : -1;
      let v = 0;
      for (const fp of fieldPathsToSortBy) {
        v = compareValues(evaluateFieldPath(fp, a), evaluateFieldPath(fp, b));
        if (v !== 0) return v * orderMultiplier;
      }
      return v * orderMultiplier;
    });

    // Apply limit.
    if (limit !== null) {
      return results.slice(0, limit.limit);
    }

    return results;
  }
}
