import type {
  ArgsArrayForOptionalValidator,
  ArgsArrayToObject,
  DefaultArgsForOptionalValidator,
  DefaultFunctionArgs,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  RegisteredMutation,
  RegisteredQuery,
  ReturnValueForOptionalValidator,
  TableDefinition,
} from "convex/server";
import { defineTable, mutationGeneric, queryGeneric } from "convex/server";
import type { GenericValidator, PropertyValidators } from "convex/values";
import { v } from "convex/values";

import type { MigrationsMap } from "@/shared/migrations/types";
import type { FieldRef } from "@/shared/types";

import {
  define,
  type Definition,
  type FieldKindForDescriptor,
  type FieldValueForDescriptor,
} from "./core.js";
import { extractValidator } from "./fields.js";
import {
  PENDING_REPLAY_META,
  type PendingReplayMeta,
  type PendingReplayMigrationStep,
  REMOTE_META,
  type RemoteMeta,
} from "./meta.js";

type EmbeddedIndexMethod = (name: string, fields: string[]) => unknown;
type EmbeddedSearchIndexMethod = (...args: unknown[]) => unknown;
type EmbeddedVectorIndexMethod = (...args: unknown[]) => unknown;

/**
 * Mutation builder attached to an embedded table handle.
 */
export type EmbeddedMutationBuilder = <
  ArgsValidator extends PropertyValidators | GenericValidator | void,
  ReturnsValidator extends PropertyValidators | GenericValidator | void,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
    DefaultArgsForOptionalValidator<ArgsValidator>,
>(def: {
  args?: ArgsValidator;
  returns?: ReturnsValidator;
  handler: (
    ctx: GenericMutationCtx<GenericDataModel>,
    ...args: OneOrZeroArgs
  ) =>
    | ReturnValueForOptionalValidator<ReturnsValidator>
    | Promise<ReturnValueForOptionalValidator<ReturnsValidator>>;
  remote?: (
    ctx: GenericMutationCtx<GenericDataModel>,
    args: ArgsArrayToObject<OneOrZeroArgs>,
    result: Awaited<ReturnValueForOptionalValidator<ReturnsValidator>>,
  ) => unknown;
  replay?: {
    version?: number;
    migrate?: Record<number, PendingReplayMigrationStep>;
  };
}) => RegisteredMutation<
  "public",
  ArgsArrayToObject<OneOrZeroArgs>,
  ReturnValueForOptionalValidator<ReturnsValidator>
>;

/**
 * Query builder attached to an embedded table handle.
 */
export type EmbeddedQueryBuilder = <
  ArgsValidator extends PropertyValidators | GenericValidator | void,
  ReturnsValidator extends PropertyValidators | GenericValidator | void,
  OneOrZeroArgs extends ArgsArrayForOptionalValidator<ArgsValidator> =
    DefaultArgsForOptionalValidator<ArgsValidator>,
>(def: {
  args?: ArgsValidator;
  returns?: ReturnsValidator;
  handler: (
    ctx: GenericQueryCtx<GenericDataModel>,
    ...args: OneOrZeroArgs
  ) =>
    | ReturnValueForOptionalValidator<ReturnsValidator>
    | Promise<ReturnValueForOptionalValidator<ReturnsValidator>>;
  remote?: (
    ctx: GenericQueryCtx<GenericDataModel>,
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

/**
 * Runtime-facing table handle shared by typed and untyped embedded tables.
 */
export interface EmbeddedTableRuntimeHandle {
  /** Canonical table name. */
  readonly table: string;
  /** Normalized embedded schema definition. */
  readonly schema: Definition;
  /** Generated resolve query used by the remote sync engine. */
  resolve: RegisteredQuery<"public", DefaultFunctionArgs, unknown>;
  /** Table-scoped mutation builder. */
  mutation: EmbeddedMutationBuilder;
  /** Table-scoped query builder. */
  query: EmbeddedQueryBuilder;
  /** Build a typed field reference for CRDT helper APIs. */
  field(id: string, field: string): FieldRef<string, string, unknown, string>;
}

/**
 * Typed embedded table handle used by application code.
 *
 * @typeParam TableName - Canonical table name.
 * @typeParam Shape - Embedded field descriptor map.
 */
export interface EmbeddedTableHandle<
  TableName extends string = string,
  Shape extends Record<string, unknown> = Record<string, unknown>,
> extends EmbeddedTableRuntimeHandle {
  readonly table: TableName;
  field<FieldName extends Extract<keyof Shape, string>>(
    id: string,
    field: FieldName,
  ): FieldRef<
    TableName,
    FieldName,
    FieldValueForDescriptor<Shape[FieldName]>,
    FieldKindForDescriptor<Shape[FieldName]>
  >;
}

type EmbeddedIndexFn<
  TableName extends string,
  Shape extends Record<string, unknown>,
> = TableDefinition["index"] &
  ((
    ...args: Parameters<EmbeddedIndexMethod>
  ) => EmbeddedTable<TableName, Shape>);

type EmbeddedSearchIndexFn<
  TableName extends string,
  Shape extends Record<string, unknown>,
> = TableDefinition["searchIndex"] &
  ((
    ...args: Parameters<EmbeddedSearchIndexMethod>
  ) => EmbeddedTable<TableName, Shape>);

type EmbeddedVectorIndexFn<
  TableName extends string,
  Shape extends Record<string, unknown>,
> = TableDefinition["vectorIndex"] &
  ((
    ...args: Parameters<EmbeddedVectorIndexMethod>
  ) => EmbeddedTable<TableName, Shape>);

/**
 * Full embedded table type returned by `embeddedTable(...)`.
 */
export type EmbeddedTable<
  TableName extends string = string,
  Shape extends Record<string, unknown> = Record<string, unknown>,
> = TableDefinition &
  EmbeddedTableHandle<TableName, Shape> & {
    index: EmbeddedIndexFn<TableName, Shape>;
    searchIndex: EmbeddedSearchIndexFn<TableName, Shape>;
    vectorIndex: EmbeddedVectorIndexFn<TableName, Shape>;
  };

/** Definition object accepted by the runtime mutation builder. */
interface EmbeddedMutationDef {
  args?: PropertyValidators | GenericValidator;
  returns?: PropertyValidators | GenericValidator;
  handler: (
    ctx: GenericMutationCtx<GenericDataModel>,
    args: DefaultFunctionArgs,
  ) => unknown;
  remote?: (
    ctx: GenericMutationCtx<GenericDataModel>,
    args: DefaultFunctionArgs,
    result: unknown,
  ) => unknown;
  replay?: {
    version?: number;
    migrate?: Record<number, PendingReplayMigrationStep>;
  };
}

/** Definition object accepted by the runtime query builder. */
interface EmbeddedQueryDef {
  args?: PropertyValidators | GenericValidator;
  returns?: PropertyValidators | GenericValidator;
  handler: (
    ctx: GenericQueryCtx<GenericDataModel>,
    args: DefaultFunctionArgs,
  ) => unknown;
  remote?: (
    ctx: GenericQueryCtx<GenericDataModel>,
    args: DefaultFunctionArgs,
    result: unknown,
  ) => unknown;
}

export interface RuntimeHooks {
  afterMutation?: (
    ctx: GenericMutationCtx<GenericDataModel>,
    def: EmbeddedMutationDef,
    args: DefaultFunctionArgs,
    result: unknown,
  ) => Promise<void>;
  resolveHandler?: (
    ctx: GenericQueryCtx<GenericDataModel>,
    args: {
      collectionSeq: number | null;
      documents: Array<{
        docId: string;
        vector: ArrayBuffer;
        lastSeq: number | null;
      }>;
      docIds?: string[];
      scopeArgs?: Record<string, unknown>;
      fullCursor?: string | null;
    },
  ) => Promise<{
    mode: "full" | "incremental";
    collectionSeq: number;
    documents: Array<{
      docId: string;
      seq: number | null;
      diff?: ArrayBuffer;
      document?: Record<string, unknown>;
      deleted?: true;
    }>;
    continueCursor?: string | null;
    isDone?: boolean;
  }>;
  detectRuntime?: (ctx: GenericQueryCtx<GenericDataModel>) => Promise<boolean>;
}

/**
 * The Convex `defineTable` result monkey-patched with the embedded table's
 * runtime members. The base builder doesn't expose these, so the boundary cast
 * is centralized here.
 */
interface PatchableTableDef {
  index?: (name: string, fields: string[]) => unknown;
  searchIndex?: (...args: unknown[]) => unknown;
  vectorIndex?: (...args: unknown[]) => unknown;
  _resolveRaw: RegisteredQuery<"public", DefaultFunctionArgs, unknown>;
  mutation: (
    def: EmbeddedMutationDef,
  ) => RegisteredMutation<"public", DefaultFunctionArgs, unknown>;
  query: (
    def: EmbeddedQueryDef,
  ) => RegisteredQuery<"public", DefaultFunctionArgs, unknown>;
}

const REGISTRY_KEY: unique symbol = Symbol.for(
  "convex-embedded:table-registry",
);

const globalWithRegistry = globalThis as typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, EmbeddedTableRuntimeHandle>;
};

const registry: Map<string, EmbeddedTableRuntimeHandle> = (globalWithRegistry[
  REGISTRY_KEY
] ??= new Map());

/**
 * Read the current global embedded table registry.
 *
 * @returns A read-only view of every table declared with `embeddedTable(...)`
 * in the current process.
 */
export function getTableRegistry(): ReadonlyMap<
  string,
  EmbeddedTableRuntimeHandle
> {
  return registry;
}

/**
 * Clear the global embedded table registry.
 * @internal
 */
export function _resetRegistry(): void {
  registry.clear();
}

/**
 * Create a new embedded table definition.
 *
 * @typeParam TableName - Canonical table name.
 * @typeParam Shape - Embedded field descriptor map.
 * @param tableName - Table name used for local storage and generated metadata.
 * @param shape - Embedded CRDT/schema field definition map.
 * @param options - Optional schema versioning, defaults, and migration config.
 * @returns A typed embedded table handle with query/mutation builders and field refs.
 *
 * @example
 * ```ts
 * const tasks = embeddedTable("tasks", {
 *   title: register(v.string()),
 *   body: prose(),
 * });
 * ```
 */
export function embeddedTable<
  TableName extends string,
  Shape extends Record<string, unknown>,
>(
  tableName: TableName,
  shape: Shape,
  options?: {
    defaults?: Record<string, unknown>;
    migrations?: MigrationsMap;
  },
): EmbeddedTable<TableName, Shape> {
  const schemaDef = define({
    shape,
    defaults: options?.defaults,
    migrations: options?.migrations,
  });

  const validators: Record<string, GenericValidator> = {};
  for (const [key, value] of Object.entries(shape)) {
    validators[key] = extractValidator(value);
  }

  const tableDef = defineTable(validators) as unknown as PatchableTableDef;
  const originalIndex =
    typeof tableDef.index === "function" ? tableDef.index.bind(tableDef) : null;
  const originalSearchIndex =
    typeof tableDef.searchIndex === "function"
      ? tableDef.searchIndex.bind(tableDef)
      : null;
  const originalVectorIndex =
    typeof tableDef.vectorIndex === "function"
      ? tableDef.vectorIndex.bind(tableDef)
      : null;

  const hooks: RuntimeHooks = {};
  Object.defineProperty(tableDef, "_hooks", {
    value: hooks,
    enumerable: false,
  });

  Object.defineProperty(tableDef, "table", {
    value: tableName,
    enumerable: false,
  });
  Object.defineProperty(tableDef, "schema", {
    value: schemaDef,
    enumerable: false,
  });
  Object.defineProperty(tableDef, "field", {
    value: (id: string, field: Extract<keyof Shape, string>) => ({
      table: tableName,
      id,
      field,
    }),
    enumerable: false,
  });
  const declaredIndexes = new Map<string, readonly string[]>();
  Object.defineProperty(tableDef, "_declaredIndexes", {
    value: declaredIndexes,
    enumerable: false,
  });
  if (originalIndex) {
    Object.defineProperty(tableDef, "index", {
      value: (name: string, fields: string[]) => {
        originalIndex(name, fields);
        declaredIndexes.set(name, [...fields]);
        return tableDef;
      },
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  if (originalSearchIndex) {
    Object.defineProperty(tableDef, "searchIndex", {
      value: (...args: Parameters<EmbeddedSearchIndexMethod>) => {
        originalSearchIndex(...args);
        return tableDef;
      },
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  if (originalVectorIndex) {
    Object.defineProperty(tableDef, "vectorIndex", {
      value: (...args: Parameters<EmbeddedVectorIndexMethod>) => {
        originalVectorIndex(...args);
        return tableDef;
      },
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  tableDef._resolveRaw = queryGeneric({
    args: {
      collectionSeq: v.union(v.number(), v.null()),
      documents: v.array(
        v.object({
          docId: v.string(),
          vector: v.bytes(),
          lastSeq: v.union(v.number(), v.null()),
        }),
      ),
      docIds: v.optional(v.array(v.string())),
      scopeArgs: v.optional(v.any()),
      fullCursor: v.optional(v.union(v.string(), v.null())),
    },
    returns: v.object({
      mode: v.union(v.literal("full"), v.literal("incremental")),
      collectionSeq: v.number(),
      documents: v.array(
        v.object({
          docId: v.string(),
          seq: v.union(v.number(), v.null()),
          diff: v.optional(v.bytes()),
          document: v.optional(v.any()),
          deleted: v.optional(v.literal(true)),
        }),
      ),
      continueCursor: v.optional(v.union(v.string(), v.null())),
      isDone: v.optional(v.boolean()),
    }),
    handler: async (
      ctx: GenericQueryCtx<GenericDataModel>,
      args: {
        collectionSeq: number | null;
        documents: Array<{
          docId: string;
          vector: ArrayBuffer;
          lastSeq: number | null;
        }>;
        docIds?: string[];
        scopeArgs?: Record<string, unknown>;
        fullCursor?: string | null;
      },
    ) => {
      if (hooks.resolveHandler) {
        return hooks.resolveHandler(ctx, args);
      }
      return {
        mode: "incremental" as const,
        collectionSeq: args.collectionSeq ?? -1,
        documents: args.documents.map((doc) => ({
          docId: doc.docId,
          seq: doc.lastSeq,
        })),
      };
    },
  });

  Object.defineProperty(tableDef._resolveRaw, REMOTE_META, {
    value: {
      __brand: "convex-embedded:remoteMeta" as const,
      table: tableName,
      schema: schemaDef,
      resolveExport: "resolve",
    } satisfies RemoteMeta,
    enumerable: false,
    configurable: true,
  });

  Object.defineProperty(tableDef, "resolve", {
    get() {
      return tableDef._resolveRaw;
    },
    set(value: RegisteredQuery<"public", DefaultFunctionArgs, unknown>) {
      tableDef._resolveRaw = value;
    },
    enumerable: false,
    configurable: true,
  });

  tableDef.mutation = function mutationBuilder(def: EmbeddedMutationDef) {
    const { args, returns, handler, replay } = def;
    const mutation = (
      mutationGeneric as (
        config: unknown,
      ) => RegisteredMutation<"public", DefaultFunctionArgs, unknown>
    )({
      args,
      ...(returns !== undefined ? { returns } : {}),
      handler: async (
        ctx: GenericMutationCtx<GenericDataModel>,
        fnArgs: DefaultFunctionArgs,
      ) => {
        const result = await handler(ctx, fnArgs);
        if (hooks.afterMutation) {
          await hooks.afterMutation(ctx, def, fnArgs, result);
        }
        return result;
      },
    });

    Object.defineProperty(mutation, PENDING_REPLAY_META, {
      value: {
        __brand: "convex-embedded:pendingReplayMeta" as const,
        version: replay?.version ?? 1,
        migrate: replay?.migrate ?? {},
      } satisfies PendingReplayMeta,
      enumerable: false,
      configurable: false,
    });

    return mutation;
  };

  tableDef.query = function queryBuilder(def: EmbeddedQueryDef) {
    const { args, returns, handler, remote } = def;
    const query = (
      queryGeneric as (
        config: unknown,
      ) => RegisteredQuery<"public", DefaultFunctionArgs, unknown>
    )({
      args,
      ...(returns !== undefined ? { returns } : {}),
      handler: async (
        ctx: GenericQueryCtx<GenericDataModel>,
        fnArgs: DefaultFunctionArgs,
      ) => {
        let result = await handler(ctx, fnArgs);
        if (remote && hooks.detectRuntime) {
          const isRemote = await hooks.detectRuntime(ctx);
          if (isRemote) {
            result = await remote(ctx, fnArgs, result);
          }
        }
        return result;
      },
    });

    return query;
  };

  const embeddedTableDef = tableDef as unknown as EmbeddedTable<
    TableName,
    Shape
  >;
  registry.set(tableName, embeddedTableDef);

  return embeddedTableDef;
}
