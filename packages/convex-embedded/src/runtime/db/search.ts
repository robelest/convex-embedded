import { convexToJson } from "convex/values";
import type { JSONValue, Value } from "convex/values";

import { compareValues } from "@/runtime/db/compare";
import { evaluateFieldPath } from "@/runtime/db/fieldpath";
import type { SearchIndexDefinition } from "@/runtime/db/schema";
import type {
  SerializedSearchFilter,
  Source,
  StoredDocument,
} from "@/runtime/db/types";

const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const MAX_QUERY_TERMS = 16;
const MAX_TOKEN_LENGTH = 32;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const EXACT_MATCH_BONUS = 0.1;
const PROXIMITY_BONUS = 0.2;

export interface SearchDocStats {
  doc: StoredDocument;
  identityKey: string | null;
  docLength: number;
  terms: Map<string, { termFrequency: number; positions: number[] }>;
  filterKeys: Map<string, string>;
}

export interface SearchIndexState {
  definition: SearchIndexDefinition;
  postings: Map<
    string,
    Map<string, { termFrequency: number; positions: number[] }>
  >;
  lexicon: string[];
  docStats: Map<string, SearchDocStats>;
  filterBuckets: Map<string, Map<string, Set<string>>>;
  avgDocLength: number;
  docCount: number;
}

export type SearchOverlayState = {
  state: SearchIndexState;
  shadowedIds: Set<string>;
};

type SearchPosting = { termFrequency: number; positions: number[] };

type SearchQueryPlan = {
  searchField: string;
  exactTerms: string[];
  finalPrefix: string | null;
  eqFilters: Array<{ fieldPath: string; bucketKey: string }>;
};

function normalizeToken(token: string): string {
  return token.normalize("NFKC").toLowerCase().slice(0, MAX_TOKEN_LENGTH);
}

function tokenizeText(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  return Array.from(normalized.matchAll(TOKEN_RE), (match) =>
    normalizeToken(match[0]),
  ).filter((token) => token.length > 0);
}

function tokenizeQueryText(query: string): string[] {
  return tokenizeText(query).slice(0, MAX_QUERY_TERMS);
}

function valueToBucketKey(value: Value | undefined): string {
  return value === undefined
    ? JSON.stringify({ $undefined: true })
    : JSON.stringify(convexToJson(value));
}

function searchFilterValueToBucketKey(value: JSONValue): string {
  return JSON.stringify(value);
}

export function getSearchIndexDefinition(
  searchIndexes: ReadonlyArray<SearchIndexDefinition> | undefined,
  tableName: string,
  indexName: string,
): SearchIndexDefinition {
  const searchIndex = searchIndexes?.find(
    ({ indexDescriptor }) => indexDescriptor === indexName,
  );

  if (!searchIndex) {
    throw new Error(
      `Cannot use search index "${indexName}" for table "${tableName}" because it is not declared in the schema.`,
    );
  }

  return searchIndex;
}

function buildSearchQueryPlan(
  source: Extract<Source, { type: "Search" }>,
  definition: SearchIndexDefinition,
): SearchQueryPlan {
  const searchFilters = source.filters.filter(
    (filter): filter is Extract<SerializedSearchFilter, { type: "Search" }> =>
      filter.type === "Search",
  );
  if (searchFilters.length !== 1) {
    throw new Error(
      `Search index "${definition.indexDescriptor}" requires exactly one search() clause.`,
    );
  }

  const searchFilter = searchFilters[0]!;
  if (searchFilter.fieldPath !== definition.searchField) {
    throw new Error(
      `Search index "${definition.indexDescriptor}" expects searchField "${definition.searchField}", got "${searchFilter.fieldPath}".`,
    );
  }

  const eqFilters = source.filters
    .filter(
      (filter): filter is Extract<SerializedSearchFilter, { type: "Eq" }> =>
        filter.type === "Eq",
    )
    .map((filter) => {
      if (!definition.filterFields.includes(filter.fieldPath)) {
        throw new Error(
          `Search index "${definition.indexDescriptor}" does not allow equality filter on "${filter.fieldPath}".`,
        );
      }

      return {
        fieldPath: filter.fieldPath,
        bucketKey: searchFilterValueToBucketKey(filter.value),
      };
    });

  const queryTerms = tokenizeQueryText(searchFilter.value);
  const exactTerms = queryTerms.slice(0, -1);
  const finalPrefix = queryTerms.length > 0 ? queryTerms.at(-1)! : null;

  return {
    searchField: definition.searchField,
    exactTerms,
    finalPrefix,
    eqFilters,
  };
}

export function buildSearchIndexState(input: {
  docs: Array<{ doc: StoredDocument; identityKey: string | null }>;
  definition: SearchIndexDefinition;
}): SearchIndexState {
  const state: SearchIndexState = {
    definition: input.definition,
    postings: new Map(),
    lexicon: [],
    docStats: new Map(),
    filterBuckets: new Map(),
    avgDocLength: 0,
    docCount: 0,
  };

  for (const current of input.docs) {
    addDocumentToSearchIndexState(state, current);
  }

  return state;
}

function buildSearchDocStats(input: {
  doc: StoredDocument;
  identityKey: string | null;
  definition: SearchIndexDefinition;
}): SearchDocStats {
  const rawValue = evaluateFieldPath(input.definition.searchField, input.doc);
  const tokens = tokenizeText(typeof rawValue === "string" ? rawValue : "");
  const terms = new Map<string, SearchPosting>();
  tokens.forEach((token, position) => {
    const current = terms.get(token) ?? { termFrequency: 0, positions: [] };
    current.termFrequency += 1;
    current.positions.push(position);
    terms.set(token, current);
  });

  const filterKeys = new Map<string, string>();
  for (const fieldPath of input.definition.filterFields) {
    filterKeys.set(
      fieldPath,
      valueToBucketKey(evaluateFieldPath(fieldPath, input.doc)),
    );
  }

  return {
    doc: input.doc,
    identityKey: input.identityKey,
    docLength: tokens.length,
    terms,
    filterKeys,
  };
}

function binarySearchLexiconTerm(lexicon: string[], term: string): number {
  let low = 0;
  let high = lexicon.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareValues(lexicon[mid], term) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function insertLexiconTerm(lexicon: string[], term: string): void {
  const index = binarySearchLexiconTerm(lexicon, term);
  if (lexicon[index] !== term) {
    lexicon.splice(index, 0, term);
  }
}

function deleteLexiconTerm(lexicon: string[], term: string): void {
  const index = binarySearchLexiconTerm(lexicon, term);
  if (lexicon[index] === term) {
    lexicon.splice(index, 1);
  }
}

function addStatsToSearchIndexState(
  state: SearchIndexState,
  stats: SearchDocStats,
): void {
  const docId = String(stats.doc._id);

  state.docStats.set(docId, stats);
  for (const [term, posting] of stats.terms) {
    let termPostings = state.postings.get(term);
    if (!termPostings) {
      termPostings = new Map();
      state.postings.set(term, termPostings);
      insertLexiconTerm(state.lexicon, term);
    }
    termPostings.set(docId, posting);
  }

  for (const [fieldPath, bucketKey] of stats.filterKeys) {
    let fieldBuckets = state.filterBuckets.get(fieldPath);
    if (!fieldBuckets) {
      fieldBuckets = new Map();
      state.filterBuckets.set(fieldPath, fieldBuckets);
    }

    let docs = fieldBuckets.get(bucketKey);
    if (!docs) {
      docs = new Set();
      fieldBuckets.set(bucketKey, docs);
    }
    docs.add(docId);
  }
}

export function addDocumentToSearchIndexState(
  state: SearchIndexState,
  input: { doc: StoredDocument; identityKey: string | null },
): void {
  const stats = buildSearchDocStats({
    doc: input.doc,
    identityKey: input.identityKey,
    definition: state.definition,
  });
  const totalDocLength = state.avgDocLength * state.docCount + stats.docLength;

  addStatsToSearchIndexState(state, stats);
  state.docCount += 1;
  state.avgDocLength =
    state.docCount === 0 ? 0 : totalDocLength / state.docCount;
}

export function deleteDocumentFromSearchIndexState(
  state: SearchIndexState,
  docId: string,
): void {
  const stats = state.docStats.get(docId);
  if (!stats) {
    return;
  }

  for (const term of stats.terms.keys()) {
    const termPostings = state.postings.get(term);
    if (!termPostings) {
      continue;
    }
    termPostings.delete(docId);
    if (termPostings.size === 0) {
      state.postings.delete(term);
      deleteLexiconTerm(state.lexicon, term);
    }
  }

  for (const [fieldPath, bucketKey] of stats.filterKeys) {
    const fieldBuckets = state.filterBuckets.get(fieldPath);
    const docs = fieldBuckets?.get(bucketKey);
    if (!fieldBuckets || !docs) {
      continue;
    }

    docs.delete(docId);
    if (docs.size === 0) {
      fieldBuckets.delete(bucketKey);
    }
    if (fieldBuckets.size === 0) {
      state.filterBuckets.delete(fieldPath);
    }
  }

  const previousCount = state.docCount;
  state.docStats.delete(docId);
  state.docCount = Math.max(0, previousCount - 1);
  if (state.docCount === 0) {
    state.avgDocLength = 0;
    return;
  }

  state.avgDocLength =
    (state.avgDocLength * previousCount - stats.docLength) / state.docCount;
}

function binarySearchPrefixStart(lexicon: string[], prefix: string): number {
  let low = 0;
  let high = lexicon.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareValues(lexicon[mid], prefix) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function getPrefixTerms(lexicon: string[], prefix: string): string[] {
  if (prefix.length === 0) {
    return [];
  }

  const start = binarySearchPrefixStart(lexicon, prefix);
  const matches: string[] = [];
  for (let index = start; index < lexicon.length; index += 1) {
    const term = lexicon[index]!;
    if (!term.startsWith(prefix)) {
      break;
    }
    matches.push(term);
  }
  return matches;
}

function intersectSets(left: Set<string>, right: Set<string>): Set<string> {
  const result = new Set<string>();
  const [small, large] =
    left.size <= right.size ? [left, right] : [right, left];
  for (const value of small) {
    if (large.has(value)) {
      result.add(value);
    }
  }
  return result;
}

function gatherCandidateIds(
  state: SearchIndexState,
  plan: SearchQueryPlan,
): {
  candidateIds: Set<string>;
  prefixTerms: string[];
  termGroups: string[][];
} {
  let candidateIds: Set<string> | null = null;

  for (const term of plan.exactTerms) {
    const postingIds = new Set(state.postings.get(term)?.keys() ?? []);
    candidateIds =
      candidateIds === null
        ? postingIds
        : intersectSets(candidateIds, postingIds);
    if (candidateIds.size === 0) {
      return { candidateIds, prefixTerms: [], termGroups: [] };
    }
  }

  const prefixTerms = getPrefixTerms(state.lexicon, plan.finalPrefix ?? "");
  if (prefixTerms.length === 0) {
    return { candidateIds: new Set(), prefixTerms, termGroups: [] };
  }

  const prefixIds = new Set<string>();
  for (const term of prefixTerms) {
    for (const docId of state.postings.get(term)?.keys() ?? []) {
      prefixIds.add(docId);
    }
  }

  candidateIds =
    candidateIds === null ? prefixIds : intersectSets(candidateIds, prefixIds);
  for (const filter of plan.eqFilters) {
    const fieldBucket =
      state.filterBuckets.get(filter.fieldPath)?.get(filter.bucketKey) ??
      new Set<string>();
    candidateIds = intersectSets(candidateIds, fieldBucket);
    if (candidateIds.size === 0) {
      return { candidateIds, prefixTerms, termGroups: [] };
    }
  }

  return {
    candidateIds,
    prefixTerms,
    termGroups: [...plan.exactTerms.map((term) => [term]), prefixTerms],
  };
}

function buildDocFrequencyMap(
  states: SearchIndexState[],
  shadowedIds: Set<string>,
): Map<string, number> {
  const docFrequencies = new Map<string, number>();
  for (const state of states) {
    for (const [term, postings] of state.postings) {
      let count = 0;
      for (const docId of postings.keys()) {
        if (!shadowedIds.has(docId)) {
          count += 1;
        }
      }
      if (count > 0) {
        docFrequencies.set(term, (docFrequencies.get(term) ?? 0) + count);
      }
    }
  }
  return docFrequencies;
}

function buildGroupDocFrequencies(
  termGroups: string[][],
  docFrequencies: Map<string, number>,
  states: SearchIndexState[],
  shadowedIds: Set<string>,
): number[] {
  return termGroups.map((group) => {
    if (group.length === 1) {
      return docFrequencies.get(group[0]!) ?? 0;
    }

    const docIds = new Set<string>();
    for (const term of group) {
      for (const state of states) {
        for (const docId of state.postings.get(term)?.keys() ?? []) {
          if (!shadowedIds.has(docId)) {
            docIds.add(docId);
          }
        }
      }
    }
    return docIds.size;
  });
}

function computeEffectiveCorpusStats(
  baseState: SearchIndexState,
  overlay: SearchOverlayState,
): {
  docCount: number;
  avgDocLength: number;
  docFrequencies: Map<string, number>;
} {
  let removedDocCount = 0;
  let removedDocLength = 0;
  for (const docId of overlay.shadowedIds) {
    const stats = baseState.docStats.get(docId);
    if (stats) {
      removedDocCount += 1;
      removedDocLength += stats.docLength;
    }
  }

  const docCount =
    baseState.docCount - removedDocCount + overlay.state.docCount;
  const totalDocLength =
    baseState.avgDocLength * baseState.docCount -
    removedDocLength +
    overlay.state.avgDocLength * overlay.state.docCount;

  return {
    docCount,
    avgDocLength: docCount === 0 ? 0 : totalDocLength / docCount,
    docFrequencies: buildDocFrequencyMap(
      [baseState, overlay.state],
      overlay.shadowedIds,
    ),
  };
}

type ScoredDoc = { doc: StoredDocument; score: number };

function compareScoredDocsWorst(left: ScoredDoc, right: ScoredDoc): number {
  return -compareScoredDocs(left, right);
}

interface SearchTopKHeap {
  push(value: ScoredDoc): void;
  toSortedArray(): ScoredDoc[];
}

function createSearchTopKHeap(limit: number): SearchTopKHeap {
  const values: ScoredDoc[] = [];

  function bubbleUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = (current - 1) >> 1;
      if (compareScoredDocsWorst(values[current]!, values[parent]!) >= 0) {
        break;
      }
      [values[current], values[parent]] = [values[parent]!, values[current]!];
      current = parent;
    }
  }

  function bubbleDown(index: number): void {
    let current = index;
    for (;;) {
      const left = current * 2 + 1;
      const right = left + 1;
      let next = current;

      if (
        left < values.length &&
        compareScoredDocsWorst(values[left]!, values[next]!) < 0
      ) {
        next = left;
      }
      if (
        right < values.length &&
        compareScoredDocsWorst(values[right]!, values[next]!) < 0
      ) {
        next = right;
      }
      if (next === current) return;

      [values[current], values[next]] = [values[next]!, values[current]!];
      current = next;
    }
  }

  return {
    push(value: ScoredDoc): void {
      if (limit === 0) return;
      if (values.length < limit) {
        values.push(value);
        bubbleUp(values.length - 1);
        return;
      }
      if (compareScoredDocs(value, values[0]!) >= 0) return;
      values[0] = value;
      bubbleDown(0);
    },
    toSortedArray(): ScoredDoc[] {
      return [...values].sort(compareScoredDocs);
    },
  };
}

function scoreCandidateDocs(input: {
  state: SearchIndexState;
  candidateIds: Set<string>;
  termGroups: string[][];
  exactTermsLength: number;
  activeIdentityKey: string | null;
  docCount: number;
  avgDocLength: number;
  groupDocFrequencies: number[];
  shadowedIds?: Set<string>;
  limit?: number;
}): ScoredDoc[] {
  const scored: ScoredDoc[] = [];
  const heap =
    input.limit === undefined ? null : createSearchTopKHeap(input.limit);
  for (const docId of input.candidateIds) {
    if (input.shadowedIds?.has(docId)) {
      continue;
    }

    const stats = input.state.docStats.get(docId);
    if (!stats || stats.identityKey !== input.activeIdentityKey) {
      continue;
    }

    const positionGroups = input.termGroups.map((group) =>
      group.flatMap((term) => stats.terms.get(term)?.positions ?? []),
    );
    const score = input.termGroups.reduce((acc, group, groupIndex) => {
      const tf = group.reduce(
        (sum, term) => sum + (stats.terms.get(term)?.termFrequency ?? 0),
        0,
      );
      const bm25Score = bm25(
        tf,
        input.groupDocFrequencies[groupIndex] ?? 0,
        stats.docLength,
        input.avgDocLength,
        input.docCount,
      );
      const exactMatches = groupIndex < input.exactTermsLength ? tf : 0;
      return acc + bm25Score + exactMatches * EXACT_MATCH_BONUS;
    }, 0);

    const scoredDoc = {
      doc: stats.doc,
      score: score + computeProximityBonus(positionGroups),
    };
    if (heap) {
      heap.push(scoredDoc);
    } else {
      scored.push(scoredDoc);
    }
  }
  return heap ? heap.toSortedArray() : scored;
}

function compareScoredDocs(left: ScoredDoc, right: ScoredDoc): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  const creationComparison =
    (right.doc._creationTime ?? 0) - (left.doc._creationTime ?? 0);
  if (creationComparison !== 0) {
    return creationComparison;
  }
  return compareValues(left.doc._id, right.doc._id);
}

function bm25(
  tf: number,
  df: number,
  docLen: number,
  avgDocLen: number,
  docCount: number,
): number {
  if (tf === 0 || df === 0 || docCount === 0) {
    return 0;
  }

  const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
  const norm =
    docLen === 0 || avgDocLen === 0
      ? 1
      : 1 - BM25_B + (BM25_B * docLen) / avgDocLen;
  return (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm);
}

function computeProximityBonus(positionGroups: number[][]): number {
  if (
    positionGroups.length <= 1 ||
    positionGroups.some((positions) => positions.length === 0)
  ) {
    return 0;
  }

  const flattened = positionGroups.flatMap((positions, groupIndex) =>
    positions.map((position) => ({ position, groupIndex })),
  );
  flattened.sort((left, right) => left.position - right.position);

  const counts = new Map<number, number>();
  let covered = 0;
  let bestSpan = Number.POSITIVE_INFINITY;
  let left = 0;

  for (let right = 0; right < flattened.length; right += 1) {
    const current = flattened[right]!;
    const nextCount = (counts.get(current.groupIndex) ?? 0) + 1;
    counts.set(current.groupIndex, nextCount);
    if (nextCount === 1) {
      covered += 1;
    }

    while (covered === positionGroups.length && left <= right) {
      bestSpan = Math.min(
        bestSpan,
        flattened[right]!.position - flattened[left]!.position + 1,
      );
      const leftItem = flattened[left]!;
      const remaining = (counts.get(leftItem.groupIndex) ?? 1) - 1;
      if (remaining === 0) {
        counts.delete(leftItem.groupIndex);
        covered -= 1;
      } else {
        counts.set(leftItem.groupIndex, remaining);
      }
      left += 1;
    }
  }

  return Number.isFinite(bestSpan) ? PROXIMITY_BONUS / bestSpan : 0;
}

export function executeSearch(
  state: SearchIndexState,
  input: {
    source: Extract<Source, { type: "Search" }>;
    activeIdentityKey: string | null;
    limit?: number;
  },
): StoredDocument[] {
  const plan = buildSearchQueryPlan(input.source, state.definition);
  if (plan.finalPrefix === null) {
    return [];
  }
  const { candidateIds, termGroups } = gatherCandidateIds(state, plan);
  if (candidateIds.size === 0 || termGroups.length === 0) {
    return [];
  }

  const docFrequencies = buildDocFrequencyMap([state], new Set());
  const groupDocFrequencies = buildGroupDocFrequencies(
    termGroups,
    docFrequencies,
    [state],
    new Set(),
  );
  return scoreCandidateDocs({
    state,
    candidateIds,
    termGroups,
    exactTermsLength: plan.exactTerms.length,
    activeIdentityKey: input.activeIdentityKey,
    docCount: state.docCount,
    avgDocLength: state.avgDocLength,
    groupDocFrequencies,
    limit: input.limit,
  })
    .sort(compareScoredDocs)
    .map(({ doc }) => doc);
}

export function executeOverlaySearch(
  baseState: SearchIndexState,
  overlay: SearchOverlayState,
  input: {
    source: Extract<Source, { type: "Search" }>;
    activeIdentityKey: string | null;
    limit?: number;
  },
): StoredDocument[] {
  const plan = buildSearchQueryPlan(input.source, baseState.definition);
  if (plan.finalPrefix === null) {
    return [];
  }

  const baseCandidates = gatherCandidateIds(baseState, plan);
  const overlayCandidates = gatherCandidateIds(overlay.state, plan);
  const termGroups =
    baseCandidates.termGroups.length > 0
      ? baseCandidates.termGroups
      : overlayCandidates.termGroups;
  if (termGroups.length === 0) {
    return [];
  }

  const corpus = computeEffectiveCorpusStats(baseState, overlay);
  const groupDocFrequencies = buildGroupDocFrequencies(
    termGroups,
    corpus.docFrequencies,
    [baseState, overlay.state],
    overlay.shadowedIds,
  );
  const scored = [
    ...scoreCandidateDocs({
      state: baseState,
      candidateIds: baseCandidates.candidateIds,
      termGroups,
      exactTermsLength: plan.exactTerms.length,
      activeIdentityKey: input.activeIdentityKey,
      docCount: corpus.docCount,
      avgDocLength: corpus.avgDocLength,
      groupDocFrequencies,
      shadowedIds: overlay.shadowedIds,
      limit: input.limit,
    }),
    ...scoreCandidateDocs({
      state: overlay.state,
      candidateIds: overlayCandidates.candidateIds,
      termGroups,
      exactTermsLength: plan.exactTerms.length,
      activeIdentityKey: input.activeIdentityKey,
      docCount: corpus.docCount,
      avgDocLength: corpus.avgDocLength,
      groupDocFrequencies,
      limit: input.limit,
    }),
  ];

  return scored
    .sort(compareScoredDocs)
    .slice(0, input.limit)
    .map(({ doc }) => doc);
}
