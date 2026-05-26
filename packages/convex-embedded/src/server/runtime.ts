/**
 * Runtime binding for embedded tables.
 *
 * Sets hooks on table handles for component-dependent behavior (resolve
 * diffing, delta recording, runtime detection). These hooks are called
 * by the builders created in `schema.ts`.
 *
 * @internal
 */

import type {
  DefaultFunctionArgs,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  RegisteredQuery,
} from "convex/server";
import type { GenericId } from "convex/values";

import type {
  ComponentBinding,
  EmbeddedTableRuntimeHandle,
  RuntimeHooks,
} from "@/server/schema";
import { createLogger } from "@/shared/logger";
import type { Definition } from "@/shared/schema";
import { getCrdtType } from "@/shared/schema";
import { REMOTE_META } from "@/shared/symbols";
import type { RemoteMeta } from "@/shared/symbols";
import type { QueryPageRange } from "@/shared/types";
import {
  computeDiff,
  encodeDocumentState,
  isDiffEmpty,
  materializeDocumentFromUpdate,
} from "@/shared/yjs";

const log = createLogger("server-runtime");

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}

function pickCrdtFields(
  schemaDef: Definition,
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, fieldDef] of Object.entries(schemaDef.getShape())) {
    if (getCrdtType(fieldDef) === null) continue;
    if (key in doc) {
      result[key] = doc[key];
    }
  }
  return result;
}

function hasCrdtFields(schemaDef: Definition): boolean {
  for (const fieldDef of Object.values(schemaDef.getShape())) {
    if (getCrdtType(fieldDef) !== null) return true;
  }
  return false;
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

function matchesScopeArgs(
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

const SCOPE_CURSOR_PREFIX = "scope:";

function parseScopeCursor(cursor: string | null): number {
  if (!cursor || !cursor.startsWith(SCOPE_CURSOR_PREFIX)) return 0;
  const value = Number(cursor.slice(SCOPE_CURSOR_PREFIX.length));
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function encodeScopeCursor(offset: number): string {
  return `${SCOPE_CURSOR_PREFIX}${offset}`;
}

function extractDocId(
  result: unknown,
  args: Record<string, unknown> | null | undefined,
  tableName?: string,
): string | null {
  if (typeof result === "string") return result;
  if (args?.id && typeof args.id === "string") return args.id;
  if (args?._id && typeof args._id === "string") return args._id;
  if (args?.docId && typeof args.docId === "string") return args.docId;
  if (tableName && args && typeof args === "object") {
    const singular = tableName.replace(/s$/, "");
    const tableIdKey = `${singular}Id`;
    if (typeof args[tableIdKey] === "string") return args[tableIdKey];
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error == null) return "unknown error";
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

function parseRuntimeErrorDetails(error: unknown): {
  code?: string;
  message: string;
} {
  const fallback = errorMessage(error);
  try {
    const parsed = JSON.parse(fallback) as {
      code?: unknown;
      message?: unknown;
    };
    if (parsed && typeof parsed === "object") {
      return {
        code: typeof parsed.code === "string" ? parsed.code : undefined,
        message:
          typeof parsed.message === "string"
            ? parsed.message.toLowerCase()
            : fallback.toLowerCase(),
      };
    }
  } catch {}
  return { message: fallback.toLowerCase() };
}

function isComponentUnavailableError(error: unknown): boolean {
  const { code, message } = parseRuntimeErrorDetails(error);
  if (code === "NESTED_COMPONENT_LOCAL_UNSUPPORTED") {
    return true;
  }
  return (
    message.includes("component unavailable") ||
    message.includes("local execution reached component function") ||
    message.includes("nested_component_local_unsupported") ||
    message.includes("function not found") ||
    message.includes("is not registered")
  );
}

interface RuntimeHandleInternals {
  _hooks: RuntimeHooks;
  _declaredIndexes?: Map<string, readonly string[]>;
}

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

export function bindTableRuntime(
  handle: EmbeddedTableRuntimeHandle,
  component?: ComponentBinding,
): void {
  const tableDef = handle as EmbeddedTableRuntimeHandle &
    RuntimeHandleInternals;
  const hooks: RuntimeHooks = tableDef._hooks;
  const tableName = handle.table;
  const schemaDef = handle.schema;

  if (!component) {
    log.debug(`bindTableRuntime("${tableName}") — no component, local-only`);
    return;
  }

  const declaredIndexes: Map<string, readonly string[]> =
    tableDef._declaredIndexes ?? new Map();

  /**
   * Pick the index whose leading fields best match `scopeArgs`. Returns the
   * index descriptor + the fields that will be equality-constrained, or
   * `null` if no index matches.
   */
  function pickIndex(scopeArgs: Record<string, unknown>): {
    indexName: string;
    fields: readonly string[];
  } | null {
    const scopeKeys = new Set(Object.keys(scopeArgs));
    let best: { indexName: string; fields: readonly string[] } | null = null;
    for (const [indexName, fields] of declaredIndexes.entries()) {
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
  async function getScopedDocIds(
    ctx: GenericQueryCtx<GenericDataModel>,
    scopeArgs: Record<string, unknown>,
  ): Promise<string[] | null> {
    const match = pickIndex(scopeArgs);
    if (!match) return null;
    const db = ctx.db as unknown as ScopedIndexReader;
    try {
      const ids: string[] = [];
      let cursor: string | null = null;
      let isDone = false;
      while (!isDone) {
        const page = await db
          .query(tableName)
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
        `getScopedDocIds(${tableName}, ${match.indexName}): failed`,
        error,
      );
      return null;
    }
  }

  async function getRangeDocIds(
    ctx: GenericQueryCtx<GenericDataModel>,
    range: QueryPageRange,
  ): Promise<{
    orderedDocIds: string[];
    continueCursor: string | null;
    isDone: boolean;
  } | null> {
    if (!declaredIndexes.has(range.indexName)) return null;
    const db = ctx.db as unknown as RangeIndexReader;
    try {
      const page = await db
        .query(tableName)
        .withIndex(range.indexName, (q) => {
          let chain = q;
          for (const { field, value } of range.eq) {
            chain = chain.eq(field, value);
          }
          return chain;
        })
        .order(range.order)
        .paginate({ cursor: range.cursor ?? null, numItems: range.numItems });
      const orderedDocIds = page.page.map(
        (doc) => (doc as { _id: string })._id,
      );
      return {
        orderedDocIds,
        continueCursor: page.isDone ? null : page.continueCursor,
        isDone: page.isDone,
      };
    } catch (error) {
      log.warn(
        `getRangeDocIds(${tableName}, ${range.indexName}): failed`,
        error,
      );
      return null;
    }
  }

  const runtimeCache = new WeakMap<object, boolean>();

  function cacheRuntimeValue(
    ctx: GenericQueryCtx<GenericDataModel>,
    isRemote: boolean,
  ): boolean {
    if (
      ctx !== null &&
      (typeof ctx === "object" || typeof ctx === "function")
    ) {
      runtimeCache.set(ctx, isRemote);
    }
    return isRemote;
  }

  async function detectRuntime(
    ctx: GenericQueryCtx<GenericDataModel>,
  ): Promise<boolean> {
    if (
      ctx !== null &&
      (typeof ctx === "object" || typeof ctx === "function")
    ) {
      const cached = runtimeCache.get(ctx);
      if (cached !== undefined) {
        return cached;
      }
    }
    try {
      await ctx.runQuery(component!.public.getLiveStates, {
        collection: tableName,
        docIds: [],
      });
      log.debug(`detectRuntime(${tableName}): component resolved -> remote`);
      return cacheRuntimeValue(ctx, true);
    } catch (error) {
      if (!isComponentUnavailableError(error)) {
        throw error;
      }
      log.debug(`detectRuntime(${tableName}): component unavailable -> local`);
      return cacheRuntimeValue(ctx, false);
    }
  }

  async function recordRemoteChange(
    ctx: GenericMutationCtx<GenericDataModel>,
    docId: string,
  ): Promise<void> {
    try {
      if (!hasCrdtFields(schemaDef)) {
        const doc = await ctx.db.get(docId as GenericId<string>);
        if (!doc) {
          await ctx.runMutation(component!.public.recordDelete, {
            collection: tableName,
            docId,
          });
        }
        return;
      }
      const [doc, current] = await Promise.all([
        ctx.db.get(docId as GenericId<string>),
        ctx.runQuery(component!.public.getLiveState, {
          collection: tableName,
          docId,
        }) as Promise<{ seq: number } | null>,
      ]);
      if (!doc) {
        await ctx.runMutation(component!.public.recordDelete, {
          collection: tableName,
          docId,
        });
        return;
      }
      const nextSeq = (current?.seq ?? -1) + 1;
      const crdtFields = pickCrdtFields(schemaDef, doc);
      const update = encodeDocumentState(schemaDef, crdtFields, nextSeq);
      await ctx.runMutation(component!.public.recordUpdate, {
        collection: tableName,
        docId,
        update: toArrayBuffer(update),
        docCreationTime: Number(doc._creationTime),
      });
    } catch (error) {
      log.error(`recordRemoteChange: failed for ${tableName}/${docId}`, error);
    }
  }

  hooks.detectRuntime = detectRuntime;

  hooks.afterMutation = async (ctx, def, args, result) => {
    const isRemote = await detectRuntime(ctx);
    if (!isRemote) {
      return;
    }
    await (def.remote ? def.remote(ctx, args, result) : Promise.resolve());
    const docId = extractDocId(result, args, tableName);
    if (docId) {
      await recordRemoteChange(ctx, docId);
    }
  };

  hooks.resolveHandler = async (ctx, args) => {
    const isRemote = await detectRuntime(ctx);
    if (!isRemote) {
      return {
        mode: "full" as const,
        collectionSeq: -1,
        documents: args.documents.map((doc) => ({
          docId: doc.docId,
          seq: doc.lastSeq,
        })),
      };
    }

    type LiveStateRecord = {
      docId: string;
      update: ArrayBuffer;
      seq: number;
      docCreationTime?: number;
      _creationTime?: number;
    };

    const materializeStates = async (
      rawStates: LiveStateRecord[],
      scopeArgs?: Record<string, unknown>,
    ) => {
      const canDbGet = typeof ctx.db?.get === "function";
      const documents: Array<Record<string, unknown> | null> = canDbGet
        ? await Promise.all(
            rawStates.map((state) =>
              ctx.db.get(state.docId as GenericId<string>),
            ),
          )
        : rawStates.map(() => null);

      return rawStates
        .map((state, i) => ({
          docId: state.docId,
          document:
            documents[i] ??
            materializeDocumentFromUpdate({
              schemaDef,
              docId: state.docId,
              docCreationTime:
                state.docCreationTime ?? state._creationTime ?? 0,
              update: state.update,
            }),
          seq: state.seq,
        }))
        .filter((entry) =>
          scopeArgs
            ? matchesScopeArgs(
                entry.document as Record<string, unknown>,
                scopeArgs,
              )
            : true,
        );
    };

    if (args.docIds && args.docIds.length > 0) {
      const rawLiveStates = (await ctx.runQuery(
        component!.public.getLiveStates,
        {
          collection: tableName,
          docIds: args.docIds,
        },
      )) as Array<LiveStateRecord | null>;
      const liveStatesById = new Map(
        rawLiveStates
          .filter((state): state is LiveStateRecord =>
            Boolean(state && typeof state.docId === "string"),
          )
          .map((state) => [state.docId, state] as const),
      );
      const hydrated = await materializeStates(
        Array.from(liveStatesById.values()),
      );
      const hydratedById = new Map(
        hydrated.map((entry) => [entry.docId, entry] as const),
      );

      return {
        mode: "full" as const,
        collectionSeq: -1,
        documents: args.docIds.map((docId: string) => {
          const entry = hydratedById.get(docId);
          return entry ?? { docId, deleted: true as const, seq: null };
        }),
        isDone: true,
        continueCursor: null,
      };
    }

    const collectionChanges = (await ctx.runQuery(
      component!.public.getCollectionChanges,
      {
        collection: tableName,
        sinceSeq: args.collectionSeq ?? null,
      },
    )) as {
      mode: "full" | "incremental";
      collectionSeq: number;
      changes: Array<{ docId: string; kind: "upsert" | "delete" }>;
    };

    const requestedIds = new Set(args.documents.map((doc) => doc.docId));
    const changedById = new Map(
      collectionChanges.changes.map(
        (change) => [change.docId, change.kind] as const,
      ),
    );

    const resolveFullMode = async () => {
      const scoped = args.scopeArgs && Object.keys(args.scopeArgs).length > 0;
      const knownDocIds = args.documents.map((doc) => doc.docId);
      const scopeArgs = scoped
        ? (args.scopeArgs as Record<string, unknown>)
        : undefined;

      if (args.queryPageRange) {
        const ranged = await getRangeDocIds(ctx, args.queryPageRange);
        if (ranged !== null) {
          const rawLiveStates =
            ranged.orderedDocIds.length === 0
              ? []
              : ((await ctx.runQuery(component!.public.getLiveStates, {
                  collection: tableName,
                  docIds: ranged.orderedDocIds,
                })) as Array<LiveStateRecord | null>);
          const sliceStates = rawLiveStates.filter(
            (state): state is LiveStateRecord =>
              Boolean(state && typeof state.docId === "string"),
          );
          const hydrated = await materializeStates(sliceStates, scopeArgs);
          const hydratedById = new Map(
            hydrated.map((entry) => [entry.docId, entry] as const),
          );
          const documents = ranged.orderedDocIds.flatMap((docId) => {
            const entry = hydratedById.get(docId);
            return entry ? [entry] : [];
          });
          return {
            mode: "full" as const,
            collectionSeq: collectionChanges.collectionSeq,
            continueCursor: ranged.continueCursor,
            isDone: ranged.isDone,
            documents,
          };
        }
      }

      let docIdsToHydrate: string[] | null = null;
      if (scoped && scopeArgs) {
        docIdsToHydrate = await getScopedDocIds(ctx, scopeArgs);
      }

      if (docIdsToHydrate !== null) {
        const SCOPE_FETCH_PAGE = 32;
        const fullCursor = args.fullCursor ?? null;
        const cursorOffset = parseScopeCursor(fullCursor);
        const sliceStart = cursorOffset;
        const sliceEnd = Math.min(
          docIdsToHydrate.length,
          sliceStart + SCOPE_FETCH_PAGE,
        );
        const sliceIds = docIdsToHydrate.slice(sliceStart, sliceEnd);

        const rawLiveStates =
          sliceIds.length === 0
            ? []
            : ((await ctx.runQuery(component!.public.getLiveStates, {
                collection: tableName,
                docIds: sliceIds,
              })) as Array<LiveStateRecord | null>);
        const sliceStates = rawLiveStates.filter(
          (state): state is LiveStateRecord =>
            Boolean(state && typeof state.docId === "string"),
        );
        const documents = await materializeStates(sliceStates, scopeArgs);

        const isDone = sliceEnd >= docIdsToHydrate.length;
        const continueCursor = isDone ? null : encodeScopeCursor(sliceEnd);

        return {
          mode: "full" as const,
          collectionSeq: collectionChanges.collectionSeq,
          continueCursor,
          isDone,
          documents,
        };
      }

      const page = (await ctx.runQuery(component!.public.getLiveStatesPage, {
        collection: tableName,
        cursor: args.fullCursor ?? null,
        limit: 64,
      })) as {
        page: Array<LiveStateRecord>;
        continueCursor: string | null;
        isDone: boolean;
      };
      const scopedDocuments = await materializeStates(page.page, scopeArgs);

      const missingRequestedDeletes =
        scoped && knownDocIds.length > 0 && page.isDone
          ? args.documents
              .filter(
                (doc) =>
                  !scopedDocuments.some((entry) => entry.docId === doc.docId),
              )
              .map((doc) => ({
                docId: doc.docId,
                deleted: true as const,
                seq: null,
              }))
          : [];

      return {
        mode: collectionChanges.mode,
        collectionSeq: collectionChanges.collectionSeq,
        continueCursor: page.continueCursor,
        isDone: page.isDone,
        documents: [...scopedDocuments, ...missingRequestedDeletes],
      };
    };

    if (collectionChanges.mode === "full") {
      return await resolveFullMode();
    }

    const remoteOnlyChanges =
      typeof ctx.db?.get !== "function"
        ? []
        : collectionChanges.changes.filter(
            (change) =>
              change.kind === "upsert" && !requestedIds.has(change.docId),
          );

    const needsStateDocIds: string[] = [];
    for (const doc of args.documents) {
      const changeKind = changedById.get(doc.docId);
      if (changeKind !== "delete") {
        needsStateDocIds.push(doc.docId);
      }
    }
    for (const change of remoteOnlyChanges) {
      needsStateDocIds.push(change.docId);
    }

    const rawBatchStates =
      needsStateDocIds.length === 0
        ? []
        : ((await ctx.runQuery(component!.public.getLiveStates, {
            collection: tableName,
            docIds: needsStateDocIds,
          })) as Array<{
            docId: string;
            update: ArrayBuffer;
            seq: number;
          } | null>);

    const liveStateMap = new Map<
      string,
      { update: ArrayBuffer; seq: number }
    >();
    for (const state of rawBatchStates) {
      if (state && typeof state.docId === "string") {
        liveStateMap.set(state.docId, state);
      }
    }

    const scopeDocCache = new Map<string, Record<string, unknown> | null>();
    if (args.scopeArgs && typeof ctx.db?.get === "function") {
      const upsertDocIds = args.documents
        .filter((doc) => changedById.get(doc.docId) === "upsert")
        .map((doc) => doc.docId);
      const scopeDocs = await Promise.all(
        upsertDocIds.map((id) => ctx.db.get(id as GenericId<string>)),
      );
      upsertDocIds.forEach((id, i) =>
        scopeDocCache.set(id, scopeDocs[i] ?? null),
      );
    }

    const requestedResults = args.documents.map((doc) => {
      const changeKind = changedById.get(doc.docId);
      if (changeKind === undefined) {
        const latest = liveStateMap.get(doc.docId) ?? null;
        if (!latest || latest.seq <= (doc.lastSeq ?? -1)) {
          return { docId: doc.docId, seq: doc.lastSeq };
        }
        try {
          const diff = computeDiff(
            new Uint8Array(latest.update),
            new Uint8Array(doc.vector),
          );
          if (isDiffEmpty(diff)) {
            return { docId: doc.docId, seq: latest.seq };
          }
          return {
            docId: doc.docId,
            diff: toArrayBuffer(diff),
            seq: latest.seq,
          };
        } catch {
          return { docId: doc.docId, seq: latest.seq };
        }
      }

      if (changeKind === "delete") {
        return { docId: doc.docId, deleted: true as const, seq: null };
      }

      if (args.scopeArgs && scopeDocCache.has(doc.docId)) {
        const currentDocument = scopeDocCache.get(doc.docId);
        if (
          !currentDocument ||
          !matchesScopeArgs(
            currentDocument as Record<string, unknown>,
            args.scopeArgs as Record<string, unknown>,
          )
        ) {
          return { docId: doc.docId, deleted: true as const, seq: null };
        }
      }

      const latest = liveStateMap.get(doc.docId) ?? null;
      if (!latest) {
        return { docId: doc.docId, deleted: true as const, seq: null };
      }

      try {
        const diff = computeDiff(
          new Uint8Array(latest.update),
          new Uint8Array(doc.vector),
        );
        if (isDiffEmpty(diff)) {
          return { docId: doc.docId, seq: latest.seq };
        }
        return {
          docId: doc.docId,
          diff: toArrayBuffer(diff),
          seq: latest.seq,
        };
      } catch (error) {
        log.error(
          `resolve: failed to compute diff for ${tableName}/${doc.docId}`,
          error,
        );
        return { docId: doc.docId, seq: latest.seq };
      }
    });

    const remoteOnlyDocuments =
      remoteOnlyChanges.length === 0
        ? []
        : await Promise.all(
            remoteOnlyChanges.map((change) =>
              ctx.db.get(change.docId as GenericId<string>),
            ),
          );
    const remoteOnlyResults = remoteOnlyChanges
      .map((change, i) => {
        const document = remoteOnlyDocuments[i];
        if (
          document &&
          !matchesScopeArgs(
            document as Record<string, unknown>,
            args.scopeArgs as Record<string, unknown> | undefined,
          )
        ) {
          return null;
        }
        const latest = liveStateMap.get(change.docId) ?? null;
        return document
          ? { docId: change.docId, document, seq: latest?.seq ?? null }
          : { docId: change.docId, deleted: true as const, seq: null };
      })
      .filter(
        (result): result is NonNullable<typeof result> => result !== null,
      );

    return {
      mode: collectionChanges.mode,
      collectionSeq: collectionChanges.collectionSeq,
      documents: [...requestedResults, ...remoteOnlyResults],
    };
  };

  log.debug(`bindTableRuntime("${tableName}") — version=${schemaDef.version}`);
}

/**
 * Bind runtime behavior to an embedded table's resolve query.
 *
 * This helper installs component-aware runtime hooks and tags the generated
 * resolve query with remote metadata so discovery can find it later.
 *
 * @param table - Embedded table runtime handle to bind.
 * @param component - Optional component binding that enables remote diffing.
 * @returns The table's generated resolve query tagged with remote metadata.
 */
export function bindTable(
  table: EmbeddedTableRuntimeHandle,
  component?: ComponentBinding,
): RegisteredQuery<"public", DefaultFunctionArgs, unknown> {
  bindTableRuntime(table, component);
  const planQuery = (
    table as EmbeddedTableRuntimeHandle & {
      _resolveRaw: RegisteredQuery<"public", DefaultFunctionArgs, unknown>;
    }
  )._resolveRaw;
  Object.defineProperty(planQuery, REMOTE_META, {
    value: {
      __brand: "convex-embedded:remoteMeta" as const,
      table: table.table,
      schema: table.schema,
      resolveExport: "bind",
    } satisfies RemoteMeta,
    enumerable: false,
    configurable: false,
  });
  return planQuery;
}
