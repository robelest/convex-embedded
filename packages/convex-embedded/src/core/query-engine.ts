/**
 * Query evaluation engine.
 *
 * Ported from convex-test. Evaluates SerializedQuery against an
 * in-memory document set: full table scans, index range scans,
 * full-text search, filters, ordering, pagination, and vector search.
 */
import { Fx } from "@robelest/fx";
import type { GenericDocument } from "convex/server";
import type { JSONValue, Value } from "convex/values";
import { jsonToConvex } from "convex/values";

import { compareValues } from "@/core/compare";
import type { ParsedSchema } from "@/core/schema";
import type {
  FilterJson,
  QueryId,
  QueryOperator,
  SerializedQuery,
  SerializedRangeExpression,
  SerializedSearchFilter,
  Source,
  StoredDocument,
} from "@/core/types";

type Tagged<Key extends string> = Record<Key, string>;

type FilterNode =
  | { _tag: "Eq"; left: FilterNode; right: FilterNode }
  | { _tag: "Neq"; left: FilterNode; right: FilterNode }
  | { _tag: "And"; children: FilterNode[] }
  | { _tag: "Or"; children: FilterNode[] }
  | { _tag: "Not"; child: FilterNode }
  | { _tag: "Gt"; left: FilterNode; right: FilterNode }
  | { _tag: "Gte"; left: FilterNode; right: FilterNode }
  | { _tag: "Lt"; left: FilterNode; right: FilterNode }
  | { _tag: "Lte"; left: FilterNode; right: FilterNode }
  | { _tag: "Add"; left: FilterNode; right: FilterNode }
  | { _tag: "Sub"; left: FilterNode; right: FilterNode }
  | { _tag: "Mul"; left: FilterNode; right: FilterNode }
  | { _tag: "Div"; left: FilterNode; right: FilterNode }
  | { _tag: "Mod"; left: FilterNode; right: FilterNode }
  | { _tag: "Field"; fieldPath: string }
  | { _tag: "Literal"; value: JSONValue };

type QueryResults = Array<GenericDocument>;

type SourceEvaluation = {
  results: QueryResults;
  fieldPathsToSortBy: string[];
  order: "asc" | "desc";
};

type RangeValidationKind = "eq" | "gt" | "lt";

type RangeValidationState = {
  state: "eq" | "gt" | "lt" | "done";
  fieldIndex: number;
};

type RangeValidationContext = {
  filter: SerializedRangeExpression;
  filterIndex: number;
  fields: string[];
  source: Source & { type: "IndexRange" };
  validation: RangeValidationState;
};

type FilterNormalizer = {
  key: string;
  build: (
    value: unknown,
    normalize: (filter: FilterJson) => FilterNode,
  ) => FilterNode;
};

const rangeKindsByType = {
  Eq: "eq",
  Gt: "gt",
  Gte: "gt",
  Lt: "lt",
  Lte: "lt",
} as const satisfies Record<
  SerializedRangeExpression["type"],
  RangeValidationKind
>;

const builtInIndexFields = {
  by_creation_time: ["_creationTime", "_id"],
  by_id: ["_id"],
} as const satisfies Record<string, readonly string[]>;

const filterNormalizers = [
  {
    key: "$eq",
    build: (value, normalize) => {
      const [left, right] = value as [FilterJson, FilterJson];
      return { _tag: "Eq", left: normalize(left), right: normalize(right) };
    },
  },
  {
    key: "$neq",
    build: (value, normalize) => {
      const [left, right] = value as [FilterJson, FilterJson];
      return { _tag: "Neq", left: normalize(left), right: normalize(right) };
    },
  },
  {
    key: "$and",
    build: (value, normalize) => ({
      _tag: "And",
      children: (value as FilterJson[]).map(normalize),
    }),
  },
  {
    key: "$or",
    build: (value, normalize) => ({
      _tag: "Or",
      children: (value as FilterJson[]).map(normalize),
    }),
  },
  {
    key: "$not",
    build: (value, normalize) => ({
      _tag: "Not",
      child: normalize(value as FilterJson),
    }),
  },
  {
    key: "$gt",
    build: (value, normalize) => {
      const [left, right] = value as [FilterJson, FilterJson];
      return { _tag: "Gt", left: normalize(left), right: normalize(right) };
    },
  },
  {
    key: "$gte",
    build: (value, normalize) => {
      const [left, right] = value as [FilterJson, FilterJson];
      return { _tag: "Gte", left: normalize(left), right: normalize(right) };
    },
  },
  {
    key: "$lt",
    build: (value, normalize) => {
      const [left, right] = value as [FilterJson, FilterJson];
      return { _tag: "Lt", left: normalize(left), right: normalize(right) };
    },
  },
  {
    key: "$lte",
    build: (value, normalize) => {
      const [left, right] = value as [FilterJson, FilterJson];
      return { _tag: "Lte", left: normalize(left), right: normalize(right) };
    },
  },
  {
    key: "$add",
    build: (value, normalize) => {
      const [left, right] = value as [FilterJson, FilterJson];
      return { _tag: "Add", left: normalize(left), right: normalize(right) };
    },
  },
  {
    key: "$sub",
    build: (value, normalize) => {
      const [left, right] = value as [FilterJson, FilterJson];
      return { _tag: "Sub", left: normalize(left), right: normalize(right) };
    },
  },
  {
    key: "$mul",
    build: (value, normalize) => {
      const [left, right] = value as [FilterJson, FilterJson];
      return { _tag: "Mul", left: normalize(left), right: normalize(right) };
    },
  },
  {
    key: "$div",
    build: (value, normalize) => {
      const [left, right] = value as [FilterJson, FilterJson];
      return { _tag: "Div", left: normalize(left), right: normalize(right) };
    },
  },
  {
    key: "$mod",
    build: (value, normalize) => {
      const [left, right] = value as [FilterJson, FilterJson];
      return { _tag: "Mod", left: normalize(left), right: normalize(right) };
    },
  },
  {
    key: "$field",
    build: (value) => ({ _tag: "Field", fieldPath: value as string }),
  },
  {
    key: "$literal",
    build: (value) => ({ _tag: "Literal", value: value as JSONValue }),
  },
] as const satisfies ReadonlyArray<FilterNormalizer>;

const rangeEvaluators = {
  Eq: (result: Value | undefined, value: Value | undefined) =>
    compareValues(result, value) === 0,
  Gt: (result: Value | undefined, value: Value | undefined) =>
    compareValues(result, value) > 0,
  Gte: (result: Value | undefined, value: Value | undefined) =>
    compareValues(result, value) >= 0,
  Lt: (result: Value | undefined, value: Value | undefined) =>
    compareValues(result, value) < 0,
  Lte: (result: Value | undefined, value: Value | undefined) =>
    compareValues(result, value) <= 0,
} as const satisfies Record<
  SerializedRangeExpression["type"],
  (result: Value | undefined, value: Value | undefined) => boolean
>;

const searchEvaluators = {
  Eq: (
    result: Value | undefined,
    filter: Extract<SerializedSearchFilter, { type: "Eq" }>,
  ) => compareValues(result, evaluateValue(filter.value)) === 0,
  Search: (
    result: Value | undefined,
    filter: Extract<SerializedSearchFilter, { type: "Search" }>,
  ) =>
    tokenizeQuery(filter.value).some((queryTerm) =>
      tokenizeDocument(result).some((word) => word.startsWith(queryTerm)),
    ),
} as const;

const operatorTypeGuards = {
  filter: (operator: QueryOperator): operator is { filter: FilterJson } =>
    "filter" in operator,
  limit: (operator: QueryOperator): operator is { limit: number } =>
    "limit" in operator,
} as const;

const rangeValidationHandlers = {
  eq: {
    eq: (ctx: RangeValidationContext) =>
      advanceRangeValidation(ctx, ctx.validation.fieldIndex, "eq", 1),
    gt: (ctx: RangeValidationContext) =>
      advanceRangeValidation(ctx, ctx.validation.fieldIndex, "gt", 1),
    lt: (ctx: RangeValidationContext) =>
      advanceRangeValidation(ctx, ctx.validation.fieldIndex, "lt", 1),
  },
  gt: {
    eq: (ctx: RangeValidationContext) => invalidRangeOperator(ctx),
    gt: (ctx: RangeValidationContext) => invalidRangeOperator(ctx),
    lt: (ctx: RangeValidationContext) =>
      advanceRangeValidation(
        ctx,
        ctx.validation.fieldIndex - 1,
        "done",
        0,
        sameFieldRangeError,
      ),
  },
  lt: {
    eq: (ctx: RangeValidationContext) => invalidRangeOperator(ctx),
    lt: (ctx: RangeValidationContext) => invalidRangeOperator(ctx),
    gt: (ctx: RangeValidationContext) =>
      advanceRangeValidation(
        ctx,
        ctx.validation.fieldIndex - 1,
        "done",
        0,
        sameFieldRangeError,
      ),
  },
  done: {
    eq: (ctx: RangeValidationContext) => invalidRangeCompletion(ctx),
    gt: (ctx: RangeValidationContext) => invalidRangeCompletion(ctx),
    lt: (ctx: RangeValidationContext) => invalidRangeCompletion(ctx),
  },
} as const satisfies Record<
  RangeValidationState["state"],
  Record<
    RangeValidationKind,
    (ctx: RangeValidationContext) => RangeValidationState
  >
>;

function matchTag<
  T extends Tagged<K>,
  K extends keyof T & string,
  Handlers extends {
    [V in T[K] & string]: (value: Extract<T, Record<K, V>>) => unknown;
  },
>(value: T, key: K, handlers: Handlers): ReturnType<Handlers[T[K] & string]> {
  const handler = handlers[value[key] as T[K] & string] as (
    value: T,
  ) => ReturnType<Handlers[T[K] & string]>;
  return handler(value);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSimpleObject(value: unknown): boolean {
  const isObject = value !== null && typeof value === "object";
  if (!isObject) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  const isSimple =
    prototype === null ||
    prototype === Object.prototype ||
    prototype?.constructor?.name === "Object";
  return isSimple;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isSimpleObject(value) ? (value as Record<string, unknown>) : null;
}

function unsupportedFilter(filter: FilterJson): never {
  throw new Error(`not implemented: ${JSON.stringify(filter)}`);
}

function isUndefinedMarker(value: JSONValue): boolean {
  return Fx.pipe(
    asRecord(value),
    (record) => record !== null && "$undefined" in record,
  );
}

/** Walk a dot-separated field path on a document. */
export function evaluateFieldPath(
  fieldPath: string,
  document: GenericDocument,
): Value | undefined {
  return Fx.pipe(fieldPath.split("."), (pathParts) =>
    pathParts.reduce<Value | undefined>(
      (result, part) =>
        result !== undefined && result !== null && isSimpleObject(result)
          ? (result as Record<string, Value | undefined>)[part]
          : undefined,
      document as Value,
    ),
  );
}

/** Convert a JSONValue to a Convex value, handling $undefined. */
function evaluateValue(value: JSONValue): Value | undefined {
  return isUndefinedMarker(value) ? undefined : jsonToConvex(value);
}

function normalizeFilter(filter: FilterJson): FilterNode {
  return Fx.pipe(
    asRecord(filter),
    (record) =>
      record === null
        ? unsupportedFilter(filter)
        : (filterNormalizers.find(({ key }) => key in record) ??
          unsupportedFilter(filter)),
    (normalizer) =>
      normalizer.build(
        (asRecord(filter) as Record<string, unknown>)[normalizer.key],
        normalizeFilter,
      ),
  );
}

function evaluateNumericFilter(
  document: GenericDocument,
  node: Extract<FilterNode, { _tag: "Add" | "Sub" | "Mul" | "Div" | "Mod" }>,
): number {
  const left = evaluateNormalizedFilter(document, node.left) as number;
  const right = evaluateNormalizedFilter(document, node.right) as number;

  return matchTag(node, "_tag", {
    Add: () => left + right,
    Sub: () => left - right,
    Mul: () => left * right,
    Div: () => left / right,
    Mod: () => left % right,
  });
}

function evaluateComparisonFilter(
  document: GenericDocument,
  node: Extract<
    FilterNode,
    { _tag: "Eq" | "Neq" | "Gt" | "Gte" | "Lt" | "Lte" }
  >,
): boolean {
  const left = evaluateNormalizedFilter(document, node.left);
  const right = evaluateNormalizedFilter(document, node.right);

  return matchTag(node, "_tag", {
    Eq: () => compareValues(left, right) === 0,
    Neq: () => compareValues(left, right) !== 0,
    Gt: () => left! > right!,
    Gte: () => left! >= right!,
    Lt: () => left! < right!,
    Lte: () => left! <= right!,
  });
}

function evaluateNormalizedFilter(
  document: GenericDocument,
  node: FilterNode,
): Value | undefined {
  return matchTag(node, "_tag", {
    Eq: (current) => evaluateComparisonFilter(document, current),
    Neq: (current) => evaluateComparisonFilter(document, current),
    And: (current) =>
      current.children.every((child) =>
        evaluateNormalizedFilter(document, child),
      ),
    Or: (current) =>
      current.children.some((child) =>
        evaluateNormalizedFilter(document, child),
      ),
    Not: (current) => !evaluateNormalizedFilter(document, current.child),
    Gt: (current) => evaluateComparisonFilter(document, current),
    Gte: (current) => evaluateComparisonFilter(document, current),
    Lt: (current) => evaluateComparisonFilter(document, current),
    Lte: (current) => evaluateComparisonFilter(document, current),
    Add: (current) => evaluateNumericFilter(document, current),
    Sub: (current) => evaluateNumericFilter(document, current),
    Mul: (current) => evaluateNumericFilter(document, current),
    Div: (current) => evaluateNumericFilter(document, current),
    Mod: (current) => evaluateNumericFilter(document, current),
    Field: (current) => evaluateFieldPath(current.fieldPath, document),
    Literal: (current) => evaluateValue(current.value),
  });
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

function tokenizeDocument(value: Value | undefined): string[] {
  return (typeof value === "string" ? value : "")
    .split(/\s+/)
    .map((word) => word.toLowerCase());
}

function invalidRangeOperator(ctx: RangeValidationContext): never {
  throw new Error(
    `Incorrect operator used in \`withIndex\`, cannot chain \`.${ctx.filter.type.toLowerCase()}()\` ` +
      `after \`.${ctx.source.range[ctx.filterIndex - 1].type.toLowerCase()}()\``,
  );
}

function invalidRangeCompletion(ctx: RangeValidationContext): never {
  throw new Error(
    `Incorrect operator used in \`withIndex\`, cannot chain more operators after both \`.gt\` and \`.lt\` were already used, got \`${printIndexOperator(ctx.filter)}\`.`,
  );
}

function wrongFieldRangeError(expected: string, actual: string): never {
  throw new Error(
    `Incorrect field used in \`withIndex\`, expected "${expected}", got "${actual}"`,
  );
}

function sameFieldRangeError(expected: string, actual: string): never {
  throw new Error(
    `Incorrect field used in \`withIndex\`, \`.gt\` and \`.lt\` must operate on the same field, expected "${expected}", got "${actual}"`,
  );
}

function advanceRangeValidation(
  ctx: RangeValidationContext,
  expectedFieldIndex: number,
  nextState: RangeValidationState["state"],
  fieldIndexOffset: number,
  errorFactory: (
    expected: string,
    actual: string,
  ) => never = wrongFieldRangeError,
): RangeValidationState {
  const expectedField = ctx.fields[expectedFieldIndex];
  return ctx.filter.fieldPath === expectedField
    ? {
        state: nextState,
        fieldIndex: ctx.validation.fieldIndex + fieldIndexOffset,
      }
    : errorFactory(expectedField, ctx.filter.fieldPath);
}

// ---------------------------------------------------------------------------
// Filter evaluation
// ---------------------------------------------------------------------------

export function evaluateFilter(
  document: GenericDocument,
  filter: FilterJson,
): Value | undefined {
  return Fx.pipe(filter, normalizeFilter, (node) =>
    evaluateNormalizedFilter(document, node),
  );
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
  return rangeEvaluators[expr.type](result, value);
}

// ---------------------------------------------------------------------------
// Search filter evaluation
// ---------------------------------------------------------------------------

function evaluateSearchFilter(
  document: GenericDocument,
  filter: SerializedSearchFilter,
): boolean {
  const result = evaluateFieldPath(filter.fieldPath, document);
  return matchTag(filter, "type", {
    Eq: (current) => searchEvaluators.Eq(result, current),
    Search: (current) => searchEvaluators.Search(result, current),
  });
}

// ---------------------------------------------------------------------------
// Index range validation
// ---------------------------------------------------------------------------

function validateIndexRangeExpression(
  source: Source & { type: "IndexRange" },
  fields: string[],
): void {
  Fx.pipe(
    source.range,
    (range) =>
      range.reduce<RangeValidationState>(
        (validation, filter, filterIndex) => {
          const kind = rangeKindsByType[filter.type];
          const ctx: RangeValidationContext = {
            filter,
            filterIndex,
            fields,
            source,
            validation,
          };
          return rangeValidationHandlers[validation.state][kind](ctx);
        },
        { state: "eq", fieldIndex: 0 },
      ),
    () => undefined,
  );
}

function printIndexOperator(filter: SerializedRangeExpression): string {
  return `.${filter.type.toLowerCase()}(${filter.fieldPath}, ${JSON.stringify(filter.value)})`;
}

// ---------------------------------------------------------------------------
// Cosine similarity (for vector search)
// ---------------------------------------------------------------------------

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  const { dotProduct, normA, normB } = Fx.pipe(vecA, (values) =>
    values.reduce(
      (acc, value, index) => ({
        dotProduct: acc.dotProduct + value * vecB[index],
        normA: acc.normA + value * value,
        normB: acc.normB + vecB[index] * vecB[index],
      }),
      { dotProduct: 0, normA: 0, normB: 0 },
    ),
  );

  return normA === 0 || normB === 0
    ? 0
    : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// QueryEngine
// ---------------------------------------------------------------------------

export type DocumentIterator = (
  tableName: string,
  callback: (doc: StoredDocument) => void,
) => void;

export type TableCountReader = (tableName: string) => number;
export type SourceReader = (source: Source) => SourceEvaluation | null;

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
    private _countTable: TableCountReader = () => 0,
    private _readSource: SourceReader = () => null,
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
    return results === undefined
      ? (() => {
          throw new Error("Bad queryId");
        })()
      : results.length === 0
        ? { value: null, done: true }
        : { value: results.shift()!, done: false };
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

      const current = value!;
      const nextPage = isInPage ? [...page, current] : page;
      const reachedLimit = isInPage && nextPage.length >= pageSize;

      if (reachedLimit) {
        page.push(current);
        continueCursor = current._id as string;
        break;
      }

      if (isInPage) {
        page.push(current);
      }

      isInPage = isInPage || current._id === cursor;
    }

    return { page, isDone, continueCursor };
  }

  // -------------------------------------------------------------------------
  // Count
  // -------------------------------------------------------------------------

  count(tableName: string): number {
    return this._countTable(tableName);
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
    const [tableName, indexName] = tableAndIndexName.split(".");
    const results = this._collectDocs(tableName, (doc) =>
      expressions.every((expr) => evaluateRangeFilter(doc, expr)),
    );
    const vectorIndex = this._resolveVectorIndex(tableName, indexName);

    return Fx.pipe(
      results,
      (docs) =>
        docs.map((doc) => ({
          _id: doc._id as string,
          _score: cosineSimilarity(
            vector,
            doc[vectorIndex.vectorField] as number[],
          ),
        })),
      (idsAndScores) => idsAndScores.sort((a, b) => b._score - a._score),
      (idsAndScores) => idsAndScores.slice(0, limit),
    );
  }

  // -------------------------------------------------------------------------
  // Core evaluation
  // -------------------------------------------------------------------------

  private _evaluateQuery(query: SerializedQuery): Array<GenericDocument> {
    return Fx.pipe(
      query,
      ({ source, operators }) => ({
        ...this._evaluateSource(source),
        filters: this._extractFilters(operators),
        limit: this._extractLimit(operators),
      }),
      ({ results, filters, fieldPathsToSortBy, limit, order }) => ({
        results: this._applyFilters(results, filters),
        fieldPathsToSortBy,
        limit,
        order,
      }),
      ({ results, fieldPathsToSortBy, limit, order }) =>
        this._applyLimit(
          this._sortResults(results, fieldPathsToSortBy, order),
          limit,
        ),
    );
  }

  private _evaluateSource(source: Source): SourceEvaluation {
    const optimized = this._readSource(source);
    if (optimized !== null) {
      return optimized;
    }

    return matchTag(source, "type", {
      FullTableScan: (current) => this._evaluateFullTableScanSource(current),
      IndexRange: (current) => this._evaluateIndexRangeSource(current),
      Search: (current) => this._evaluateSearchSource(current),
    });
  }

  private _evaluateFullTableScanSource(
    source: Extract<Source, { type: "FullTableScan" }>,
  ): SourceEvaluation {
    return {
      results: this._collectDocs(source.tableName),
      fieldPathsToSortBy: ["_creationTime"],
      order: source.order ?? "asc",
    };
  }

  private _evaluateIndexRangeSource(
    source: Extract<Source, { type: "IndexRange" }>,
  ): SourceEvaluation {
    const [tableName, indexName] = source.indexName.split(".");
    const fields = this._resolveIndexFields(tableName, indexName);
    validateIndexRangeExpression(source, fields);

    return {
      results: this._collectDocs(tableName, (doc) =>
        source.range.every((filter) => evaluateRangeFilter(doc, filter)),
      ),
      fieldPathsToSortBy: fields,
      order: source.order ?? "asc",
    };
  }

  private _evaluateSearchSource(
    source: Extract<Source, { type: "Search" }>,
  ): SourceEvaluation {
    const [tableName] = source.indexName.split(".");
    return {
      results: this._collectDocs(tableName, (doc) =>
        source.filters.every((filter) => evaluateSearchFilter(doc, filter)),
      ),
      fieldPathsToSortBy: [],
      order: "asc",
    };
  }

  private _collectDocs(
    tableName: string,
    predicate: (doc: StoredDocument) => boolean = () => true,
  ): QueryResults {
    const results: QueryResults = [];
    this._iterateDocs(tableName, (doc) => {
      if (predicate(doc)) {
        results.push(doc);
      }
    });
    return results;
  }

  private _resolveIndexFields(tableName: string, indexName: string): string[] {
    const builtInFields =
      builtInIndexFields[indexName as keyof typeof builtInIndexFields];
    if (builtInFields) {
      return [...builtInFields];
    }

    const indexes = this._schema?.tables.get(tableName)?.indexes;
    const index = indexes?.find(
      ({ indexDescriptor }) => indexDescriptor === indexName,
    );

    return index
      ? [...index.fields, "_creationTime", "_id"]
      : (() => {
          throw new Error(
            `Cannot use index "${indexName}" for table "${tableName}" because it is not declared in the schema.`,
          );
        })();
  }

  private _resolveVectorIndex(tableName: string, indexName: string) {
    const vectorIndexes = this._schema?.tables.get(tableName)?.vectorIndexes;
    const vectorIndex = vectorIndexes?.find(
      ({ indexDescriptor }) => indexDescriptor === indexName,
    );

    return (
      vectorIndex ??
      (() => {
        throw new Error(
          `Cannot use vector index "${indexName}" for table "${tableName}" because it is not declared in the schema.`,
        );
      })()
    );
  }

  private _extractFilters(operators: QueryOperator[]): FilterJson[] {
    return operators
      .filter(operatorTypeGuards.filter)
      .map(({ filter }) => filter);
  }

  private _extractLimit(operators: QueryOperator[]): number | null {
    return operators.filter(operatorTypeGuards.limit)[0]?.limit ?? null;
  }

  private _applyFilters(
    results: QueryResults,
    filters: FilterJson[],
  ): QueryResults {
    return filters.length === 0
      ? results
      : results.filter((doc) =>
          filters.every((filter) => evaluateFilter(doc, filter)),
        );
  }

  private _sortResults(
    results: QueryResults,
    fieldPathsToSortBy: string[],
    order: "asc" | "desc",
  ): QueryResults {
    const orderMultiplier = order === "asc" ? 1 : -1;
    return [...results].sort((left, right) =>
      Fx.pipe(
        fieldPathsToSortBy,
        (fieldPaths) =>
          fieldPaths.reduce(
            (comparison, fieldPath) =>
              comparison !== 0
                ? comparison
                : compareValues(
                    evaluateFieldPath(fieldPath, left),
                    evaluateFieldPath(fieldPath, right),
                  ),
            0,
          ),
        (comparison) => comparison * orderMultiplier,
      ),
    );
  }

  private _applyLimit(
    results: QueryResults,
    limit: number | null,
  ): QueryResults {
    return limit === null ? results : results.slice(0, limit);
  }
}
