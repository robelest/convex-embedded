import type { GenericDataModel, GenericQueryCtx } from "convex/server";

import type { QueryPageRange } from "@/shared/types";

import type { PullSpec } from "./types";

interface IndexEqChain {
  eq(field: string, value: unknown): IndexEqChain;
}

interface IndexPaginable {
  paginate(opts: { cursor: string | null; numItems: number }): Promise<{
    page: unknown[];
    isDone: boolean;
    continueCursor: string;
  }>;
}

interface ScopedIndexReader {
  query(table: string): {
    withIndex(
      indexName: string,
      range: (q: IndexEqChain) => IndexEqChain,
    ): IndexPaginable;
  };
}

interface RangeIndexReader {
  query(table: string): {
    withIndex(
      indexName: string,
      range: (q: IndexEqChain) => IndexEqChain,
    ): IndexPaginable & {
      order(direction: "asc" | "desc"): IndexPaginable;
    };
  };
}

const SCOPE_CURSOR_PREFIX = "scope:";

export function parseScopeCursor(cursor: string | null): number {
  if (!cursor || !cursor.startsWith(SCOPE_CURSOR_PREFIX)) return 0;
  const value = Number(cursor.slice(SCOPE_CURSOR_PREFIX.length));
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function encodeScopeCursor(offset: number): string {
  return `${SCOPE_CURSOR_PREFIX}${offset}`;
}

function getFieldValueByPath(
  doc: Record<string, unknown>,
  fieldPath: string,
): unknown {
  return fieldPath.split(".").reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, doc);
}

export function matchesScopeArgs(
  doc: Record<string, unknown>,
  scopeArgs?: Record<string, unknown>,
): boolean {
  if (!scopeArgs || Object.keys(scopeArgs).length === 0) {
    return true;
  }
  return Object.entries(scopeArgs).every(
    ([fieldPath, expected]) => getFieldValueByPath(doc, fieldPath) === expected,
  );
}

/**
 * Pick the index whose leading fields best match `scopeArgs`. Returns the
 * index descriptor + the fields that will be equality-constrained, or
 * `null` if no index matches.
 */
function pickIndex(
  spec: PullSpec,
  scopeArgs: Record<string, unknown>,
): { indexName: string; fields: readonly string[] } | null {
  const scopeKeys = new Set(Object.keys(scopeArgs));
  let best: { indexName: string; fields: readonly string[] } | null = null;
  for (const [indexName, fields] of spec.declaredIndexes.entries()) {
    let covered = 0;
    for (const f of fields) {
      if (scopeKeys.has(f)) covered += 1;
      else break;
    }
    if (covered === 0) continue;
    if (!best || covered > best.fields.length) {
      best = { indexName, fields: fields.slice(0, covered) };
    }
  }
  return best;
}

/**
 * Resolve scope args to a list of in-scope doc IDs by issuing an indexed
 * read on the user's own table. Returns `null` when no index covers the
 * scope args (runtime falls back to paginated full snapshot).
 */
export async function getScopedDocIds(
  ctx: GenericQueryCtx<GenericDataModel>,
  spec: PullSpec,
  scopeArgs: Record<string, unknown>,
  log: { warn: (msg: string, error: unknown) => void },
): Promise<string[] | null> {
  const match = pickIndex(spec, scopeArgs);
  if (!match) return null;
  const db = ctx.db as unknown as ScopedIndexReader;
  try {
    const ids: string[] = [];
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone) {
      const page = await db
        .query(spec.tableName)
        .withIndex(match.indexName, (q) => {
          let chain = q;
          for (const field of match.fields) {
            chain = chain.eq(field, scopeArgs[field]);
          }
          return chain;
        })
        .paginate({ cursor, numItems: 500 });
      for (const doc of page.page) {
        ids.push((doc as { _id: string })._id);
      }
      isDone = page.isDone;
      cursor = page.continueCursor;
    }
    return ids;
  } catch (error) {
    log.warn(
      `getScopedDocIds(${spec.tableName}, ${match.indexName}): failed`,
      error,
    );
    return null;
  }
}

export async function getRangeDocIds(
  ctx: GenericQueryCtx<GenericDataModel>,
  spec: PullSpec,
  range: QueryPageRange,
  log: { warn: (msg: string, error: unknown) => void },
): Promise<{
  orderedDocIds: string[];
  continueCursor: string | null;
  isDone: boolean;
} | null> {
  if (!spec.declaredIndexes.has(range.indexName)) return null;
  const db = ctx.db as unknown as RangeIndexReader;
  try {
    const page = await db
      .query(spec.tableName)
      .withIndex(range.indexName, (q) => {
        let chain = q;
        for (const { field, value } of range.eq) {
          chain = chain.eq(field, value);
        }
        return chain;
      })
      .order(range.order)
      .paginate({ cursor: range.cursor ?? null, numItems: range.numItems });
    const orderedDocIds = page.page.map((doc) => (doc as { _id: string })._id);
    return {
      orderedDocIds,
      continueCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    };
  } catch (error) {
    log.warn(
      `getRangeDocIds(${spec.tableName}, ${range.indexName}): failed`,
      error,
    );
    return null;
  }
}
