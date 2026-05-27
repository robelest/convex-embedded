/**
 * Typed test harness for the embedded Convex runtime — the primary test
 * vehicle for the SDK's own runtime (the convex-test port).
 *
 * `embeddedTest({ modules })` wires a {@link Database}, {@link ModuleLoader},
 * and {@link UdfExecutor} together so `query` / `mutation` / `action` calls go
 * through the same pipeline as the real `EmbeddedRuntime` — global patching,
 * syscall installation, and transaction management.
 *
 * Define functions with the {@link testQuery} / {@link testMutation} /
 * {@link testAction} wrappers. They wrap the real Convex generic builders, so
 * the handler receives a real `ctx` (db, auth, scheduler, storage via syscalls)
 * and the per-path argument / return types flow through to the call site:
 *
 * ```ts
 * const t = embeddedTest({
 *   modules: {
 *     "messages:send": testMutation(
 *       async (ctx, args: { body: string }) => ctx.db.insert("messages", args),
 *     ),
 *     "messages:list": testQuery(async (ctx) => ctx.db.query("messages").collect()),
 *   },
 * });
 *
 * const id = await t.mutation("messages:send", { body: "hi" }); // typed args
 * const all = await t.query("messages:list"); // typed return
 * ```
 *
 * Real Convex SDK functions (from `query()` / `mutation()` / `action()`) are
 * also accepted as module values; their kind is inferred but their args/return
 * fall back to the generic defaults.
 */

import {
  ModuleLoader,
  getFunctionPath,
  type ConvexModule,
  type ConvexModuleRegistry,
  type FunctionPath,
} from "@embedded/kernel/modules";
import { UdfExecutor } from "@embedded/kernel/udf";
import { createAmbientCryptoProvider } from "@embedded/runtime/crypto";
import { createDatabase, type Database } from "@embedded/runtime/db/database";
import type { ParsedSchema } from "@embedded/runtime/db/schema";
import type {
  DefaultFunctionArgs,
  FunctionVisibility,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  RegisteredAction,
  RegisteredMutation,
  RegisteredQuery,
} from "convex/server";
import { actionGeneric, mutationGeneric, queryGeneric } from "convex/server";

// ---------------------------------------------------------------------------
// Function descriptors
// ---------------------------------------------------------------------------

type FnKind = "query" | "mutation" | "action";

/** Phantom brand key carrying a test function's kind / args / return types. */
declare const TEST_FN: unique symbol;

interface TestFnBrand<
  Kind extends FnKind,
  Args extends DefaultFunctionArgs,
  Return,
> {
  readonly kind: Kind;
  readonly args: (args: Args) => void;
  readonly return: () => Return;
}

type RegisteredFor<
  Kind extends FnKind,
  Args extends DefaultFunctionArgs,
  Return,
> = Kind extends "query"
  ? RegisteredQuery<"public", Args, Promise<Return>>
  : Kind extends "mutation"
    ? RegisteredMutation<"public", Args, Promise<Return>>
    : RegisteredAction<"public", Args, Promise<Return>>;

/**
 * A test function descriptor produced by {@link testQuery} / {@link testMutation}
 * / {@link testAction}. It is a real registered Convex function (so the executor
 * builds a full `ctx`), branded with its kind/args/return for per-path inference.
 */
export type TestFunction<
  Kind extends FnKind = FnKind,
  Args extends DefaultFunctionArgs = DefaultFunctionArgs,
  Return = unknown,
> = RegisteredFor<Kind, Args, Return> & {
  readonly [TEST_FN]: TestFnBrand<Kind, Args, Return>;
};

/** Any module value accepted by {@link embeddedTest}. */
export type ModuleValue =
  | TestFunction
  | RegisteredQuery<FunctionVisibility, DefaultFunctionArgs, unknown>
  | RegisteredMutation<FunctionVisibility, DefaultFunctionArgs, unknown>
  | RegisteredAction<FunctionVisibility, DefaultFunctionArgs, unknown>;

type QueryCtx = GenericQueryCtx<GenericDataModel>;
type MutationCtx = GenericMutationCtx<GenericDataModel>;
type ActionCtx = GenericActionCtx<GenericDataModel>;

/** Wrap a handler as a query — receives a real read `ctx`. */
export function testQuery<
  Args extends DefaultFunctionArgs = DefaultFunctionArgs,
  Return = unknown,
>(
  handler: (ctx: QueryCtx, args: Args) => Return | Promise<Return>,
): TestFunction<"query", Args, Awaited<Return>> {
  return queryGeneric({
    handler: handler as (ctx: QueryCtx, args: DefaultFunctionArgs) => unknown,
  }) as unknown as TestFunction<"query", Args, Awaited<Return>>;
}

/** Wrap a handler as a mutation — receives a real read/write `ctx`. */
export function testMutation<
  Args extends DefaultFunctionArgs = DefaultFunctionArgs,
  Return = unknown,
>(
  handler: (ctx: MutationCtx, args: Args) => Return | Promise<Return>,
): TestFunction<"mutation", Args, Awaited<Return>> {
  return mutationGeneric({
    handler: handler as (
      ctx: MutationCtx,
      args: DefaultFunctionArgs,
    ) => unknown,
  }) as unknown as TestFunction<"mutation", Args, Awaited<Return>>;
}

/** Wrap a handler as an action — receives a real action `ctx`. */
export function testAction<
  Args extends DefaultFunctionArgs = DefaultFunctionArgs,
  Return = unknown,
>(
  handler: (ctx: ActionCtx, args: Args) => Return | Promise<Return>,
): TestFunction<"action", Args, Awaited<Return>> {
  return actionGeneric({
    handler: handler as (ctx: ActionCtx, args: DefaultFunctionArgs) => unknown,
  }) as unknown as TestFunction<"action", Args, Awaited<Return>>;
}

// ---------------------------------------------------------------------------
// Per-path type inference
// ---------------------------------------------------------------------------

type KindOf<T> = T extends {
  readonly [TEST_FN]: TestFnBrand<infer K, never, unknown>;
}
  ? K
  : T extends { isAction: true }
    ? "action"
    : T extends { isMutation: true }
      ? "mutation"
      : T extends { isQuery: true }
        ? "query"
        : never;

type ArgsOf<T> = T extends {
  readonly [TEST_FN]: TestFnBrand<FnKind, infer A, unknown>;
}
  ? A
  : DefaultFunctionArgs;

type ReturnOf<T> = T extends {
  readonly [TEST_FN]: TestFnBrand<FnKind, never, infer R>;
}
  ? R
  : unknown;

type KeysOfKind<M, Kind extends FnKind> = {
  [K in keyof M]: KindOf<M[K]> extends Kind ? K : never;
}[keyof M] &
  string;

/** Args become an optional parameter when the function takes no required args. */
type ArgsParam<T> =
  Record<string, never> extends ArgsOf<T>
    ? [args?: ArgsOf<T>]
    : [args: ArgsOf<T>];

// ---------------------------------------------------------------------------
// embeddedTest
// ---------------------------------------------------------------------------

export interface EmbeddedTestOptions<M extends Record<string, ModuleValue>> {
  /** Parsed schema definition. Omit (or pass `null`) for schema-less mode. */
  schema?: ParsedSchema | null;
  /**
   * Inline module map keyed by `"moduleName:exportName"`. Values come from
   * {@link testQuery} / {@link testMutation} / {@link testAction} (or real
   * Convex SDK function objects).
   */
  modules: M;
}

export interface EmbeddedTestContext<M extends Record<string, ModuleValue>> {
  /** Execute a query by path (e.g. `"messages:list"`). */
  query<K extends KeysOfKind<M, "query">>(
    path: K,
    ...args: ArgsParam<M[K]>
  ): Promise<ReturnOf<M[K]>>;
  /** Execute a mutation by path. */
  mutation<K extends KeysOfKind<M, "mutation">>(
    path: K,
    ...args: ArgsParam<M[K]>
  ): Promise<ReturnOf<M[K]>>;
  /** Execute an action by path. */
  action<K extends KeysOfKind<M, "action">>(
    path: K,
    ...args: ArgsParam<M[K]>
  ): Promise<ReturnOf<M[K]>>;
  /** Direct access to the underlying {@link Database} for low-level assertions. */
  readonly db: Database;
}

/**
 * Create an isolated embedded runtime with inline function definitions.
 */
export function embeddedTest<M extends Record<string, ModuleValue>>(
  options: EmbeddedTestOptions<M>,
): EmbeddedTestContext<M> {
  const db = createDatabase(options.schema ?? null);

  const modulesByPath = new Map<string, ConvexModule>();
  for (const [key, fn] of Object.entries(options.modules)) {
    const colonIdx = key.indexOf(":");
    const modulePath = colonIdx === -1 ? key : key.slice(0, colonIdx);
    const exportName = colonIdx === -1 ? "default" : key.slice(colonIdx + 1);
    const exports = modulesByPath.get(modulePath) ?? {};
    exports[exportName] = fn;
    modulesByPath.set(modulePath, exports);
  }

  const moduleRegistry: ConvexModuleRegistry = {};
  for (const [modulePath, exports] of modulesByPath) {
    moduleRegistry[modulePath] = () => Promise.resolve(exports);
  }

  const moduleLoader = new ModuleLoader(moduleRegistry);

  const runUdf = async (
    type: FnKind,
    path: FunctionPath,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    switch (type) {
      case "query":
        return executor.executeQuery(path, args);
      case "mutation":
        return (await executor.executeMutation(path, args)).result;
      case "action":
        return executor.executeAction(path, args);
    }
  };

  const executor = new UdfExecutor({
    db,
    crypto: createAmbientCryptoProvider(),
    moduleLoader,
    runUdf,
  });

  const toArgs = (
    args: DefaultFunctionArgs | undefined,
  ): Record<string, unknown> => (args ?? {}) as Record<string, unknown>;

  return {
    async query(path, ...args) {
      const result = await executor.executeQuery(
        getFunctionPath({ name: path }),
        toArgs(args[0]),
      );
      return result as ReturnOf<M[typeof path]>;
    },
    async mutation(path, ...args) {
      const { result } = await executor.executeMutation(
        getFunctionPath({ name: path }),
        toArgs(args[0]),
      );
      return result as ReturnOf<M[typeof path]>;
    },
    async action(path, ...args) {
      const result = await executor.executeAction(
        getFunctionPath({ name: path }),
        toArgs(args[0]),
      );
      return result as ReturnOf<M[typeof path]>;
    },
    db,
  };
}
