import { convexToJson } from "convex/values";
import type { JSONValue, Value } from "convex/values";

import { compareValues } from "@/runtime/db/compare";
import { evaluateFieldPath } from "@/runtime/db/query";
import type { VectorIndexDefinition } from "@/runtime/db/schema";
import type {
  StoredDocument,
  VectorSearchExpression,
} from "@/runtime/db/types";

type VectorDocState = {
  _id: string;
  vector: Float32Array;
  identityKey: string | null;
  bucketKeys: Map<string, string>;
};

export type VectorIndexState = {
  definition: VectorIndexDefinition;
  docs: Map<string, VectorDocState>;
  filterBuckets: Map<string, Map<string, Set<string>>>;
  dimensions: number;
};

export type VectorOverlayState = {
  state: VectorIndexState;
  shadowedIds: Set<string>;
};

type VectorFilterClause = {
  fieldPath: string;
  bucketKey: string;
};

type VectorFilterPlan =
  | { kind: "all" }
  | { kind: "or"; clauses: VectorFilterClause[] };

type VectorSearchResult = {
  _id: string;
  _score: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") {
    return null;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype
    ? (value as Record<string, unknown>)
    : null;
}

function valueToBucketKey(value: Value | undefined): string {
  return value === undefined
    ? JSON.stringify({ $undefined: true })
    : JSON.stringify(convexToJson(value));
}

function vectorFilterValueToBucketKey(value: JSONValue): string {
  return JSON.stringify(value);
}

function normalizeVector(values: number[]): {
  vector: Float32Array;
  isZero: boolean;
} {
  const normalized = new Float32Array(values.length);
  let norm = 0;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    normalized[index] = value;
    norm += value * value;
  }

  if (norm === 0) {
    return { vector: normalized, isZero: true };
  }

  const magnitude = Math.sqrt(norm);
  for (let index = 0; index < normalized.length; index += 1) {
    normalized[index] /= magnitude;
  }

  return { vector: normalized, isZero: false };
}

function normalizeStoredVector(
  value: Value | undefined,
  dimensions: number,
): Float32Array | null {
  if (!Array.isArray(value) || value.length !== dimensions) {
    return null;
  }

  if (value.some((entry) => typeof entry !== "number")) {
    return null;
  }

  return normalizeVector(value as number[]).vector;
}

function normalizeQueryVector(
  vector: number[],
  dimensions: number,
): { vector: Float32Array; isZero: boolean } {
  if (!Array.isArray(vector)) {
    throw new Error("`vector` must be an array in vectorSearch");
  }
  if (vector.length !== dimensions) {
    throw new Error(
      `Vector search query vector must have exactly ${dimensions} dimensions, got ${vector.length}.`,
    );
  }
  if (vector.some((entry) => typeof entry !== "number")) {
    throw new Error("Vector search query vector must contain only numbers.");
  }

  return normalizeVector(vector);
}

function normalizeLimit(limit: number | undefined): number {
  const resolved = limit ?? 10;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 256) {
    throw new Error(
      "`limit` must be an integer between 1 and 256 in vectorSearch",
    );
  }
  return resolved;
}

function parseEqClause(
  expression: VectorSearchExpression,
  definition: VectorIndexDefinition,
): VectorFilterClause {
  const record = asRecord(expression);
  const operands = record?.$eq;
  if (!Array.isArray(operands) || operands.length !== 2) {
    throw new Error(
      "Vector search filter only supports q.eq(...) and q.or(...).",
    );
  }

  const [left, right] = operands as [
    VectorSearchExpression,
    VectorSearchExpression,
  ];
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);

  const fieldPath =
    typeof leftRecord?.$field === "string"
      ? leftRecord.$field
      : typeof rightRecord?.$field === "string"
        ? rightRecord.$field
        : null;
  const leftHasLiteral = "$literal" in (leftRecord ?? {});
  const rightHasLiteral = "$literal" in (rightRecord ?? {});
  const literalValue = leftHasLiteral
    ? (leftRecord!.$literal as JSONValue)
    : rightHasLiteral
      ? (rightRecord!.$literal as JSONValue)
      : undefined;

  if (fieldPath === null || (!leftHasLiteral && !rightHasLiteral)) {
    throw new Error(
      "Vector search filter only supports equality comparisons against literals.",
    );
  }
  if (!definition.filterFields.includes(fieldPath)) {
    throw new Error(
      `Vector index "${definition.indexDescriptor}" does not allow equality filter on "${fieldPath}".`,
    );
  }

  return {
    fieldPath,
    bucketKey: vectorFilterValueToBucketKey(literalValue as JSONValue),
  };
}

function collectFilterClauses(
  expression: VectorSearchExpression,
  definition: VectorIndexDefinition,
): VectorFilterClause[] {
  const record = asRecord(expression);
  if (!record) {
    throw new Error(
      "Vector search filter only supports q.eq(...) and q.or(...).",
    );
  }

  if ("$eq" in record) {
    return [parseEqClause(expression, definition)];
  }

  if ("$or" in record) {
    const children = record.$or;
    if (!Array.isArray(children)) {
      throw new Error(
        "Vector search filter only supports q.eq(...) and q.or(...).",
      );
    }
    return children.flatMap((child) =>
      collectFilterClauses(child as VectorSearchExpression, definition),
    );
  }

  throw new Error(
    "Vector search filter only supports q.eq(...) and q.or(...).",
  );
}

function buildVectorFilterPlan(
  filter: VectorSearchExpression | null,
  definition: VectorIndexDefinition,
): VectorFilterPlan {
  if (filter === null) {
    return { kind: "all" };
  }

  const clauses = collectFilterClauses(filter, definition);
  if (clauses.length > 64) {
    throw new Error("Vector search supports up to 64 filter expressions.");
  }

  return { kind: "or", clauses };
}

function dotProduct(left: Float32Array, right: Float32Array): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += left[index]! * right[index]!;
  }
  return total;
}

function compareResultsByBest(
  left: VectorSearchResult,
  right: VectorSearchResult,
): number {
  if (right._score !== left._score) {
    return right._score - left._score;
  }
  return compareValues(left._id, right._id);
}

function compareResultsByWorst(
  left: VectorSearchResult,
  right: VectorSearchResult,
): number {
  if (left._score !== right._score) {
    return left._score - right._score;
  }
  return compareValues(right._id, left._id);
}

class TopKHeap {
  private _values: VectorSearchResult[] = [];

  constructor(private _limit: number) {}

  push(value: VectorSearchResult): void {
    if (this._limit === 0) {
      return;
    }

    if (this._values.length < this._limit) {
      this._values.push(value);
      this._bubbleUp(this._values.length - 1);
      return;
    }

    if (compareResultsByBest(value, this._values[0]!) >= 0) {
      return;
    }

    this._values[0] = value;
    this._bubbleDown(0);
  }

  toSortedArray(): VectorSearchResult[] {
    return [...this._values].sort(compareResultsByBest);
  }

  private _bubbleUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = (current - 1) >> 1;
      if (
        compareResultsByWorst(this._values[current]!, this._values[parent]!) >=
        0
      ) {
        break;
      }
      [this._values[current], this._values[parent]] = [
        this._values[parent]!,
        this._values[current]!,
      ];
      current = parent;
    }
  }

  private _bubbleDown(index: number): void {
    let current = index;
    for (;;) {
      const left = current * 2 + 1;
      const right = left + 1;
      let next = current;

      if (
        left < this._values.length &&
        compareResultsByWorst(this._values[left]!, this._values[next]!) < 0
      ) {
        next = left;
      }
      if (
        right < this._values.length &&
        compareResultsByWorst(this._values[right]!, this._values[next]!) < 0
      ) {
        next = right;
      }
      if (next === current) {
        return;
      }

      [this._values[current], this._values[next]] = [
        this._values[next]!,
        this._values[current]!,
      ];
      current = next;
    }
  }
}

export function resolveVectorIndexDefinition(
  vectorIndexes: ReadonlyArray<VectorIndexDefinition> | undefined,
  tableName: string,
  indexName: string,
): VectorIndexDefinition {
  const vectorIndex = vectorIndexes?.find(
    ({ indexDescriptor }) => indexDescriptor === indexName,
  );

  if (!vectorIndex) {
    throw new Error(
      `Cannot use vector index "${indexName}" for table "${tableName}" because it is not declared in the schema.`,
    );
  }

  return vectorIndex;
}

export function buildVectorIndexState(input: {
  docs: Array<{ doc: StoredDocument; identityKey: string | null }>;
  definition: VectorIndexDefinition;
}): VectorIndexState {
  const docs = new Map<string, VectorDocState>();
  const filterBuckets = new Map<string, Map<string, Set<string>>>();

  for (const { doc, identityKey } of input.docs) {
    const materialized = materializeVectorDocState({
      definition: input.definition,
      doc,
      identityKey,
    });
    if (materialized === null) {
      continue;
    }

    for (const [fieldPath, bucketKey] of materialized.bucketKeys) {
      let fieldBuckets = filterBuckets.get(fieldPath);
      if (!fieldBuckets) {
        fieldBuckets = new Map();
        filterBuckets.set(fieldPath, fieldBuckets);
      }

      let bucket = fieldBuckets.get(bucketKey);
      if (!bucket) {
        bucket = new Set();
        fieldBuckets.set(bucketKey, bucket);
      }
      bucket.add(materialized._id);
    }

    docs.set(materialized._id, materialized);
  }

  return {
    definition: input.definition,
    docs,
    filterBuckets,
    dimensions: input.definition.dimensions,
  };
}

export function removeDocumentFromVectorIndexState(
  state: VectorIndexState,
  docId: string,
): void {
  if (!state.docs.has(docId)) {
    return;
  }

  const current = state.docs.get(docId)!;
  state.docs.delete(docId);
  for (const [fieldPath, bucketKey] of current.bucketKeys) {
    const fieldBuckets = state.filterBuckets.get(fieldPath);
    const ids = fieldBuckets?.get(bucketKey);
    if (!fieldBuckets || !ids) {
      continue;
    }
    ids.delete(docId);
    if (ids.size === 0) {
      fieldBuckets.delete(bucketKey);
    }
    if (fieldBuckets.size === 0) {
      state.filterBuckets.delete(fieldPath);
    }
  }
}

export function materializeVectorDocState(input: {
  definition: VectorIndexDefinition;
  doc: StoredDocument;
  identityKey: string | null;
}): VectorDocState | null {
  const vector = normalizeStoredVector(
    evaluateFieldPath(input.definition.vectorField, input.doc),
    input.definition.dimensions,
  );
  if (vector === null) {
    return null;
  }

  const bucketKeys = new Map<string, string>();
  for (const fieldPath of input.definition.filterFields) {
    bucketKeys.set(
      fieldPath,
      valueToBucketKey(evaluateFieldPath(fieldPath, input.doc)),
    );
  }

  return {
    _id: String(input.doc._id),
    vector,
    identityKey: input.identityKey,
    bucketKeys,
  };
}

function addMaterializedVectorDocState(
  state: VectorIndexState,
  docState: VectorDocState,
): void {
  state.docs.set(docState._id, docState);
  for (const [fieldPath, bucketKey] of docState.bucketKeys) {
    let fieldBuckets = state.filterBuckets.get(fieldPath);
    if (!fieldBuckets) {
      fieldBuckets = new Map();
      state.filterBuckets.set(fieldPath, fieldBuckets);
    }

    let ids = fieldBuckets.get(bucketKey);
    if (!ids) {
      ids = new Set();
      fieldBuckets.set(bucketKey, ids);
    }
    ids.add(docState._id);
  }
}

export function addDocumentToVectorIndexState(
  state: VectorIndexState,
  input: { doc: StoredDocument; identityKey: string | null },
): void {
  const docState = materializeVectorDocState({
    definition: state.definition,
    doc: input.doc,
    identityKey: input.identityKey,
  });
  if (docState === null) {
    return;
  }

  addMaterializedVectorDocState(state, docState);
}

function getCandidateIds(
  state: VectorIndexState,
  plan: VectorFilterPlan,
): Iterable<string> {
  if (plan.kind === "all") {
    return state.docs.keys();
  }

  const ids = new Set<string>();
  for (const clause of plan.clauses) {
    for (const docId of state.filterBuckets
      .get(clause.fieldPath)
      ?.get(clause.bucketKey) ?? []) {
      ids.add(docId);
    }
  }
  return ids;
}

export function executeVectorSearch(
  state: VectorIndexState,
  input: {
    vector: number[];
    limit?: number;
    filter: VectorSearchExpression | null;
    activeIdentityKey: string | null;
  },
): Array<{ _id: string; _score: number }> {
  const limit = normalizeLimit(input.limit);
  const { vector, isZero } = normalizeQueryVector(
    input.vector,
    state.dimensions,
  );
  const plan = buildVectorFilterPlan(input.filter, state.definition);
  const candidateIds = getCandidateIds(state, plan);

  const heap = new TopKHeap(limit);
  for (const docId of candidateIds) {
    const doc = state.docs.get(docId);
    if (!doc || doc.identityKey !== input.activeIdentityKey) {
      continue;
    }

    heap.push({
      _id: doc._id,
      _score: isZero ? 0 : dotProduct(vector, doc.vector),
    });
  }

  return heap.toSortedArray();
}

export function executeOverlayVectorSearch(
  baseState: VectorIndexState,
  overlay: VectorOverlayState,
  input: {
    vector: number[];
    limit?: number;
    filter: VectorSearchExpression | null;
    activeIdentityKey: string | null;
  },
): Array<{ _id: string; _score: number }> {
  const limit = normalizeLimit(input.limit);
  const { vector, isZero } = normalizeQueryVector(
    input.vector,
    baseState.dimensions,
  );
  const basePlan = buildVectorFilterPlan(input.filter, baseState.definition);
  const overlayPlan = buildVectorFilterPlan(
    input.filter,
    overlay.state.definition,
  );

  const heap = new TopKHeap(limit);

  for (const docId of getCandidateIds(baseState, basePlan)) {
    if (overlay.shadowedIds.has(docId)) {
      continue;
    }
    const doc = baseState.docs.get(docId);
    if (!doc || doc.identityKey !== input.activeIdentityKey) {
      continue;
    }
    heap.push({
      _id: doc._id,
      _score: isZero ? 0 : dotProduct(vector, doc.vector),
    });
  }

  for (const docId of getCandidateIds(overlay.state, overlayPlan)) {
    const doc = overlay.state.docs.get(docId);
    if (!doc || doc.identityKey !== input.activeIdentityKey) {
      continue;
    }
    heap.push({
      _id: doc._id,
      _score: isZero ? 0 : dotProduct(vector, doc.vector),
    });
  }

  return heap.toSortedArray();
}
