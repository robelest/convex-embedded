/**
 * Query evaluation engine.
 *
 * Ported from convex-test. Evaluates SerializedQuery against an
 * in-memory document set: full table scans, index range scans,
 * full-text search, filters, ordering, pagination, and vector search.
 */
import type { JSONValue, Value } from "convex/values";
import { convexToJson, jsonToConvex } from "convex/values";

import { compareValues } from "@/runtime/db/compare";
import {
  asRecord,
  evaluateFieldPath,
  evaluateValue,
} from "@/runtime/db/fieldpath";
import type { ParsedSchema } from "@/runtime/db/schema";
import {
  buildSearchIndexState,
  executeSearch,
  getSearchIndexDefinition,
} from "@/runtime/db/search";
import type { GenericDocument } from "@/runtime/db/types";
import type {
  FilterJson,
  QueryId,
  QueryOperator,
  SeekBound,
  SerializedQuery,
  Source,
  StoredDocument,
  VectorSearchExpression,
  SerializedRangeExpression,
} from "@/runtime/db/types";
import {
  buildVectorIndexState,
  executeVectorSearch,
  getVectorIndexDefinition,
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

type OrderKey = {
  seekFields: string[];
  order: "asc" | "desc";
};

const CURSOR_PREFIX = "ck1:";

const SPLIT_RECOMMENDED_FACTOR = 2;
const SPLIT_REQUIRED_FACTOR = 4;

export type PaginateResult = {
  page: GenericDocument[];
  isDone: boolean;
  continueCursor: string;
  splitCursor: string | null;
  pageStatus: "SplitRecommended" | "SplitRequired" | null;
};

type ReadBudget = {
  maximumRowsRead: number | null;
  maximumBytesRead: number | null;
};

function documentByteSize(doc: GenericDocument): number {
  let json: string;
  try {
    json = JSON.stringify(convexToJson(doc as Value));
  } catch {
    return 0;
  }
  let bytes = 0;
  for (let i = 0; i < json.length; i += 1) {
    const code = json.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function applyByteBudget(
  results: QueryResults,
  maximumBytesRead: number | null,
): { results: QueryResults; bytesExceeded: boolean } {
  if (maximumBytesRead === null) {
    return { results, bytesExceeded: false };
  }
  let total = 0;
  for (let i = 0; i < results.length; i += 1) {
    total += documentByteSize(results[i]!);
    if (total > maximumBytesRead) {
      return { results: results.slice(0, i + 1), bytesExceeded: true };
    }
  }
  return { results, bytesExceeded: false };
}

type SourceEvaluation = {
  results: QueryResults;
  fieldPathsToSortBy: readonly string[];
  order: "asc" | "desc";
  presorted?: boolean;
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
  fields: readonly string[];
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

const resolvedFieldsCache = new Map<string, readonly string[]>();

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

function unsupportedFilter(filter: FilterJson): never {
  throw new Error(`not implemented: ${JSON.stringify(filter)}`);
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
    Gt: () => compareValues(left, right) > 0,
    Gte: () => compareValues(left, right) >= 0,
    Lt: () => compareValues(left, right) < 0,
    Lte: () => compareValues(left, right) <= 0,
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
      current.children.every(
        (child) => evaluateNormalizedFilter(document, child) === true,
      ),
    Or: (current) =>
      current.children.some(
        (child) => evaluateNormalizedFilter(document, child) === true,
      ),
    Not: (current) =>
      evaluateNormalizedFilter(document, current.child) !== true,
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
      `after \`.${ctx.source.range[ctx.filterIndex - 1]!.type.toLowerCase()}()\``,
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
  const expectedField = ctx.fields[expectedFieldIndex]!;
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
  fields: readonly string[],
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
  seek?: SeekBound,
) => SourceEvaluation | null;
export type AsyncSourceReader = (
  source: Source,
  limit?: number | null,
  seek?: SeekBound,
) => Promise<SourceEvaluation | null>;
export type TableVersionReader = (tableName: string) => number | null;

type SearchIndexCacheEntry = {
  version: number;
  state: ReturnType<typeof buildSearchIndexState>;
};

type VectorIndexCacheEntry = {
  version: number;
  state: ReturnType<typeof buildVectorIndexState>;
};

/**
 * Stateful query engine. Manages active streaming queries and
 * evaluates them against documents provided by a callback.
 */
export interface QueryEngine {
  startQuery(query: SerializedQuery): QueryId;
  startQueryAsync(query: SerializedQuery): QueryId;
  queryNext(queryId: QueryId): { value: GenericDocument | null; done: boolean };
  queryNextAsync(
    queryId: QueryId,
  ): Promise<{ value: GenericDocument | null; done: boolean }>;
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
  vectorSearch(
    tableAndIndexName: string,
    vector: number[],
    filter: VectorSearchExpression | null,
    limit?: number,
  ): Array<{ _id: string; _score: number }>;
}

export function createQueryEngine(
  schema: ParsedSchema | null,
  iterateDocs: DocumentIterator,
  countTable: TableCountReader = () => 0,
  query: QueryReader = () => null,
  source: SourceReader = () => null,
  countTableAsync?: AsyncTableCountReader,
  readQueryAsync?: AsyncQueryReader,
  readSourceAsync?: AsyncSourceReader,
  tableVersion: TableVersionReader = () => null,
): QueryEngine {
  let nextQueryId: QueryId = 1;
  const queryResults: Record<QueryId, ActiveQuery> = {};
  const asyncQueryResults: Record<QueryId, AsyncActiveQuery> = {};
  const searchIndexCache = new Map<string, SearchIndexCacheEntry>();
  const vectorIndexCache = new Map<string, VectorIndexCacheEntry>();

  const countTableAsyncFn: AsyncTableCountReader =
    countTableAsync ?? (async (tableName) => countTable(tableName));
  const readQueryAsyncFn: AsyncQueryReader =
    readQueryAsync ?? (async (q) => query(q));
  const readSourceAsyncFn: AsyncSourceReader =
    readSourceAsync ?? (async (s, l, k) => source(s, l, k));

  function evaluateQuery(q: SerializedQuery): Array<GenericDocument> {
    const optimizedQuery = query(q);
    if (optimizedQuery !== null) {
      return optimizedQuery;
    }

    const { filters, limit } = extractQueryOperators(q.operators);

    if (limit !== null && filters.length > 0) {
      const probe = evaluateSource(q.source, limit);
      if (probe.presorted === true) {
        return boundedFilteredRead(
          (readLimit) => evaluateSource(q.source, readLimit),
          probe,
          filters,
          limit,
        );
      }
      return finalizeSource(probe, filters, limit);
    }

    const src = evaluateSource(q.source, filters.length === 0 ? limit : null);
    return finalizeSource(src, filters, limit);
  }

  async function evaluateQueryAsync(
    query: SerializedQuery,
  ): Promise<Array<GenericDocument>> {
    const optimizedQuery = await readQueryAsyncFn(query);
    if (optimizedQuery !== null) {
      return optimizedQuery;
    }

    const { filters, limit } = extractQueryOperators(query.operators);

    if (limit !== null && filters.length > 0) {
      const probe = await evaluateSourceAsync(query.source, limit);
      if (probe.presorted === true) {
        return boundedFilteredReadAsync(
          (readLimit) => evaluateSourceAsync(query.source, readLimit),
          probe,
          filters,
          limit,
        );
      }
      return finalizeSource(probe, filters, limit);
    }

    const src = await evaluateSourceAsync(
      query.source,
      filters.length === 0 ? limit : null,
    );
    return finalizeSource(src, filters, limit);
  }

  function finalizeSource(
    src: SourceEvaluation,
    filters: FilterNode[],
    limit: number | null,
  ): Array<GenericDocument> {
    const filtered = applyFilters(src.results, filters);
    const sorted =
      src.presorted === true
        ? filtered
        : sortResults(filtered, src.fieldPathsToSortBy, src.order);
    return applyLimit(sorted, limit);
  }

  function boundedFilteredRead(
    read: (readLimit: number) => SourceEvaluation,
    firstRead: SourceEvaluation,
    filters: FilterNode[],
    limit: number,
  ): Array<GenericDocument> {
    let readLimit = limit;
    let src = firstRead;
    for (;;) {
      const survivors = applyFilters(src.results, filters);
      const exhausted = src.results.length < readLimit;
      if (survivors.length >= limit || exhausted) {
        return survivors.slice(0, limit);
      }
      readLimit *= 2;
      src = read(readLimit);
    }
  }

  async function boundedFilteredReadAsync(
    read: (readLimit: number) => Promise<SourceEvaluation>,
    firstRead: SourceEvaluation,
    filters: FilterNode[],
    limit: number,
  ): Promise<Array<GenericDocument>> {
    let readLimit = limit;
    let src = firstRead;
    for (;;) {
      const survivors = applyFilters(src.results, filters);
      const exhausted = src.results.length < readLimit;
      if (survivors.length >= limit || exhausted) {
        return survivors.slice(0, limit);
      }
      readLimit *= 2;
      src = await read(readLimit);
    }
  }

  function evaluateSource(
    src: Source,
    limit: number | null = null,
    seek?: SeekBound,
  ): SourceEvaluation {
    const optimized = source(src, limit, seek);
    if (optimized !== null) {
      return optimized;
    }

    return matchTag(src, "type", {
      FullTableScan: (current) => evaluateFullTableScanSource(current),
      IndexRange: (current) => evaluateIndexRangeSource(current),
      Search: (current) => evaluateSearchSource(current, limit),
    });
  }

  async function evaluateSourceAsync(
    src: Source,
    limit: number | null = null,
    seek?: SeekBound,
  ): Promise<SourceEvaluation> {
    const optimized = await readSourceAsyncFn(src, limit, seek);
    if (optimized !== null) {
      return optimized;
    }

    return evaluateSource(src, limit, seek);
  }

  function evaluateFullTableScanSource(
    src: Extract<Source, { type: "FullTableScan" }>,
  ): SourceEvaluation {
    return {
      results: readDocs(src.tableName),
      fieldPathsToSortBy: ["_creationTime", "_id"],
      order: src.order ?? "asc",
    };
  }

  function evaluateIndexRangeSource(
    src: Extract<Source, { type: "IndexRange" }>,
  ): SourceEvaluation {
    const [tableName, indexName] = src.indexName.split(".") as [
      string,
      string,
    ];
    const fields = resolveIndexFields(tableName, indexName);
    validateIndexRangeExpression(src, fields);
    const rangePredicate = buildRangePredicate(src.range);

    return {
      results: readDocs(tableName, rangePredicate),
      fieldPathsToSortBy: fields,
      order: src.order ?? "asc",
    };
  }

  function evaluateSearchSource(
    src: Extract<Source, { type: "Search" }>,
    limit: number | null,
  ): SourceEvaluation {
    const [tableName, indexName] = src.indexName.split(".") as [
      string,
      string,
    ];
    const definition = getSearchIndexDefinition(
      schema?.tables.get(tableName)?.searchIndexes,
      tableName,
      indexName,
    );
    const cacheKey = `${tableName}.${indexName}`;
    const version = tableVersion(tableName);
    const cached =
      version === null ? undefined : searchIndexCache.get(cacheKey);
    let state: ReturnType<typeof buildSearchIndexState>;
    if (cached !== undefined && cached.version === version) {
      state = cached.state;
    } else {
      state = buildSearchIndexState({
        docs: readDocs(tableName).map((doc) => ({
          doc: doc as StoredDocument,
          identityKey: null,
        })),
        definition,
      });
      if (version !== null) {
        searchIndexCache.set(cacheKey, { version, state });
      }
    }
    return {
      results: executeSearch(state, {
        source: src,
        activeIdentityKey: null,
        limit: limit ?? undefined,
      }),
      fieldPathsToSortBy: [],
      order: "asc",
    };
  }

  function readDocs(
    tableName: string,
    predicate: (doc: StoredDocument) => boolean = () => true,
  ): QueryResults {
    const results: QueryResults = [];
    iterateDocs(tableName, (doc) => {
      if (predicate(doc)) {
        results.push(doc);
      }
    });
    return results;
  }

  function resolveIndexFields(
    tableName: string,
    indexName: string,
  ): readonly string[] {
    const builtInFields =
      builtInIndexFields[indexName as keyof typeof builtInIndexFields];
    if (builtInFields) {
      return builtInFields;
    }

    const cacheKey = `${tableName}:${indexName}`;
    const cached = resolvedFieldsCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const indexes = schema?.tables.get(tableName)?.indexes;
    const index = indexes?.find(
      ({ indexDescriptor }) => indexDescriptor === indexName,
    );

    if (!index) {
      throw new Error(
        `Cannot use index "${indexName}" for table "${tableName}" because it is not declared in the schema.`,
      );
    }
    const resolved = Object.freeze([
      ...index.fields,
      "_creationTime",
      "_id",
    ]) as readonly string[];
    resolvedFieldsCache.set(cacheKey, resolved);
    return resolved;
  }

  function extractQueryOperators(operators: QueryOperator[]): {
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

  function applyFilters(
    results: QueryResults,
    filters: FilterNode[],
  ): QueryResults {
    return filters.length === 0
      ? results
      : results.filter((doc) =>
          filters.every((filter) => evaluateNormalizedFilter(doc, filter)),
        );
  }

  function sortResults(
    results: QueryResults,
    fieldPathsToSortBy: readonly string[],
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

  function applyLimit(
    results: QueryResults,
    limit: number | null,
  ): QueryResults {
    return limit === null ? results : results.slice(0, limit);
  }

  function buildRangePredicate(
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

  function resolveOrderKey(query: SerializedQuery): OrderKey | null {
    const src = query.source;
    if (src.type === "Search") {
      return null;
    }
    if (src.type === "FullTableScan") {
      return {
        seekFields: ["_creationTime", "_id"],
        order: src.order ?? "asc",
      };
    }
    const [tableName, indexName] = src.indexName.split(".") as [
      string,
      string,
    ];
    const fields = resolveIndexFields(tableName, indexName);
    let pinned: Set<string> | null = null;
    for (const expr of src.range) {
      if (expr.type === "Eq") {
        if (pinned === null) pinned = new Set();
        pinned.add(expr.fieldPath);
      }
    }
    const seekFields: string[] = [];
    let prefix = true;
    for (const field of fields) {
      if (prefix && pinned !== null && pinned.has(field)) {
        continue;
      }
      prefix = false;
      seekFields.push(field);
    }
    if (
      seekFields.length === 0 ||
      seekFields[seekFields.length - 1] !== "_id"
    ) {
      return null;
    }
    return { seekFields, order: src.order ?? "asc" };
  }

  function buildSeek(
    orderKey: OrderKey,
    cursor: Array<Value | undefined>,
  ): SeekBound {
    return {
      field: orderKey.seekFields[0]!,
      value: convexToJson(cursor[0] ?? null) as JSONValue,
      inclusive: true,
      direction: orderKey.order,
    };
  }

  function encodeCursor(orderKey: OrderKey, doc: GenericDocument): string {
    const values = orderKey.seekFields.map((field) =>
      convexToJson((evaluateFieldPath(field, doc) ?? null) as Value),
    );
    return `${CURSOR_PREFIX}${JSON.stringify(values)}`;
  }

  let lastDecodedCursor: string | null = null;
  let lastDecodedValue: Array<Value | undefined> | null = null;

  function decodeCursor(cursor: string): Array<Value | undefined> | null {
    if (!cursor.startsWith(CURSOR_PREFIX)) {
      return null;
    }
    if (cursor === lastDecodedCursor) {
      return lastDecodedValue;
    }
    const parsed = JSON.parse(
      cursor.slice(CURSOR_PREFIX.length),
    ) as JSONValue[];
    const value = parsed.map((v) => jsonToConvex(v));
    lastDecodedCursor = cursor;
    lastDecodedValue = value;
    return value;
  }

  function compareOrderKey(
    orderKey: OrderKey,
    doc: GenericDocument,
    cursor: Array<Value | undefined>,
  ): number {
    const multiplier = orderKey.order === "asc" ? 1 : -1;
    for (let index = 0; index < orderKey.seekFields.length; index += 1) {
      const field = orderKey.seekFields[index]!;
      const comparison = compareValues(
        evaluateFieldPath(field, doc),
        cursor[index],
      );
      if (comparison !== 0) {
        return comparison * multiplier;
      }
    }
    return 0;
  }

  function budgetBoundedPage(
    orderKey: OrderKey,
    candidates: GenericDocument[],
    target: number,
    options: { continueCursor: string | null },
  ): PaginateResult {
    const page =
      target > 0 && candidates.length > target
        ? candidates.slice(0, target)
        : candidates;
    const last = page.at(-1) ?? null;
    const continueCursor =
      options.continueCursor ??
      (last === null ? "_end_cursor" : encodeCursor(orderKey, last));
    const split = pageSplit(orderKey, page, target);
    return {
      page,
      isDone: false,
      continueCursor,
      splitCursor: split.splitCursor,
      pageStatus: "SplitRequired",
    };
  }

  function pageSplit(
    orderKey: OrderKey,
    page: GenericDocument[],
    target: number,
  ): { splitCursor: string | null; pageStatus: PaginateResult["pageStatus"] } {
    if (page.length < 2 || target <= 0) {
      return { splitCursor: null, pageStatus: null };
    }
    const midIndex = Math.floor((page.length - 1) / 2);
    const midpoint = page[midIndex] ?? null;
    const splitCursor =
      midpoint === null ? null : encodeCursor(orderKey, midpoint);
    let pageStatus: PaginateResult["pageStatus"] = null;
    if (page.length > target * SPLIT_REQUIRED_FACTOR) {
      pageStatus = "SplitRequired";
    } else if (page.length > target * SPLIT_RECOMMENDED_FACTOR) {
      pageStatus = "SplitRecommended";
    }
    return { splitCursor, pageStatus };
  }

  function filterDocsAfter(
    orderKey: OrderKey,
    docs: readonly GenericDocument[],
    decoded: Array<Value | undefined>,
  ): GenericDocument[] {
    const out: GenericDocument[] = [];
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]!;
      if (compareOrderKey(orderKey, doc, decoded) > 0) {
        out.push(doc);
      }
    }
    return out;
  }

  function filterDocsBeforeOrEq(
    orderKey: OrderKey,
    docs: readonly GenericDocument[],
    endDecoded: Array<Value | undefined>,
  ): GenericDocument[] {
    const out: GenericDocument[] = [];
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]!;
      if (compareOrderKey(orderKey, doc, endDecoded) <= 0) {
        out.push(doc);
      }
    }
    return out;
  }

  async function paginateSeekAsync({
    query,
    cursor,
    endCursor,
    pageSize,
    orderKey,
    budget,
  }: {
    query: SerializedQuery;
    cursor: string | null;
    endCursor: string | null;
    pageSize: number;
    orderKey: OrderKey;
    budget: ReadBudget;
  }): Promise<PaginateResult> {
    const { filters } = extractQueryOperators(query.operators);
    const decoded = cursor === null ? null : decodeCursor(cursor);
    const endDecoded =
      endCursor === null || endCursor === "_end_cursor"
        ? null
        : decodeCursor(endCursor);
    const pinnedEnd = endCursor !== null;
    const seek = decoded === null ? undefined : buildSeek(orderKey, decoded);
    const target = pageSize <= 0 ? 0 : pageSize;
    const rowCap = budget.maximumRowsRead;

    let readLimit = target + 1 + (filters.length > 0 ? target : 0);
    for (;;) {
      const unboundedRead = pinnedEnd && endDecoded === null;
      const cappedLimit =
        rowCap === null
          ? readLimit
          : unboundedRead
            ? rowCap
            : Math.min(readLimit, rowCap);
      const effectiveLimit =
        unboundedRead && rowCap === null ? null : cappedLimit;
      const src = await evaluateSourceAsync(
        query.source,
        effectiveLimit,
        seek,
      );
      const rowsExceeded = rowCap !== null && src.results.length >= rowCap;
      const { results: budgetedRaw, bytesExceeded } = applyByteBudget(
        src.results,
        budget.maximumBytesRead,
      );
      const budgetHit = rowsExceeded || bytesExceeded;
      const ordered = sortResults(
        budgetedRaw,
        src.fieldPathsToSortBy,
        src.order,
      );
      const filtered = applyFilters(ordered, filters);
      const afterStart =
        decoded === null
          ? filtered
          : filterDocsAfter(orderKey, filtered, decoded);
      const exhausted = src.results.length < cappedLimit;

      if (pinnedEnd) {
        if (endDecoded === null) {
          if (budgetHit) {
            return budgetBoundedPage(orderKey, afterStart, target, {
              continueCursor: null,
            });
          }
          return {
            page: afterStart,
            isDone: true,
            continueCursor: "_end_cursor",
            ...pageSplit(orderKey, afterStart, target),
          };
        }
        const inRange = filterDocsBeforeOrEq(
          orderKey,
          afterStart,
          endDecoded,
        );
        const sawBeyondEnd = inRange.length < afterStart.length;
        if (sawBeyondEnd || exhausted) {
          return {
            page: inRange,
            isDone: false,
            continueCursor: endCursor as string,
            ...pageSplit(orderKey, inRange, target),
          };
        }
        if (budgetHit) {
          return budgetBoundedPage(orderKey, inRange, target, {
            continueCursor: endCursor as string,
          });
        }
        readLimit *= 2;
        continue;
      }

      if (afterStart.length > target) {
        const page = afterStart.slice(0, target);
        const last = page.at(-1) ?? null;
        const continueCursor =
          last === null ? "_end_cursor" : encodeCursor(orderKey, last);
        return {
          page,
          isDone: false,
          continueCursor,
          ...pageSplit(orderKey, page, target),
        };
      }

      if (exhausted) {
        const page = afterStart.slice(0, target);
        return {
          page,
          isDone: true,
          continueCursor: "_end_cursor",
          ...pageSplit(orderKey, page, target),
        };
      }

      if (budgetHit) {
        return budgetBoundedPage(orderKey, afterStart, target, {
          continueCursor: null,
        });
      }

      readLimit *= 2;
    }
  }

  async function paginateLinearAsync({
    query,
    cursor,
    endCursor,
    pageSize,
    budget,
  }: {
    query: SerializedQuery;
    cursor: string | null;
    endCursor: string | null;
    pageSize: number;
    budget: ReadBudget;
  }): Promise<PaginateResult> {
    const pinnedEnd = endCursor !== null && endCursor !== "_end_cursor";
    const queryId = api.startQueryAsync(query);
    const page: GenericDocument[] = [];
    let isInPage = cursor === null;
    let isDone = false;
    let continueCursor = "_end_cursor";
    let rowsRead = 0;
    let bytesRead = 0;
    let budgetBounded = false;

    for (;;) {
      const { value, done } = await api.queryNextAsync(queryId);
      if (done) {
        isDone = true;
        continueCursor = "_end_cursor";
        break;
      }

      const current = value!;
      rowsRead += 1;
      if (budget.maximumBytesRead !== null) {
        bytesRead += documentByteSize(current);
      }

      if (pinnedEnd && isInPage) {
        page.push(current);
        if (current._id === endCursor) {
          continueCursor = endCursor;
          break;
        }
        isInPage = true;
      } else {
        const reachedLimit = isInPage && page.length + 1 >= pageSize;
        if (!pinnedEnd && reachedLimit) {
          page.push(current);
          continueCursor = current._id as string;
          break;
        }
        if (isInPage) {
          page.push(current);
        }
        isInPage = isInPage || current._id === cursor;
      }

      const rowsExceeded =
        budget.maximumRowsRead !== null && rowsRead >= budget.maximumRowsRead;
      const bytesExceeded =
        budget.maximumBytesRead !== null && bytesRead > budget.maximumBytesRead;
      if (isInPage && (rowsExceeded || bytesExceeded)) {
        budgetBounded = true;
        continueCursor =
          page.length > 0
            ? (page[page.length - 1]!._id as string)
            : "_end_cursor";
        break;
      }
    }

    api.queryCleanup(queryId);

    if (cursor !== null && !isInPage && page.length === 0) {
      return paginateLinearAsync({
        query,
        cursor: null,
        endCursor,
        pageSize,
        budget,
      });
    }

    if (budgetBounded) {
      return {
        page,
        isDone: false,
        continueCursor,
        splitCursor: null,
        pageStatus: "SplitRequired",
      };
    }

    return {
      page,
      isDone: pinnedEnd ? false : isDone,
      continueCursor,
      splitCursor: null,
      pageStatus: null,
    };
  }

  const api: QueryEngine = {
    startQuery(query) {
      const id = nextQueryId;
      const results = evaluateQuery(query);
      queryResults[id] = { results, index: 0 };
      nextQueryId += 1;
      return id;
    },

    startQueryAsync(query) {
      const id = nextQueryId;
      const resultsPromise = evaluateQueryAsync(query).then((results) => {
        const active = asyncQueryResults[id];
        if (active) {
          active.results = results;
        }
        return results;
      });
      asyncQueryResults[id] = { resultsPromise, results: null, index: 0 };
      nextQueryId += 1;
      return id;
    },

    queryNext(queryId) {
      const query = queryResults[queryId];
      return query === undefined
        ? (() => {
            throw new Error("Bad queryId");
          })()
        : query.index >= query.results.length
          ? { value: null, done: true }
          : { value: query.results[query.index++]!, done: false };
    },

    async queryNextAsync(queryId) {
      const query = asyncQueryResults[queryId];
      if (query === undefined) {
        throw new Error("Bad queryId");
      }

      const results = query.results ?? (await query.resultsPromise);
      return query.index >= results.length
        ? { value: null, done: true }
        : { value: results[query.index++]!, done: false };
    },

    queryCleanup(queryId) {
      delete queryResults[queryId];
      delete asyncQueryResults[queryId];
    },

    async paginateAsync({
      query,
      cursor,
      endCursor,
      pageSize,
      maximumRowsRead,
      maximumBytesRead,
    }) {
      const budget: ReadBudget = {
        maximumRowsRead: maximumRowsRead ?? null,
        maximumBytesRead: maximumBytesRead ?? null,
      };
      const orderKey = resolveOrderKey(query);
      if (orderKey === null) {
        return paginateLinearAsync({
          query,
          cursor,
          endCursor: endCursor ?? null,
          pageSize,
          budget,
        });
      }
      return paginateSeekAsync({
        query,
        cursor,
        endCursor: endCursor ?? null,
        pageSize,
        orderKey,
        budget,
      });
    },

    count(tableName) {
      return countTable(tableName);
    },

    async countAsync(tableName) {
      return countTableAsyncFn(tableName);
    },

    vectorSearch(tableAndIndexName, vector, filter, limit) {
      const [tableName, indexName] = tableAndIndexName.split(".") as [
        string,
        string,
      ];
      const definition = getVectorIndexDefinition(
        schema?.tables.get(tableName)?.vectorIndexes,
        tableName,
        indexName,
      );

      const cacheKey = `${tableName}.${indexName}`;
      const version = tableVersion(tableName);
      const cached =
        version === null ? undefined : vectorIndexCache.get(cacheKey);
      let state: ReturnType<typeof buildVectorIndexState>;
      if (cached !== undefined && cached.version === version) {
        state = cached.state;
      } else {
        state = buildVectorIndexState({
          docs: readDocs(tableName).map((doc) => ({
            doc: doc as StoredDocument,
            identityKey: null,
          })),
          definition,
        });
        if (version !== null) {
          vectorIndexCache.set(cacheKey, { version, state });
        }
      }

      return executeVectorSearch(state, {
        vector,
        limit,
        filter,
        activeIdentityKey: null,
      });
    },
  };

  return api;
}
