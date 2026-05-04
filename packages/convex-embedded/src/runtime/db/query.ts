/**
 * Query evaluation engine.
 *
 * Ported from convex-test. Evaluates SerializedQuery against an
 * in-memory document set: full table scans, index range scans,
 * full-text search, filters, ordering, pagination, and vector search.
 */
import type { JSONValue, Value } from "convex/values";
import { jsonToConvex } from "convex/values";

import { compareValues } from "@/runtime/db/compare";
import type { ParsedSchema } from "@/runtime/db/schema";
import {
  buildSearchIndexState,
  executeSearch,
  resolveSearchIndexDefinition,
} from "@/runtime/db/search";
import type { GenericDocument } from "@/runtime/db/types";
import type {
  FilterJson,
  QueryId,
  QueryOperator,
  SerializedQuery,
  Source,
  StoredDocument,
  VectorSearchExpression,
  SerializedRangeExpression,
} from "@/runtime/db/types";
import {
  buildVectorIndexState,
  executeVectorSearch,
  resolveVectorIndexDefinition,
} from "@/runtime/db/vector";
import { matchTag } from "@/shared/match";

export type FilterNode =
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

type ActiveQuery = {
  results: Array<GenericDocument>;
  index: number;
};

type AsyncActiveQuery = {
  resultsPromise: Promise<Array<GenericDocument>>;
  results: Array<GenericDocument> | null;
  index: number;
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
  by_table: ["table", "_creationTime", "_id"],
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
  const record = asRecord(value);
  return record !== null && "$undefined" in record;
}

const FIELD_PATH_PARTS_CACHE = new Map<string, string[]>();
const FIELD_PATH_PARTS_CACHE_MAX_SIZE = 1_000;

function getFieldPathParts(fieldPath: string): string[] {
  let cached = FIELD_PATH_PARTS_CACHE.get(fieldPath);
  if (!cached) {
    if (FIELD_PATH_PARTS_CACHE.size >= FIELD_PATH_PARTS_CACHE_MAX_SIZE) {
      FIELD_PATH_PARTS_CACHE.clear();
    }
    cached = fieldPath.split(".");
    FIELD_PATH_PARTS_CACHE.set(fieldPath, cached);
  }
  return cached;
}

/** Walk a dot-separated field path on a document. */
export function evaluateFieldPath(
  fieldPath: string,
  document: GenericDocument,
): Value | undefined {
  const pathParts = getFieldPathParts(fieldPath);
  return pathParts.reduce<Value | undefined>(
    (result, part) =>
      result !== undefined && result !== null && isSimpleObject(result)
        ? (result as Record<string, Value | undefined>)[part]
        : undefined,
    document as Value,
  );
}

/** Convert a JSONValue to a Convex value, handling $undefined. */
export function evaluateValue(value: JSONValue): Value | undefined {
  return isUndefinedMarker(value) ? undefined : jsonToConvex(value);
}

export function normalizeFilter(filter: FilterJson): FilterNode {
  const record = asRecord(filter);
  if (record === null) {
    unsupportedFilter(filter);
  }
  const normalizer =
    filterNormalizers.find(({ key }) => key in record) ??
    unsupportedFilter(filter);
  return normalizer.build(
    (record as Record<string, unknown>)[normalizer.key],
    normalizeFilter,
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

export function evaluateNormalizedFilter(
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

export function evaluateFilter(
  document: GenericDocument,
  filter: FilterJson,
): Value | undefined {
  const node = normalizeFilter(filter);
  return evaluateNormalizedFilter(document, node);
}

function evaluateRangeFilter(
  document: GenericDocument,
  expr: SerializedRangeExpression,
): boolean {
  const result = evaluateFieldPath(expr.fieldPath, document);
  const value = evaluateValue(expr.value);
  return rangeEvaluators[expr.type](result, value);
}

function validateIndexRangeExpression(
  source: Source & { type: "IndexRange" },
  fields: string[],
): void {
  source.range.reduce<RangeValidationState>(
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
  );
}

function printIndexOperator(filter: SerializedRangeExpression): string {
  return `.${filter.type.toLowerCase()}(${filter.fieldPath}, ${JSON.stringify(filter.value)})`;
}

export type DocumentIterator = (
  tableName: string,
  callback: (doc: StoredDocument) => void,
) => void;

export type TableCountReader = (tableName: string) => number;
export type AsyncTableCountReader = (tableName: string) => Promise<number>;
export type QueryReader = (
  query: SerializedQuery,
) => Array<GenericDocument> | null;
export type AsyncQueryReader = (
  query: SerializedQuery,
) => Promise<Array<GenericDocument> | null>;
export type SourceReader = (
  source: Source,
  limit?: number | null,
) => SourceEvaluation | null;
export type AsyncSourceReader = (
  source: Source,
  limit?: number | null,
) => Promise<SourceEvaluation | null>;

/**
 * Stateful query engine. Manages active streaming queries and
 * evaluates them against documents provided by a callback.
 */
export class QueryEngine {
  private _nextQueryId: QueryId = 1;
  private _queryResults: Record<QueryId, ActiveQuery> = {};
  private _asyncQueryResults: Record<QueryId, AsyncActiveQuery> = {};

  constructor(
    private _schema: ParsedSchema | null,
    private _iterateDocs: DocumentIterator,
    private _countTable: TableCountReader = () => 0,
    private _query: QueryReader = () => null,
    private _source: SourceReader = () => null,
    private _countTableAsync: AsyncTableCountReader = async (tableName) =>
      this._countTable(tableName),
    private _readQueryAsync: AsyncQueryReader = async (query) =>
      this._query(query),
    private _readSourceAsync: AsyncSourceReader = async (source, limit) =>
      this._source(source, limit),
  ) {}

  /** Update the document iterator (e.g. after a schema or docs change). */
  setDocumentIterator(iter: DocumentIterator): void {
    this._iterateDocs = iter;
  }

  startQuery(query: SerializedQuery): QueryId {
    const id = this._nextQueryId;
    const results = this._evaluateQuery(query);
    this._queryResults[id] = { results, index: 0 };
    this._nextQueryId += 1;
    return id;
  }

  startQueryAsync(query: SerializedQuery): QueryId {
    const id = this._nextQueryId;
    const resultsPromise = this._evaluateQueryAsync(query).then((results) => {
      const active = this._asyncQueryResults[id];
      if (active) {
        active.results = results;
      }
      return results;
    });
    this._asyncQueryResults[id] = { resultsPromise, results: null, index: 0 };
    this._nextQueryId += 1;
    return id;
  }

  queryNext(queryId: QueryId): {
    value: GenericDocument | null;
    done: boolean;
  } {
    const query = this._queryResults[queryId];
    return query === undefined
      ? (() => {
          throw new Error("Bad queryId");
        })()
      : query.index >= query.results.length
        ? { value: null, done: true }
        : { value: query.results[query.index++]!, done: false };
  }

  async queryNextAsync(queryId: QueryId): Promise<{
    value: GenericDocument | null;
    done: boolean;
  }> {
    const query = this._asyncQueryResults[queryId];
    if (query === undefined) {
      throw new Error("Bad queryId");
    }

    const results = query.results ?? (await query.resultsPromise);
    return query.index >= results.length
      ? { value: null, done: true }
      : { value: results[query.index++]!, done: false };
  }

  queryCleanup(queryId: QueryId): void {
    delete this._queryResults[queryId];
    delete this._asyncQueryResults[queryId];
  }

  paginate({
    query,
    cursor,
    pageSize,
  }: {
    query: SerializedQuery;
    cursor: string | null;
    pageSize: number;
  }): {
    page: GenericDocument[];
    isDone: boolean;
    continueCursor: string;
  } {
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
      const reachedLimit = isInPage && page.length + 1 >= pageSize;

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

    this.queryCleanup(queryId);

    return { page, isDone, continueCursor };
  }

  async paginateAsync({
    query,
    cursor,
    pageSize,
  }: {
    query: SerializedQuery;
    cursor: string | null;
    pageSize: number;
  }): Promise<{
    page: GenericDocument[];
    isDone: boolean;
    continueCursor: string;
  }> {
    const queryId = this.startQueryAsync(query);
    const page: GenericDocument[] = [];
    let isInPage = cursor === null;
    let isDone = false;
    let continueCursor = "_end_cursor";

    for (;;) {
      const { value, done } = await this.queryNextAsync(queryId);
      if (done) {
        isDone = true;
        continueCursor = "_end_cursor";
        break;
      }

      const current = value!;
      const reachedLimit = isInPage && page.length + 1 >= pageSize;

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

    this.queryCleanup(queryId);
    return { page, isDone, continueCursor };
  }

  count(tableName: string): number {
    return this._countTable(tableName);
  }

  async countAsync(tableName: string): Promise<number> {
    return this._countTableAsync(tableName);
  }

  vectorSearch(
    tableAndIndexName: string,
    vector: number[],
    filter: VectorSearchExpression | null,
    limit?: number,
  ): Array<{ _id: string; _score: number }> {
    const [tableName, indexName] = tableAndIndexName.split(".");
    const definition = resolveVectorIndexDefinition(
      this._schema?.tables.get(tableName)?.vectorIndexes,
      tableName,
      indexName,
    );

    return executeVectorSearch(
      buildVectorIndexState({
        docs: this._collectDocs(tableName).map((doc) => ({
          doc: doc as StoredDocument,
          identityKey: null,
        })),
        definition,
      }),
      {
        vector,
        limit,
        filter,
        activeIdentityKey: null,
      },
    );
  }

  private _evaluateQuery(query: SerializedQuery): Array<GenericDocument> {
    const optimizedQuery = this._query(query);
    if (optimizedQuery !== null) {
      return optimizedQuery;
    }

    const { filters, limit } = this._extractQueryOperators(query.operators);
    const source = this._evaluateSource(
      query.source,
      filters.length === 0 ? limit : null,
    );
    const filteredResults = this._applyFilters(source.results, filters);
    const sortedResults = this._sortResults(
      filteredResults,
      source.fieldPathsToSortBy,
      source.order,
    );
    return this._applyLimit(sortedResults, limit);
  }

  private async _evaluateQueryAsync(
    query: SerializedQuery,
  ): Promise<Array<GenericDocument>> {
    const optimizedQuery = await this._readQueryAsync(query);
    if (optimizedQuery !== null) {
      return optimizedQuery;
    }

    const { filters, limit } = this._extractQueryOperators(query.operators);
    const source = await this._evaluateSourceAsync(
      query.source,
      filters.length === 0 ? limit : null,
    );
    const filteredResults = this._applyFilters(source.results, filters);
    const sortedResults = this._sortResults(
      filteredResults,
      source.fieldPathsToSortBy,
      source.order,
    );
    return this._applyLimit(sortedResults, limit);
  }

  private _evaluateSource(
    source: Source,
    limit: number | null = null,
  ): SourceEvaluation {
    const optimized = this._source(source, limit);
    if (optimized !== null) {
      return optimized;
    }

    return matchTag(source, "type", {
      FullTableScan: (current) => this._evaluateFullTableScanSource(current),
      IndexRange: (current) => this._evaluateIndexRangeSource(current),
      Search: (current) => this._evaluateSearchSource(current, limit),
    });
  }

  private async _evaluateSourceAsync(
    source: Source,
    limit: number | null = null,
  ): Promise<SourceEvaluation> {
    const optimized = await this._readSourceAsync(source, limit);
    if (optimized !== null) {
      return optimized;
    }

    return this._evaluateSource(source, limit);
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
    const rangePredicate = this._buildRangePredicate(source.range);

    return {
      results: this._collectDocs(tableName, rangePredicate),
      fieldPathsToSortBy: fields,
      order: source.order ?? "asc",
    };
  }

  private _evaluateSearchSource(
    source: Extract<Source, { type: "Search" }>,
    limit: number | null,
  ): SourceEvaluation {
    const [tableName, indexName] = source.indexName.split(".");
    const definition = resolveSearchIndexDefinition(
      this._schema?.tables.get(tableName)?.searchIndexes,
      tableName,
      indexName,
    );
    const docs = this._collectDocs(tableName);
    return {
      results: executeSearch(
        buildSearchIndexState({
          docs: docs.map((doc) => ({
            doc: doc as StoredDocument,
            identityKey: null,
          })),
          definition,
        }),
        { source, activeIdentityKey: null, limit: limit ?? undefined },
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

  private _extractQueryOperators(operators: QueryOperator[]): {
    filters: FilterNode[];
    limit: number | null;
  } {
    const filters: FilterNode[] = [];
    let limit: number | null = null;

    for (const operator of operators) {
      if (operatorTypeGuards.filter(operator)) {
        filters.push(normalizeFilter(operator.filter));
        continue;
      }
      if (limit === null && operatorTypeGuards.limit(operator)) {
        limit = operator.limit;
      }
    }

    return { filters, limit };
  }

  private _applyFilters(
    results: QueryResults,
    filters: FilterNode[],
  ): QueryResults {
    return filters.length === 0
      ? results
      : results.filter((doc) =>
          filters.every((filter) => evaluateNormalizedFilter(doc, filter)),
        );
  }

  private _sortResults(
    results: QueryResults,
    fieldPathsToSortBy: string[],
    order: "asc" | "desc",
  ): QueryResults {
    if (results.length < 2 || fieldPathsToSortBy.length === 0) {
      return results;
    }

    const orderMultiplier = order === "asc" ? 1 : -1;
    return results.sort((left, right) => {
      const comparison = fieldPathsToSortBy.reduce(
        (acc, fieldPath) =>
          acc !== 0
            ? acc
            : compareValues(
                evaluateFieldPath(fieldPath, left),
                evaluateFieldPath(fieldPath, right),
              ),
        0,
      );
      return comparison * orderMultiplier;
    });
  }

  private _applyLimit(
    results: QueryResults,
    limit: number | null,
  ): QueryResults {
    return limit === null ? results : results.slice(0, limit);
  }

  private _buildRangePredicate(
    range: ReadonlyArray<SerializedRangeExpression>,
  ): (doc: StoredDocument) => boolean {
    if (range.length === 0) {
      return () => true;
    }

    return (doc) => {
      for (const filter of range) {
        if (!evaluateRangeFilter(doc, filter)) {
          return false;
        }
      }
      return true;
    };
  }
}
