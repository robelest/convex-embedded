import type {
  ArgsArrayForOptionalValidator,
  ArgsArrayToObject,
  DefaultArgsForOptionalValidator,
  DefaultFunctionArgs,
  GenericMutationCtx,
  GenericQueryCtx,
  RegisteredMutation,
  RegisteredQuery,
  ReturnValueForOptionalValidator,
  TableDefinition,
} from "convex/server";
import { defineTable, mutationGeneric, queryGeneric } from "convex/server";
import type { PropertyValidators, Validator } from "convex/values";
import { v } from "convex/values";

import type { FieldRef } from "@/shared/types";

import {
  define,
  type Definition,
  type FieldKindForDescriptor,
  type FieldValueForDescriptor,
  type LocalTableMigrationStep,
} from "./core.js";
import { extractValidator } from "./fields.js";
import {
  PENDING_REPLAY_META,
  type PendingReplayMeta,
  type PendingReplayMigrationStep,
  REMOTE_META,
  RESOLVE_QUERY_META,
  type RemoteMeta,
  type ResolveQueryMeta,
} from "./meta.js";

type EmbeddedIndexMethod = (name: string, fields: string[]) => unknown;
type EmbeddedSearchIndexMethod = (...args: any[]) => unknown;
type EmbeddedVectorIndexMethod = (...args: any[]) => unknown;

export type EmbeddedMutationBuilder = <
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
  replay?: {
    version?: number;
    migrate?: Record<number, PendingReplayMigrationStep>;
  };
}) => RegisteredMutation<
  "public",
  ArgsArrayToObject<OneOrZeroArgs>,
  ReturnValueForOptionalValidator<ReturnsValidator>
>;

export type EmbeddedQueryBuilder = <
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
}) => RegisteredQuery<
  "public",
  ArgsArrayToObject<OneOrZeroArgs>,
  ReturnValueForOptionalValidator<ReturnsValidator>
>;

export interface EmbeddedTableRuntimeHandle {
  readonly table: string;
  readonly schema: Definition;
  resolve: RegisteredQuery<"public", DefaultFunctionArgs, any>;
  mutation: EmbeddedMutationBuilder;
  query: EmbeddedQueryBuilder;
  field(id: string, field: string): FieldRef<string, string, unknown, string>;
}

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
> = TableDefinition<any, any, any, any>["index"] &
  ((
    ...args: Parameters<EmbeddedIndexMethod>
  ) => EmbeddedTable<TableName, Shape>);

type EmbeddedSearchIndexFn<
  TableName extends string,
  Shape extends Record<string, unknown>,
> = TableDefinition<any, any, any, any>["searchIndex"] &
  ((
    ...args: Parameters<EmbeddedSearchIndexMethod>
  ) => EmbeddedTable<TableName, Shape>);

type EmbeddedVectorIndexFn<
  TableName extends string,
  Shape extends Record<string, unknown>,
> = TableDefinition<any, any, any, any>["vectorIndex"] &
  ((
    ...args: Parameters<EmbeddedVectorIndexMethod>
  ) => EmbeddedTable<TableName, Shape>);

export type EmbeddedTable<
  TableName extends string = string,
  Shape extends Record<string, unknown> = Record<string, unknown>,
> = TableDefinition<any, any, any, any> &
  EmbeddedTableHandle<TableName, Shape> & {
    index: EmbeddedIndexFn<TableName, Shape>;
    searchIndex: EmbeddedSearchIndexFn<TableName, Shape>;
    vectorIndex: EmbeddedVectorIndexFn<TableName, Shape>;
  };

/**
 * Runtime hooks attached by runtime binding for component-dependent behavior.
 * @internal
 */
export interface RuntimeHooks {
  afterMutation?: (ctx: any, def: any, args: any, result: any) => Promise<void>;
  resolveHandler?: (
    ctx: any,
    args: {
      documents: Array<{ docId: string; vector: ArrayBuffer }>;
      scopeArgs?: Record<string, unknown>;
    },
  ) => Promise<
    Array<{
      docId: string;
      diff?: ArrayBuffer;
      document?: Record<string, unknown>;
    }>
  >;
  detectRuntime?: (ctx: any) => Promise<boolean>;
}

const REGISTRY_KEY = Symbol.for("convex-embedded:table-registry");

const registry: Map<string, EmbeddedTableRuntimeHandle> = ((globalThis as any)[
  REGISTRY_KEY
] ??= new Map());

export function getTableRegistry(): ReadonlyMap<
  string,
  EmbeddedTableRuntimeHandle
> {
  return registry;
}

export function _resetRegistry(): void {
  registry.clear();
}

export function embeddedTable<
  TableName extends string,
  Shape extends Record<string, unknown>,
>(
  tableName: TableName,
  shape: Shape,
  options?: {
    version?: number;
    defaults?: Record<string, unknown>;
    migrate?: Record<number, LocalTableMigrationStep>;
  },
): EmbeddedTable<TableName, Shape> {
  const schemaDef = define({
    version: options?.version ?? 1,
    shape,
    defaults: options?.defaults,
    migrate: options?.migrate,
  });

  const validators: Record<string, any> = {};
  for (const [key, value] of Object.entries(shape)) {
    validators[key] = extractValidator(value);
  }

  const tableDef = defineTable(validators) as any;
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
  if (originalIndex) {
    Object.defineProperty(tableDef, "index", {
      value: (...args: Parameters<EmbeddedIndexMethod>) => {
        originalIndex(...args);
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
      documents: v.array(v.object({ docId: v.string(), vector: v.bytes() })),
      scopeArgs: v.optional(v.any()),
    },
    returns: v.array(
      v.object({
        docId: v.string(),
        diff: v.optional(v.bytes()),
        document: v.optional(v.any()),
      }),
    ),
    handler: async (
      ctx: any,
      args: {
        documents: Array<{ docId: string; vector: ArrayBuffer }>;
        scopeArgs?: Record<string, unknown>;
      },
    ) => {
      if (hooks.resolveHandler) {
        return hooks.resolveHandler(ctx, args);
      }
      return args.documents.map((doc) => ({ docId: doc.docId }));
    },
  });

  Object.defineProperty(tableDef._resolveRaw, REMOTE_META, {
    value: {
      __brand: "convex-embedded:remoteMeta" as const,
      table: tableName,
      schema: schemaDef,
      resolveExport: "resolve",
      listExport: null,
    } satisfies RemoteMeta,
    enumerable: false,
    configurable: true,
  });

  Object.defineProperty(tableDef, "resolve", {
    get() {
      return tableDef._resolveRaw;
    },
    set(value: any) {
      tableDef._resolveRaw = value;
    },
    enumerable: false,
    configurable: true,
  });

  tableDef.mutation = function mutationBuilder(def: any) {
    const { args, returns, handler, replay } = def;
    const mutation = mutationGeneric({
      args,
      ...(returns !== undefined ? { returns } : {}),
      handler: async (ctx: GenericMutationCtx<any>, fnArgs: any) => {
        const result = await handler(ctx, fnArgs);
        if (hooks.afterMutation) {
          await hooks.afterMutation(ctx, def, fnArgs, result);
        }
        return result;
      },
    } as any) as RegisteredMutation<any, any, any>;

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

  tableDef.query = function queryBuilder(def: any) {
    const { args, returns, handler, remote, resolve } = def;
    const query = queryGeneric({
      args,
      ...(returns !== undefined ? { returns } : {}),
      handler: async (ctx: GenericQueryCtx<any>, fnArgs: any) => {
        let result = await handler(ctx, fnArgs);
        if (remote && hooks.detectRuntime) {
          const isRemote = await hooks.detectRuntime(ctx);
          if (isRemote) {
            result = await remote(ctx, fnArgs, result);
          }
        }
        return result;
      },
    } as any) as RegisteredQuery<any, any, any>;

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

  registry.set(tableName, tableDef as EmbeddedTable<TableName, Shape>);

  return tableDef as EmbeddedTable<TableName, Shape>;
}
