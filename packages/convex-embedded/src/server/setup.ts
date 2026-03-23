/**
 * embeddedTable() + setup() — the reimagined singularity API.
 *
 * `embeddedTable()` declares a synced table at schema-definition time. It
 * returns an object that satisfies `defineSchema`'s shape contract AND
 * exposes `.mutation()` / `.query()` builders that produce properly
 * registered Convex functions. Each call registers the table in a
 * module-level registry.
 *
 * `setup()` is an optional, side-effect-only call (e.g. in
 * `convex/embedded.ts`). It binds the component reference to every
 * table handle so that CRDT delta recording and resolve queries work
 * against the real component. Function registration does NOT depend on
 * `setup()` — `.mutation()` and `.query()` use `mutationGeneric` /
 * `queryGeneric` directly.
 *
 * @example
 * ```ts
 * // convex/schema.ts
 * import { embeddedTable } from "@robelest/convex-embedded/server";
 * import { schema } from "@robelest/convex-embedded/crdt";
 * import { defineSchema, defineTable } from "convex/server";
 * import { v } from "convex/values";
 *
 * export const tasks = embeddedTable("tasks", {
 *   title: schema.register(v.string()),
 *   body:  schema.register(v.string()),
 *   done:  v.boolean(),
 * });
 *
 * export default defineSchema({
 *   tasks,
 *   analytics: defineTable({ event: v.string() }),
 * });
 * ```
 *
 * ```ts
 * // convex/embedded.ts — binds the component for CRDT sync
 * import { setup } from "@robelest/convex-embedded/server";
 * import { components } from "./_generated/api";
 *
 * setup({ component: components.embedded });
 * ```
 *
 * ```ts
 * // convex/tasks.ts — no import of embedded.ts needed
 * import { tasks } from "./schema";
 * import { v } from "convex/values";
 *
 * export const create = tasks.mutation({
 *   args: { title: v.string(), body: v.string() },
 *   handler: async (ctx, args) => ctx.db.insert("tasks", args),
 * });
 *
 * export const list = tasks.query({
 *   args: {},
 *   handler: async (ctx) => ctx.db.query("tasks").collect(),
 * });
 * ```
 *
 * @module
 */
import { Fx } from "@robelest/fx";
import type {
  ArgsArrayForOptionalValidator,
  ArgsArrayToObject,
  DefaultArgsForOptionalValidator,
  DefaultFunctionArgs,
  FunctionReference,
  GenericMutationCtx,
  GenericQueryCtx,
  RegisteredMutation,
  RegisteredQuery,
  ReturnValueForOptionalValidator,
  TableDefinition,
} from "convex/server";
import { defineTable, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import type { PropertyValidators, Validator } from "convex/values";

import type { Definition } from "@/server/schema";
import {
  define,
  isCrdtField,
  encodeDocumentState,
  computeDiff,
  isDiffEmpty,
} from "@/server/schema";
import { createLogger } from "@/shared/logger";
import { markRemoteOnly } from "@/shared/remote-only";

const log = createLogger("setup");

// ---------------------------------------------------------------------------
// Module-level registry
// ---------------------------------------------------------------------------

/**
 * Global registry of all tables declared with `embeddedTable()`.
 *
 * Populated at import time (schema definition), read by `setup()` at
 * initialization time. The browser-side discovery reads this registry
 * via `getTableRegistry()` instead of scanning module exports.
 *
 * @internal
 */
const _registry = new Map<string, EmbeddedTableHandle>();

/**
 * Pending config stored by `setup()`.
 *
 * When `setup()` runs before `embeddedTable()` (e.g. due to ESM
 * evaluation order in test environments), the config is stored here.
 * Subsequent `embeddedTable()` calls auto-bind using this config so
 * that evaluation order between `schema.ts` and `embedded.ts` does
 * not matter.
 *
 * @internal
 */
let _pendingConfig: SetupConfig | undefined;

/**
 * Read-only snapshot of the table registry.
 *
 * Used by the browser entry point for auto-discovery and by `setup()`
 * to bind builders.
 *
 * @internal
 */
export function getTableRegistry(): ReadonlyMap<string, EmbeddedTableHandle> {
  return _registry;
}

/**
 * Clear the module-level registry. For tests only.
 *
 * @internal
 */
export function _resetRegistry(): void {
  _registry.clear();
  _pendingConfig = undefined;
}

// ---------------------------------------------------------------------------
// REMOTE_META — cross-package discovery symbol
// ---------------------------------------------------------------------------

/**
 * Global symbol used to tag the `resolve` export with remote metadata.
 *
 * @deprecated — The registry-based discovery in `embeddedTable()` +
 * `setup()` replaces symbol scanning. Kept for backward compatibility
 * with existing deployed modules.
 *
 * @internal
 */
export const REMOTE_META = Symbol.for("convex-embedded:remoteMeta");
export const RESOLVE_QUERY_META = Symbol.for(
  "convex-embedded:resolveQueryMeta",
);

export { REMOTE_ONLY } from "@/shared/remote-only";

/**
 * Mark a function as remote-only.
 *
 * A function wrapped with `remoteOnly()` is never executed in the local
 * embedded runtime. Browser routing sends calls directly to the remote
 * Convex client, and local execution paths reject if reached.
 */
export function remoteOnly<T>(fn: T): T {
  return markRemoteOnly(fn);
}

/**
 * Sync metadata attached to the `resolve` export.
 *
 * @internal — consumed by the client-side resolve engine during
 * auto-discovery. App code never reads this directly.
 */
export interface RemoteMeta {
  readonly __brand: "convex-embedded:remoteMeta";
  readonly table: string;
  readonly schema: Definition;
  readonly resolveExport: string;
  readonly listExport: string | null;
}

export interface ResolveQueryMeta {
  readonly __brand: "convex-embedded:resolveQueryMeta";
  readonly table: string;
  readonly getArgs?: () => Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely convert a Uint8Array to a proper ArrayBuffer. */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return buf;
}

/** Extract a document ID from mutation result or args. */
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
    insertDelta: FunctionReference<"mutation", any>;
    getLatestDelta: FunctionReference<"query", any>;
    getLatestDeltas: FunctionReference<"query", any>;
    cleanup: FunctionReference<"mutation", any>;
  };
}

/**
 * Configuration for {@link setup}.
 *
 * Call once per app in `convex/embedded.ts`. Binds the component
 * reference to every table in the registry so that CRDT delta
 * recording and resolve queries work against the real component.
 *
 * Function registration does not depend on `setup()`. The
 * `.mutation()` and `.query()` builders use `mutationGeneric` /
 * `queryGeneric` from `convex/server` directly.
 */
export interface SetupConfig {
  /** Convex component reference (`components.embedded`). */
  component?: ResolveComponentApi;
}

/**
 * The handle returned by `embeddedTable()`.
 *
 * Doubles as a valid shape entry for `defineSchema()` (via the stored
 * validators) and as a builder for per-table mutations and queries.
 */
export interface EmbeddedTableHandle {
  /** Table name. */
  readonly table: string;
  /** Schema definition (CRDT metadata, version, shape). */
  readonly schema: Definition;

  /**
   * The auto-generated resolve query. Tagged with {@link REMOTE_META}.
   * After `setup()` runs this is a registered Convex query; before
   * `setup()` it is a raw `{ args, handler }` definition.
   */
  resolve: RegisteredQuery<"public", DefaultFunctionArgs, any>;

  /**
   * Wrap a mutation with delta recording and `remote:` support.
   *
   * On remote Convex: runs handler -> `remote:` block -> records delta.
   * On local embedded: runs handler only.
   */
  mutation: EmbeddedMutationBuilder;

  /**
   * Wrap a query with `remote:` support.
   *
   * On remote Convex: runs handler -> `remote:` block.
   * On local embedded: runs handler only.
   */
  query: EmbeddedQueryBuilder;
}

type EmbeddedMutationBuilder = <
  ArgsValidator extends
    | PropertyValidators
    | Validator<any, "required", any>
    | void,
  ReturnsValidator extends
    | PropertyValidators
    | Validator<any, "required", any>
    | void,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
    DefaultArgsForOptionalValidator<ArgsValidator>,
>(def: {
  args?: ArgsValidator;
  returns?: ReturnsValidator;
  handler: (
    ctx: GenericMutationCtx<any>,
    ...args: OneOrZeroArgs
  ) =>
    | ReturnValueForOptionalValidator<ReturnsValidator>
    | Promise<ReturnValueForOptionalValidator<ReturnsValidator>>;
  remote?: (
    ctx: GenericMutationCtx<any>,
    args: ArgsArrayToObject<OneOrZeroArgs>,
    result: Awaited<ReturnValueForOptionalValidator<ReturnsValidator>>,
  ) => unknown;
}) => RegisteredMutation<
  "public",
  ArgsArrayToObject<OneOrZeroArgs>,
  ReturnValueForOptionalValidator<ReturnsValidator>
>;

type EmbeddedQueryBuilder = <
  ArgsValidator extends
    | PropertyValidators
    | Validator<any, "required", any>
    | void,
  ReturnsValidator extends
    | PropertyValidators
    | Validator<any, "required", any>
    | void,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
    DefaultArgsForOptionalValidator<ArgsValidator>,
>(def: {
  args?: ArgsValidator;
  returns?: ReturnsValidator;
  handler: (
    ctx: GenericQueryCtx<any>,
    ...args: OneOrZeroArgs
  ) =>
    | ReturnValueForOptionalValidator<ReturnsValidator>
    | Promise<ReturnValueForOptionalValidator<ReturnsValidator>>;
  remote?: (
    ctx: GenericQueryCtx<any>,
    args: ArgsArrayToObject<OneOrZeroArgs>,
    result: Awaited<ReturnValueForOptionalValidator<ReturnsValidator>>,
  ) =>
    | Awaited<ReturnValueForOptionalValidator<ReturnsValidator>>
    | Promise<Awaited<ReturnValueForOptionalValidator<ReturnsValidator>>>;
}) => RegisteredQuery<
  "public",
  ArgsArrayToObject<OneOrZeroArgs>,
  ReturnValueForOptionalValidator<ReturnsValidator>
>;

// ---------------------------------------------------------------------------
// embeddedTable()
// ---------------------------------------------------------------------------

/**
 * Extract the raw Convex validator from a shape entry.
 *
 * CRDT field descriptors carry a `.validator` property; plain values
 * (from `v.string()`, etc.) are already validators.
 */
function extractValidator(value: unknown): any {
  if (isCrdtField(value)) return value.validator;
  return value;
}

/**
 * Declare a synced table.
 *
 * Call at schema-definition time (typically in `convex/schema.ts`).
 * The shape mixes CRDT field descriptors (`schema.register(v)`,
 * `schema.prose()`, etc.) with plain Convex validators (`v.boolean()`).
 * Plain validators become last-write-wins fields.
 *
 * The return value IS a `TableDefinition` (from `defineTable`) with
 * `.mutation()`, `.query()`, `.table`, and `.schema` patched on. Pass
 * it directly to `defineSchema()` — Convex sees a normal table.
 *
 * @param table - Table name (must match the key used in `defineSchema`).
 * @param shape - Field shape. Each value is either a CRDT descriptor
 *   (from `schema.*`) or a plain Convex validator (from `v.*`).
 * @param options - Optional version and history for migration support.
 */
export function embeddedTable(
  tableName: string,
  shape: Record<string, unknown>,
  options?: {
    version?: number;
    history?: Record<number, Record<string, unknown>>;
    defaults?: Record<string, unknown>;
  },
): TableDefinition & EmbeddedTableHandle {
  // Build the Definition from the shape.
  const schemaDef = define({
    version: options?.version ?? 1,
    shape,
    history: options?.history,
    defaults: options?.defaults,
  });

  // Extract raw validators for Convex's defineTable().
  const validators: Record<string, any> = {};
  for (const [key, value] of Object.entries(shape)) {
    validators[key] = extractValidator(value);
  }

  // Create a real TableDefinition that satisfies defineSchema().
  const tableDef = defineTable(validators) as any;

  // --- Component slot (filled by setup()) ---
  let _component: ResolveComponentApi | undefined;
  let _bound = false;

  // Runtime detection — cached per Convex ctx so transient failures do not
  // poison future calls made with a different runtime context.
  const _runtimeCache = new WeakMap<object, boolean>();

  async function detectRuntime(ctx: any): Promise<boolean> {
    if (!_component) {
      return false;
    }

    if (
      ctx !== null &&
      (typeof ctx === "object" || typeof ctx === "function")
    ) {
      const cached = _runtimeCache.get(ctx);
      if (cached !== undefined) {
        return cached;
      }
    }

    const isRemote = await Fx.run(
      Fx.from({
        ok: () =>
          ctx.runQuery(_component!.public.getLatestDeltas, {
            collection: tableName,
            docIds: [],
          }),
        err: (e) => e,
      }).pipe(
        Fx.fold({
          ok: () => {
            log.info(
              `detectRuntime(${tableName}): component resolved → remote`,
            );
            return true;
          },
          err: () => {
            log.info(
              `detectRuntime(${tableName}): component unavailable → local`,
            );
            return false;
          },
        }),
      ),
    );

    if (
      ctx !== null &&
      (typeof ctx === "object" || typeof ctx === "function")
    ) {
      _runtimeCache.set(ctx, isRemote);
    }

    return isRemote;
  }

  // Record delta inline.
  async function recordDeltaInline(ctx: any, docId: string): Promise<void> {
    await Fx.run(
      Fx.from({
        ok: async () => {
          const doc = await ctx.db.get(docId);
          if (!doc) {
            log.warn(
              `recordDelta: document ${docId} not found in table "${tableName}"`,
            );
            return;
          }

          const update = encodeDocumentState(schemaDef, doc);

          await ctx.runMutation(_component!.public.insertDelta, {
            collection: tableName,
            docId,
            update: toArrayBuffer(update),
          });

          log.debug(
            `recordDelta: recorded delta for ${tableName}/${docId} (${update.byteLength} bytes)`,
          );
        },
        err: (err) => err,
      }).pipe(
        Fx.inspect((err) =>
          Fx.sync(() =>
            log.error(`recordDelta: failed for ${tableName}/${docId}`, err),
          ),
        ),
        Fx.recover(() => Fx.unit),
      ),
    );
  }

  // Resolve definition — auto-generated CRDT catch-up query.
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
        _component!.public.getLatestDeltas,
        { collection: tableName, docIds },
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
                    `resolve: failed to compute diff for ${tableName}/${docId}`,
                    err,
                  ),
                ),
              ),
              Fx.recover(() =>
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

  // --- Patch methods onto the TableDefinition instance ---

  // Build resolve as a registered Convex query immediately.
  tableDef._resolveRaw = queryGeneric(resolveDefinition);
  tagResolve(tableDef._resolveRaw);

  Object.defineProperty(tableDef, "table", {
    value: tableName,
    enumerable: false,
    configurable: false,
  });

  Object.defineProperty(tableDef, "schema", {
    value: schemaDef,
    enumerable: false,
    configurable: false,
  });

  Object.defineProperty(tableDef, "resolve", {
    get() {
      return tableDef._resolveRaw;
    },
    set(val: any) {
      tableDef._resolveRaw = val;
    },
    enumerable: false,
    configurable: true,
  });

  // Tag resolve with RemoteMeta for remote discovery.
  function tagResolve(resolveObj: any): void {
    Object.defineProperty(resolveObj, REMOTE_META, {
      value: {
        __brand: "convex-embedded:remoteMeta" as const,
        table: tableName,
        schema: schemaDef,
        resolveExport: "resolve",
        listExport: null,
      } satisfies RemoteMeta,
      enumerable: false,
      configurable: false,
    });
  }

  // mutation()
  tableDef.mutation = function mutationBuilder<
    ArgsValidator extends
      | PropertyValidators
      | Validator<any, "required", any>
      | void,
    ReturnsValidator extends
      | PropertyValidators
      | Validator<any, "required", any>
      | void,
    OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
      DefaultArgsForOptionalValidator<ArgsValidator>,
  >(def: {
    args?: ArgsValidator;
    returns?: ReturnsValidator;
    handler: (
      ctx: GenericMutationCtx<any>,
      ...args: OneOrZeroArgs
    ) =>
      | ReturnValueForOptionalValidator<ReturnsValidator>
      | Promise<ReturnValueForOptionalValidator<ReturnsValidator>>;
    remote?: (
      ctx: GenericMutationCtx<any>,
      args: ArgsArrayToObject<OneOrZeroArgs>,
      result: Awaited<ReturnValueForOptionalValidator<ReturnsValidator>>,
    ) => unknown;
  }): RegisteredMutation<
    "public",
    ArgsArrayToObject<OneOrZeroArgs>,
    ReturnValueForOptionalValidator<ReturnsValidator>
  > {
    const { args, returns, handler, remote } = def;
    const tupleArgs = (
      fnArgs: ArgsArrayToObject<OneOrZeroArgs>,
    ): OneOrZeroArgs => [fnArgs] as unknown as OneOrZeroArgs;

    return mutationGeneric({
      args,
      ...(returns !== undefined ? { returns } : {}),
      handler: async (ctx: GenericMutationCtx<any>, fnArgs: any) => {
        const result = await handler(ctx, ...tupleArgs(fnArgs));

        const isRemote =
          remote || _component ? await detectRuntime(ctx) : false;

        if (isRemote && remote) {
          await remote(ctx, fnArgs, result);
        }

        if (isRemote && _component) {
          const docId = extractDocId(result, fnArgs);
          if (docId) {
            await recordDeltaInline(ctx, docId);
          }
        }

        return result;
      },
    } as any) as RegisteredMutation<
      "public",
      ArgsArrayToObject<OneOrZeroArgs>,
      ReturnValueForOptionalValidator<ReturnsValidator>
    >;
  };

  // query()
  tableDef.query = function queryBuilder<
    ArgsValidator extends
      | PropertyValidators
      | Validator<any, "required", any>
      | void,
    ReturnsValidator extends
      | PropertyValidators
      | Validator<any, "required", any>
      | void,
    OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
      DefaultArgsForOptionalValidator<ArgsValidator>,
  >(def: {
    args?: ArgsValidator;
    returns?: ReturnsValidator;
    handler: (
      ctx: GenericQueryCtx<any>,
      ...args: OneOrZeroArgs
    ) =>
      | ReturnValueForOptionalValidator<ReturnsValidator>
      | Promise<ReturnValueForOptionalValidator<ReturnsValidator>>;
    remote?: (
      ctx: GenericQueryCtx<any>,
      args: ArgsArrayToObject<OneOrZeroArgs>,
      result: Awaited<ReturnValueForOptionalValidator<ReturnsValidator>>,
    ) =>
      | Awaited<ReturnValueForOptionalValidator<ReturnsValidator>>
      | Promise<Awaited<ReturnValueForOptionalValidator<ReturnsValidator>>>;
    resolve?: {
      args?: () => Record<string, unknown>;
    };
  }): RegisteredQuery<
    "public",
    ArgsArrayToObject<OneOrZeroArgs>,
    ReturnValueForOptionalValidator<ReturnsValidator>
  > {
    const { args, returns, handler, remote, resolve } = def;
    const tupleArgs = (
      fnArgs: ArgsArrayToObject<OneOrZeroArgs>,
    ): OneOrZeroArgs => [fnArgs] as unknown as OneOrZeroArgs;

    const query = queryGeneric({
      args,
      ...(returns !== undefined ? { returns } : {}),
      handler: async (ctx: GenericQueryCtx<any>, fnArgs: any) => {
        let result = await handler(ctx, ...tupleArgs(fnArgs));

        if (remote) {
          const isRemote = await detectRuntime(ctx);
          if (isRemote) {
            result = await remote(ctx, fnArgs, result);
          }
        }

        return result;
      },
    } as any) as RegisteredQuery<
      "public",
      ArgsArrayToObject<OneOrZeroArgs>,
      ReturnValueForOptionalValidator<ReturnsValidator>
    >;

    if (resolve) {
      Object.defineProperty(query, RESOLVE_QUERY_META, {
        value: {
          __brand: "convex-embedded:resolveQueryMeta" as const,
          table: tableName,
          getArgs: resolve.args,
        } satisfies ResolveQueryMeta,
        enumerable: false,
        configurable: false,
      });
    }

    return query;
  };

  // Internal binding hook — called by setup().
  Object.defineProperty(tableDef, "_bind", {
    value: (config: SetupConfig) => {
      if (_bound) return;
      _component = config.component;
      _bound = true;

      log.info(
        `embeddedTable("${tableName}") bound — version=${schemaDef.version}`,
      );
    },
    enumerable: false,
    configurable: false,
  });

  // Register in the global registry.
  if (_registry.has(tableName)) {
    log.warn(
      `embeddedTable("${tableName}") called twice — overwriting previous registration`,
    );
  }
  _registry.set(tableName, tableDef as TableDefinition & EmbeddedTableHandle);

  // Late-bind: if setup() ran before this registration, apply the
  // stored config now. This handles ESM evaluation order where
  // embedded.ts (setup) is evaluated before schema.ts (embeddedTable).
  if (_pendingConfig) {
    (tableDef as any)._bind(_pendingConfig);
  }

  log.info(
    `embeddedTable("${tableName}") registered — version=${schemaDef.version}`,
  );

  return tableDef as TableDefinition & EmbeddedTableHandle;
}

// ---------------------------------------------------------------------------
// setup() — side-effect-only binding
// ---------------------------------------------------------------------------

/**
 * Bind the component reference to all registered embedded tables.
 *
 * Call once per app in a dedicated file (e.g. `convex/embedded.ts`).
 * This enables CRDT delta recording and resolve queries against the
 * real component. Function registration does not depend on this call —
 * `.mutation()` and `.query()` use `mutationGeneric` / `queryGeneric`
 * from `convex/server` directly and produce registered functions at
 * definition time.
 *
 * @param config - Component reference.
 *
 * @example
 * ```ts
 * // convex/embedded.ts
 * import { setup } from "@robelest/convex-embedded/server";
 * import { components } from "./_generated/api";
 *
 * setup({ component: components.embedded });
 * ```
 */
export function setup(config: SetupConfig): void {
  // Store the config so that tables registered after this call
  // (due to ESM evaluation order) can auto-bind.
  _pendingConfig = config;

  for (const [_table, handle] of _registry) {
    (handle as any)._bind(config);
  }
}
