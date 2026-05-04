/**
 * Runtime binding for embedded tables.
 *
 * Sets hooks on table handles for component-dependent behavior (resolve
 * diffing, delta recording, runtime detection). These hooks are called
 * by the builders created in `schema.ts`.
 *
 * @internal
 */

import type { DefaultFunctionArgs, RegisteredQuery } from "convex/server";

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
import {
  computeDiff,
  encodeDocumentState,
  isDiffEmpty,
  materializeDocumentFromUpdate,
} from "@/shared/yjs";

const log = createLogger("server-runtime");

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return buf;
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

function extractDocId(result: any, args: any): string | null {
  if (typeof result === "string") return result;
  if (args?.id && typeof args.id === "string") return args.id;
  if (args?._id && typeof args._id === "string") return args._id;
  if (args?.docId && typeof args.docId === "string") return args.docId;
  if (args && typeof args === "object") {
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" && /(^|[a-zA-Z])Id$/.test(key)) {
        return value;
      }
    }
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

export function bindTableRuntime(
  handle: EmbeddedTableRuntimeHandle,
  component?: ComponentBinding,
): void {
  const tableDef = handle as any;
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
  async function resolveScopedDocIds(
    ctx: any,
    scopeArgs: Record<string, unknown>,
  ): Promise<string[] | null> {
    const match = pickIndex(scopeArgs);
    if (!match) return null;
    try {
      const docs = (await ctx.db
        .query(tableName)
        .withIndex(match.indexName, (q: any) => {
          let chain = q;
          for (const field of match.fields) {
            chain = chain.eq(field, scopeArgs[field]);
          }
          return chain;
        })
        .collect()) as Array<{ _id: string }>;
      return docs.map((doc) => doc._id);
    } catch (error) {
      log.warn(
        `resolveScopedDocIds(${tableName}, ${match.indexName}): failed`,
        error,
      );
      return null;
    }
  }

  const runtimeCache = new WeakMap<object, boolean>();

  function cacheRuntimeValue(ctx: any, isRemote: boolean): boolean {
    if (
      ctx !== null &&
      (typeof ctx === "object" || typeof ctx === "function")
    ) {
      runtimeCache.set(ctx, isRemote);
    }
    return isRemote;
  }

  async function detectRuntime(ctx: any): Promise<boolean> {
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

  async function recordRemoteChange(ctx: any, docId: string): Promise<void> {
    try {
      const doc = await ctx.db.get(docId);
      if (!doc) {
        await ctx.runMutation(component!.public.recordDelete, {
          collection: tableName,
          docId,
        });
        return;
      }
      if (!hasCrdtFields(schemaDef)) {
        log.debug(
          `recordRemoteChange(${tableName}/${docId}): no CRDT fields, skipping recordUpdate`,
        );
        return;
      }
      const current = (await ctx.runQuery(component!.public.getLiveState, {
        collection: tableName,
        docId,
      })) as { seq: number } | null;
      const nextSeq = (current?.seq ?? -1) + 1;
      const crdtFields = pickCrdtFields(schemaDef, doc);
      const update = encodeDocumentState(schemaDef as any, crdtFields, nextSeq);
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
    const docId = extractDocId(result, args);
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

    if (collectionChanges.mode === "full") {
      type LiveStateRecord = {
        docId: string;
        update: ArrayBuffer;
        seq: number;
        docCreationTime?: number;
        _creationTime?: number;
      };
      const scoped = args.scopeArgs && Object.keys(args.scopeArgs).length > 0;
      const knownDocIds = args.documents.map((doc) => doc.docId);
      const scopeArgs = scoped
        ? (args.scopeArgs as Record<string, unknown>)
        : undefined;

      let docIdsToHydrate: string[] | null = null;
      if (scoped && scopeArgs) {
        docIdsToHydrate = await resolveScopedDocIds(ctx, scopeArgs);
      }

      const materializeStates = async (rawStates: LiveStateRecord[]) =>
        (
          await Promise.all(
            rawStates.map(async (state) => {
              const currentDocument =
                typeof ctx.db?.get === "function"
                  ? await ctx.db.get(state.docId)
                  : null;
              return {
                docId: state.docId,
                document:
                  currentDocument ??
                  materializeDocumentFromUpdate({
                    schemaDef,
                    docId: state.docId,
                    docCreationTime:
                      state.docCreationTime ?? state._creationTime ?? 0,
                    update: state.update,
                  }),
                seq: state.seq,
              };
            }),
          )
        ).filter((entry) =>
          scopeArgs
            ? matchesScopeArgs(
                entry.document as Record<string, unknown>,
                scopeArgs,
              )
            : true,
        );

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
        const documents = await materializeStates(sliceStates);

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

      const page = (await ctx.runQuery(
        component!.public.getLiveStatesPage,
        {
          collection: tableName,
          cursor: args.fullCursor ?? null,
          limit: 64,
        },
      )) as {
        page: Array<LiveStateRecord>;
        continueCursor: string | null;
        isDone: boolean;
      };
      const scopedDocuments = await materializeStates(page.page);

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
    }

    const requestedResults = await Promise.all(
      args.documents.map(async (doc) => {
        const changeKind = changedById.get(doc.docId);
        if (changeKind === undefined) {
          const latest = (await ctx.runQuery(component!.public.getLiveState, {
            collection: tableName,
            docId: doc.docId,
          })) as { update: ArrayBuffer; seq: number } | null;
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

        if (args.scopeArgs && typeof ctx.db?.get === "function") {
          const currentDocument = await ctx.db.get(doc.docId);
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

        const latest = (await ctx.runQuery(component!.public.getLiveState, {
          collection: tableName,
          docId: doc.docId,
        })) as { update: ArrayBuffer; seq: number } | null;
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
      }),
    );

    const remoteOnlyChanges =
      typeof ctx.db?.get !== "function"
        ? []
        : collectionChanges.changes.filter(
            (change) =>
              change.kind === "upsert" && !requestedIds.has(change.docId),
          );
    const remoteOnlyResults = await Promise.all(
      remoteOnlyChanges.map(async (change) => {
        const document = await ctx.db.get(change.docId);
        if (
          document &&
          !matchesScopeArgs(
            document as Record<string, unknown>,
            args.scopeArgs as Record<string, unknown> | undefined,
          )
        ) {
          return null;
        }
        const latest = (await ctx.runQuery(component!.public.getLiveState, {
          collection: tableName,
          docId: change.docId,
        })) as { update: ArrayBuffer; seq: number } | null;
        return document
          ? { docId: change.docId, document, seq: latest?.seq ?? null }
          : { docId: change.docId, deleted: true as const, seq: null };
      }),
    );
    return {
      mode: collectionChanges.mode,
      collectionSeq: collectionChanges.collectionSeq,
      documents: [
        ...requestedResults,
        ...remoteOnlyResults.filter(
          (result): result is NonNullable<typeof result> => result !== null,
        ),
      ],
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
): RegisteredQuery<"public", DefaultFunctionArgs, any> {
  bindTableRuntime(table, component);
  const resolveQuery = (table as any)._resolveRaw;
  Object.defineProperty(resolveQuery, REMOTE_META, {
    value: {
      __brand: "convex-embedded:remoteMeta" as const,
      table: table.table,
      schema: table.schema,
      resolveExport: "bind",
    } satisfies RemoteMeta,
    enumerable: false,
    configurable: false,
  });
  return resolveQuery;
}
