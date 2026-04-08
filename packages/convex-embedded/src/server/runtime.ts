/**
 * Runtime binding for embedded tables.
 *
 * Sets hooks on table handles for component-dependent behavior (resolve
 * diffing, delta recording, runtime detection). These hooks are called
 * by the builders created in `schema.ts`.
 *
 * @internal
 */

import { Fx } from "@robelest/fx";
import type { DefaultFunctionArgs, RegisteredQuery } from "convex/server";

import type {
  ComponentBinding,
  EmbeddedTableRuntimeHandle,
  RuntimeHooks,
} from "@/server/schema";
import { REMOTE_META } from "@/shared/symbols";
import type { RemoteMeta } from "@/shared/symbols";
import { computeDiff, encodeDocumentState, isDiffEmpty } from "@/shared/yjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger(category: string) {
  const prefix = `[convex-embedded:${category}]`;
  return {
    debug: (msg: string, ...args: unknown[]) =>
      console.debug(prefix, msg, ...args),
    info: (msg: string, ...args: unknown[]) =>
      console.info(prefix, msg, ...args),
    warn: (msg: string, ...args: unknown[]) =>
      console.warn(prefix, msg, ...args),
    error: (msg: string, ...args: unknown[]) =>
      console.error(prefix, msg, ...args),
  };
}

const log = createLogger("runtime");

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return buf;
}

function extractDocId(result: any, args: any): string | null {
  if (typeof result === "string") return result;
  if (args?.id && typeof args.id === "string") return args.id;
  if (args?._id && typeof args._id === "string") return args._id;
  if (args?.docId && typeof args.docId === "string") return args.docId;
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
  } catch {
    // Fall through to plain-string matching.
  }
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

// ---------------------------------------------------------------------------
// bindTableRuntime — sets hooks on a table handle for component behavior
// ---------------------------------------------------------------------------

export function bindTableRuntime(
  handle: EmbeddedTableRuntimeHandle,
  component?: ComponentBinding,
): void {
  const tableDef = handle as any;
  const hooks: RuntimeHooks = tableDef._hooks;
  const tableName = handle.table;
  const schemaDef = handle.schema;

  if (!component) {
    log.info(`bindTableRuntime("${tableName}") — no component, local-only`);
    return;
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
    return Fx.run(
      Fx.defer(() => {
        if (
          ctx !== null &&
          (typeof ctx === "object" || typeof ctx === "function")
        ) {
          const cached = runtimeCache.get(ctx);
          if (cached !== undefined) {
            return Fx.succeed(cached);
          }
        }

        return Fx.from({
          ok: () =>
            ctx.runQuery(component!.public.getLiveStates, {
              collection: tableName,
              docIds: [],
            }),
          err: (error) => error as Error,
        }).pipe(
          Fx.tap(() =>
            Fx.sync(() => {
              log.info(
                `detectRuntime(${tableName}): component resolved -> remote`,
              );
            }),
          ),
          Fx.map(() => cacheRuntimeValue(ctx, true)),
          Fx.recover((error) => {
            if (!isComponentUnavailableError(error)) {
              return Fx.fail(error);
            }
            return Fx.sync(() => {
              log.info(
                `detectRuntime(${tableName}): component unavailable -> local`,
              );
              return cacheRuntimeValue(ctx, false);
            });
          }),
        );
      }),
    );
  }

  async function recordDeltaInline(ctx: any, docId: string): Promise<void> {
    await Fx.run(
      Fx.from({
        ok: () => ctx.db.get(docId),
        err: (error) => error as Error,
      }).pipe(
        Fx.chain((doc) => {
          if (!doc) {
            return Fx.sync(() => {
              log.warn(
                `recordDelta: document ${docId} not found in table "${tableName}"`,
              );
            });
          }
          const update = encodeDocumentState(schemaDef as any, doc);
          return Fx.from({
            ok: () =>
              ctx.runMutation(component!.public.recordUpdate, {
                collection: tableName,
                docId,
                update: toArrayBuffer(update),
              }),
            err: (error) => error as Error,
          });
        }),
        Fx.recover((error) =>
          Fx.sync(() => {
            log.error(`recordDelta: failed for ${tableName}/${docId}`, error);
          }),
        ),
        Fx.map(() => undefined as void),
      ),
    );
  }

  // Hook: detectRuntime
  hooks.detectRuntime = detectRuntime;

  // Hook: afterMutation — remote callback + delta recording
  hooks.afterMutation = async (ctx, def, args, result) => {
    await Fx.run(
      Fx.from({
        ok: () => detectRuntime(ctx),
        err: (error) => error as Error,
      }).pipe(
        Fx.chain((isRemote) => {
          if (!isRemote) {
            return Fx.unit;
          }

          return Fx.from({
            ok: () =>
              def.remote ? def.remote(ctx, args, result) : Promise.resolve(),
            err: (error) => error as Error,
          }).pipe(
            Fx.chain(() => {
              const docId = extractDocId(result, args);
              return docId
                ? Fx.from({
                    ok: () => recordDeltaInline(ctx, docId),
                    err: (error) => error as Error,
                  })
                : Fx.unit;
            }),
          );
        }),
        Fx.map(() => undefined as void),
      ),
    );
  };

  // Hook: resolveHandler — diff computation using component state
  hooks.resolveHandler = async (ctx, args) => {
    return Fx.run(
      Fx.from({
        ok: () => detectRuntime(ctx),
        err: (error) => error as Error,
      }).pipe(
        Fx.chain((isRemote) => {
          if (!isRemote) {
            return Fx.succeed(
              args.documents.map((doc) => ({ docId: doc.docId })),
            );
          }

          return Fx.from({
            ok: () =>
              ctx.runQuery(component!.public.getLiveStates, {
                collection: tableName,
              }),
            err: (error) => error as Error,
          }).pipe(
            Fx.chain((rawLiveStatesRaw) => {
              const rawLiveStates = rawLiveStatesRaw as Array<{
                docId?: string;
                update: ArrayBuffer;
                seq: number;
              } | null>;
              const liveStates = rawLiveStates.filter(
                (
                  state,
                ): state is {
                  docId: string;
                  update: ArrayBuffer;
                  seq: number;
                } => Boolean(state && typeof state.docId === "string"),
              );

              const liveStateById = new Map(
                liveStates.map((state) => [state.docId, state] as const),
              );
              const requestedIds = new Set(
                args.documents.map((doc) => doc.docId),
              );

              return Fx.each(args.documents, (doc) =>
                Fx.sync(() => {
                  const latest =
                    liveStateById.get(doc.docId) ??
                    rawLiveStates.find(
                      (
                        state,
                      ): state is {
                        docId?: string;
                        update: ArrayBuffer;
                        seq: number;
                      } =>
                        Boolean(state && typeof state.update !== "undefined"),
                    ) ??
                    null;
                  if (!latest) {
                    return { docId: doc.docId };
                  }

                  try {
                    const diff = computeDiff(
                      new Uint8Array(latest.update),
                      new Uint8Array(doc.vector),
                    );
                    if (isDiffEmpty(diff)) {
                      return { docId: doc.docId };
                    }
                    return { docId: doc.docId, diff: toArrayBuffer(diff) };
                  } catch (error) {
                    log.error(
                      `resolve: failed to compute diff for ${tableName}/${doc.docId}`,
                      error,
                    );
                    return { docId: doc.docId };
                  }
                }),
              ).pipe(
                Fx.chain((requestedResults) => {
                  const remoteOnlyStates =
                    args.scopeArgs || typeof ctx.db?.get !== "function"
                      ? []
                      : liveStates.filter(
                          (state) => !requestedIds.has(state.docId),
                        );
                  return Fx.each(remoteOnlyStates, (state) =>
                    Fx.from({
                      ok: () => ctx.db.get(state.docId),
                      err: (error) => error as Error,
                    }).pipe(
                      Fx.map((document) =>
                        document
                          ? {
                              docId: state.docId,
                              document,
                            }
                          : { docId: state.docId },
                      ),
                    ),
                  ).pipe(
                    Fx.map((remoteOnlyResults) => [
                      ...requestedResults,
                      ...remoteOnlyResults,
                    ]),
                  );
                }),
              );
            }),
          );
        }),
      ),
    );
  };

  log.info(`bindTableRuntime("${tableName}") — version=${schemaDef.version}`);
}

// ---------------------------------------------------------------------------
// bindTable — tags an existing resolve query with remote metadata
// ---------------------------------------------------------------------------

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
      listExport: null,
    } satisfies RemoteMeta,
    enumerable: false,
    configurable: false,
  });
  return resolveQuery;
}
