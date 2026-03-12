/**
 * setup() + register() — the single entry point for convex-resolve.
 *
 * `setup()` captures app-wide config (component, Convex builders) and
 * returns a `register()` factory. `register()` returns a table descriptor
 * with `resolve`, `mutation()`, and `query()` — everything needed to wire
 * a synced table with zero plumbing exports.
 *
 * @example
 * ```ts
 * // convex/sync.ts — one-time per app
 * import { setup } from "@robelest/convex-embedded/server";
 * import { components } from "./_generated/api";
 * import { mutation, query } from "./_generated/server";
 *
 * export const register = setup({
 *   component: components.resolve,
 *   mutation,
 *   query,
 * });
 * ```
 *
 * ```ts
 * // convex/tasks.ts — per synced table
 * import { register } from "./sync";
 * import { taskSchema } from "./schema";
 *
 * const tasks = register("tasks", taskSchema);
 *
 * export const resolve = tasks.resolve;
 * export const create = tasks.mutation({
 *   args: { title: v.string() },
 *   handler: async (ctx, args) => ctx.db.insert("tasks", args),
 * });
 * export const list = tasks.query({
 *   args: {},
 *   handler: async (ctx) => ctx.db.query("tasks").collect(),
 * });
 * ```
 *
 * @module
 */
import { Fx } from "@robelest/fx";
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";

import type { Definition } from "@/server/schema";
import { encodeDocumentState, computeDiff, isDiffEmpty } from "@/server/schema";
import { createLogger } from "@/shared/logger";

const log = createLogger("setup");

// ---------------------------------------------------------------------------
// SYNC_META — cross-package discovery symbol
// ---------------------------------------------------------------------------

/**
 * Global symbol used to tag the `resolve` export with sync metadata.
 *
 * The client-side discovery in `createConvexClient()` scans module
 * exports for this symbol to auto-discover synced tables — no separate
 * `__syncMeta` export needed.
 *
 * Uses `Symbol.for()` so the symbol is shared across package boundaries
 * without requiring an explicit import.
 *
 * @internal
 */
export const SYNC_META = Symbol.for("convex-resolve:syncMeta");

/**
 * Sync metadata attached to the `resolve` export.
 *
 * @internal — consumed by the client-side resolve engine during
 * auto-discovery. App code never reads this directly.
 */
export interface SyncMeta {
  /** Sentinel flag for module scanning. */
  readonly __brand: "convex-resolve:syncMeta";
  /** Table name (e.g. `"tasks"`). */
  readonly table: string;
  /** Schema definition for Yjs encode/materialize and omit stripping. */
  readonly schema: Definition;
  /**
   * The exported name of the resolve query in this module
   * (always `"resolve"`). Used by the sync engine to build
   * the function reference at runtime.
   */
  readonly resolveExport: string;
  /**
   * The exported name of the list query that provides full-table
   * materialized results for reactive subscriptions.
   * `null` means "use `<module>:list` by convention".
   */
  readonly listExport: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely convert a Uint8Array to a proper ArrayBuffer.
 * In some runtimes (e.g. edge-runtime used by convex-test), the
 * Uint8Array.buffer property doesn't return a native ArrayBuffer,
 * so we construct a fresh one and copy the bytes.
 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return buf;
}

/**
 * Extract a document ID from mutation result or args.
 *
 * Mutations that return an Id (insert) or receive one in args
 * (patch/delete) are tracked automatically for delta recording.
 */
function extractDocId(result: any, args: any): string | null {
  if (typeof result === "string") return result;
  if (args?.id && typeof args.id === "string") return args.id;
  if (args?._id && typeof args._id === "string") return args._id;
  if (args?.docId && typeof args.docId === "string") return args.docId;
  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResolveComponentApi {
  public: {
    insertDelta: FunctionReference<"mutation">;
    getLatestDelta: FunctionReference<"query">;
    getLatestDeltas: FunctionReference<"query">;
    cleanup: FunctionReference<"mutation">;
  };
}

/**
 * Configuration for {@link setup}.
 *
 * @remarks
 * Pass this once per app — typically in `convex/sync.ts`. The returned
 * `register()` factory inherits these settings for every table.
 *
 * @example
 * ```ts
 * import { setup } from "@robelest/convex-embedded/server";
 * import { components } from "./_generated/api";
 * import { mutation, query } from "./_generated/server";
 *
 * export const register = setup({
 *   component: components.resolve,
 *   mutation,
 *   query,
 * });
 * ```
 */
export interface SetupConfig {
  /**
   * Convex component reference — required on remote, absent on local.
   *
   * `componentsGeneric()` returns a Proxy where every property access is
   * truthy, so `!!component` is always true even on the embedded runtime.
   * Runtime detection uses `detectRuntime()` at handler execution time.
   */
  component?: ResolveComponentApi;

  /**
   * The `mutation` builder from `_generated/server`.
   *
   * Used by `tasks.mutation()` to produce registered Convex mutations.
   * When absent, `tasks.mutation()` returns raw `{ args, handler }` objects
   * (useful in unit tests).
   */
  mutation?: (def: any) => any;

  /**
   * The `query` builder from `_generated/server`.
   *
   * Used by `tasks.query()` and internally to wrap `resolve`.
   * When absent, returns raw `{ args, handler }` objects.
   */
  query?: (def: any) => any;
}

/**
 * A table descriptor returned by `register()`.
 *
 * @remarks
 * Contains everything needed to define a synced table's exports:
 * a pre-wrapped `resolve` query (tagged with sync metadata for
 * client auto-discovery), and `mutation()` / `query()` builders
 * that handle delta recording and `remote:` blocks.
 *
 * @example
 * ```ts
 * const tasks = register("tasks", taskSchema);
 *
 * export const resolve = tasks.resolve;
 * export const create = tasks.mutation({
 *   args: { title: v.string() },
 *   handler: async (ctx, args) => ctx.db.insert("tasks", args),
 * });
 * ```
 */
export interface TableDescriptor {
  /**
   * Pre-wrapped resolve query — export this from your module.
   *
   * Tagged with {@link SYNC_META} for client-side auto-discovery.
   * The client scans module exports for this symbol to find synced tables.
   */
  resolve: any;

  /**
   * Wrap a mutation definition with delta recording and `remote:` support.
   *
   * On remote Convex: runs handler → runs `remote:` block (same
   * transaction) → records Yjs delta to the component.
   * On local embedded: runs handler only.
   *
   * @param def - Standard Convex mutation definition with optional `remote:` key.
   * @returns A registered Convex mutation (or raw definition if no builder was provided).
   */
  mutation(def: {
    args: Record<string, any>;
    returns?: any;
    handler: (ctx: any, args: any) => any;
    remote?: (ctx: any, args: any, result: any) => any;
  }): any;

  /**
   * Wrap a query definition with `remote:` support.
   *
   * On remote Convex: runs handler → runs `remote:` block with result.
   * On local embedded: runs handler only.
   *
   * @param def - Standard Convex query definition with optional `remote:` key.
   * @returns A registered Convex query (or raw definition if no builder was provided).
   */
  query(def: {
    args: Record<string, any>;
    returns?: any;
    handler: (ctx: any, args: any) => any;
    remote?: (ctx: any, args: any, result: any) => any;
  }): any;
}

// ---------------------------------------------------------------------------
// setup()
// ---------------------------------------------------------------------------

/**
 * Create a `register()` factory for synced tables.
 *
 * Call once per app to capture the component reference and Convex builders.
 * The returned `register(table, schema)` function creates table descriptors
 * with `resolve`, `mutation()`, and `query()`.
 *
 * @param config - App-wide configuration.
 * @returns A `register(table, schema)` factory function.
 *
 * @example
 * ```ts
 * // convex/sync.ts
 * import { setup } from "@robelest/convex-embedded/server";
 * import { components } from "./_generated/api";
 * import { mutation, query } from "./_generated/server";
 *
 * export const register = setup({
 *   component: components.resolve,
 *   mutation,
 *   query,
 * });
 * ```
 */
export function setup(config: SetupConfig) {
  const {
    component,
    mutation: baseMutation,
    query: baseQuery,
  } = config;

  /**
   * Register a table for sync.
   *
   * @param table - Table name in `convex/schema.ts`.
   * @param schema - Versioned schema definition from `schema.define()`.
   * @returns A {@link TableDescriptor} with `resolve`, `mutation()`, and `query()`.
   *
   * @example
   * ```ts
   * const tasks = register("tasks", taskSchema);
   * export const resolve = tasks.resolve;
   * export const create = tasks.mutation({ args: {...}, handler: ... });
   * ```
   */
  function register(table: string, schema: Definition): TableDescriptor {
    const schemaDef = schema;

    // Runtime detection — deferred to first handler invocation.
    // `componentsGeneric()` returns a Proxy that is truthy for every
    // property access, so we probe the component at execution time.
    let _runtimeKnown = false;
    let _isRemote = false;

    async function detectRuntime(ctx: any): Promise<boolean> {
      if (_runtimeKnown) return _isRemote;

      if (!component) {
        _runtimeKnown = true;
        _isRemote = false;
        log.info(`detectRuntime(${table}): component is falsy → local`);
        return false;
      }

      await Fx.run(
        Fx.from({
          ok: () =>
            ctx.runQuery(component.public.getLatestDeltas, {
              collection: table,
              docIds: [],
            }),
          err: (e) => e,
        }).pipe(
          Fx.fold({
            ok: () => {
              _runtimeKnown = true;
              _isRemote = true;
              log.info(`detectRuntime(${table}): component resolved → remote`);
            },
            err: () => {
              _runtimeKnown = true;
              _isRemote = false;
              log.info(
                `detectRuntime(${table}): component unavailable → local`,
              );
            },
          }),
        ),
      );

      return _isRemote;
    }

    log.info(
      `register() table="${table}" version=${schemaDef.version} (runtime detection deferred)`,
    );

    // -------------------------------------------------------------------
    // Record delta — inline helper (no longer a separate exported mutation)
    // -------------------------------------------------------------------

    async function recordDeltaInline(
      ctx: any,
      docId: string,
    ): Promise<void> {
      await Fx.run(
        Fx.from({
          ok: async () => {
            const doc = await ctx.db.get(docId);
            if (!doc) {
              log.warn(
                `recordDelta: document ${docId} not found in table "${table}"`,
              );
              return;
            }

            const update = encodeDocumentState(schemaDef, doc);

            await ctx.runMutation(component!.public.insertDelta, {
              collection: table,
              docId,
              update: toArrayBuffer(update),
            });

            log.debug(
              `recordDelta: recorded delta for ${table}/${docId} (${update.byteLength} bytes)`,
            );
          },
          err: (err) => err,
        }).pipe(
          Fx.inspect((err) =>
            Fx.sync(() =>
              log.error(`recordDelta: failed for ${table}/${docId}`, err),
            ),
          ),
          Fx.recover(() => Fx.unit),
        ),
      );
    }

    // -------------------------------------------------------------------
    // resolve — one-shot CRDT catch-up query
    // -------------------------------------------------------------------

    const resolveDefinition = {
      args: {
        documents: v.array(
          v.object({
            docId: v.string(),
            vector: v.bytes(),
          }),
        ),
      },
      handler: async (
        ctx: any,
        args: { documents: Array<{ docId: string; vector: ArrayBuffer }> },
      ): Promise<Array<{ docId: string; diff?: ArrayBuffer }>> => {
        if (!(await detectRuntime(ctx))) {
          return args.documents.map((d) => ({ docId: d.docId }));
        }

        const docIds = args.documents.map((d) => d.docId);

        const latestDeltas = await ctx.runQuery(
          component!.public.getLatestDeltas,
          { collection: table, docIds },
        );

        const results = await Fx.run(
          Fx.each(
            args.documents.map(
              (doc: { docId: string; vector: ArrayBuffer }, i: number) => ({
                ...doc,
                latest: latestDeltas[i],
              }),
            ),
            ({ docId, vector, latest }) => {
              if (!latest) {
                return Fx.succeed({ docId } as {
                  docId: string;
                  diff?: ArrayBuffer;
                });
              }

              return Fx.from({
                ok: () => {
                  const serverUpdate = new Uint8Array(latest.update);
                  const clientVector = new Uint8Array(vector);
                  const diff = computeDiff(serverUpdate, clientVector);

                  if (isDiffEmpty(diff)) {
                    return { docId } as { docId: string; diff?: ArrayBuffer };
                  }
                  return { docId, diff: toArrayBuffer(diff) } as {
                    docId: string;
                    diff?: ArrayBuffer;
                  };
                },
                err: (e) => e as Error,
              }).pipe(
                Fx.inspect((err) =>
                  Fx.sync(() =>
                    log.error(
                      `resolve: failed to compute diff for ${table}/${docId}`,
                      err,
                    ),
                  ),
                ),
                Fx.recover(
                  () =>
                    Fx.succeed({ docId } as {
                      docId: string;
                      diff?: ArrayBuffer;
                    }),
                ),
              );
            },
          ),
        );

        return results;
      },
    };

    // Wrap with the query builder if available, tag with SyncMeta.
    const resolve = baseQuery
      ? baseQuery(resolveDefinition)
      : resolveDefinition;

    // Tag with SyncMeta for client-side auto-discovery.
    Object.defineProperty(resolve, SYNC_META, {
      value: {
        __brand: "convex-resolve:syncMeta" as const,
        table,
        schema: schemaDef,
        resolveExport: "resolve",
        listExport: null,
      } satisfies SyncMeta,
      enumerable: false,
      configurable: false,
    });

    // -------------------------------------------------------------------
    // mutation() — wraps a mutation with delta recording + remote: key
    // -------------------------------------------------------------------

    function mutation(def: {
      args: Record<string, any>;
      returns?: any;
      handler: (ctx: any, args: any) => any;
      remote?: (ctx: any, args: any, result: any) => any;
    }): any {
      const { args, returns, handler, remote } = def;

      const functionDef: any = {
        args,
        ...(returns !== undefined ? { returns } : {}),
        handler: async (ctx: any, fnArgs: any) => {
          // 1. Run the app handler.
          const result = await handler(ctx, fnArgs);

          // 2. Detect runtime — skip if no remote: block and no component.
          const isRemote = (remote || component)
            ? await detectRuntime(ctx)
            : false;

          // 3. On remote, run the remote: block in the same transaction.
          if (isRemote && remote) {
            await remote(ctx, fnArgs, result);
          }

          // 4. On remote, record the Yjs delta inline (same transaction).
          if (isRemote && component) {
            const docId = extractDocId(result, fnArgs);
            if (docId) {
              await recordDeltaInline(ctx, docId);
            }
          }

          return result;
        },
      };

      return baseMutation ? baseMutation(functionDef) : functionDef;
    }

    // -------------------------------------------------------------------
    // query() — wraps a query with remote: key support
    // -------------------------------------------------------------------

    function query(def: {
      args: Record<string, any>;
      returns?: any;
      handler: (ctx: any, args: any) => any;
      remote?: (ctx: any, args: any, result: any) => any;
    }): any {
      const { args, returns, handler, remote } = def;

      const functionDef: any = {
        args,
        ...(returns !== undefined ? { returns } : {}),
        handler: async (ctx: any, fnArgs: any) => {
          let result = await handler(ctx, fnArgs);

          if (remote) {
            const isRemote = await detectRuntime(ctx);
            if (isRemote) {
              result = await remote(ctx, fnArgs, result);
            }
          }

          return result;
        },
      };

      return baseQuery ? baseQuery(functionDef) : functionDef;
    }

    return { resolve, mutation, query };
  }

  return register;
}
