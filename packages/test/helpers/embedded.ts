/**
 * Lightweight test harness for the embedded Convex runtime.
 *
 * Provides an `embeddedTest()` factory that spins up a Database, ModuleLoader,
 * and UdfExecutor wired together — without requiring `import.meta.glob` or
 * `_generated` codegen files.
 *
 * There are two ways to define functions:
 *
 * 1. **Convex SDK wrappers** (full integration — ctx.db, ctx.auth, etc. work):
 *    Pass real `query()` / `mutation()` / `action()` objects from `convex/server`.
 *    The UdfExecutor patches `globalThis.Convex` with syscalls, so the SDK's
 *    internal ctx builder wires everything up automatically.
 *
 * 2. **Simple test wrappers** (unit-style — ctx is the raw object from UdfExecutor):
 *    Use the exported `testQuery()` / `testMutation()` / `testAction()` helpers
 *    which create minimal function descriptors that pass `getHandler` resolution.
 *    The handler receives an empty `{}` ctx; useful when you only want to test
 *    database logic via the syscall layer or don't need ctx at all.
 *
 * @example
 * ```ts
 * import { embeddedTest, testMutation, testQuery } from "./test-helpers.js";
 *
 * const t = embeddedTest({
 *   modules: {
 *     "messages:send": testMutation(async (_ctx, { body, author }) => {
 *       // Direct DB access via the test context
 *     }),
 *     "messages:list": testQuery(async (_ctx) => {
 *       return [];
 *     }),
 *   },
 * });
 *
 * await t.mutation("messages:send", { body: "hello", author: "alice" });
 * const msgs = await t.query("messages:list");
 * ```
 *
 * @packageDocumentation
 */

import { Database } from "#embedded/core/database";
import type { ParsedSchema } from "#embedded/core/schema";
import { ModuleLoader } from "#embedded/kernel/module-loader";
import type { FunctionPath } from "#embedded/kernel/module-loader";
import { resolveFunctionPath } from "#embedded/kernel/module-loader";
import { UdfExecutor } from "#embedded/kernel/udf-executor";

// ---------------------------------------------------------------------------
// Simple test function wrappers
// ---------------------------------------------------------------------------

/**
 * Minimal function descriptor recognised by the UdfExecutor's `getHandler`.
 *
 * Carries `isQuery` / `isMutation` / `isAction` flags so that the executor's
 * type-checking logic (when it exists) can validate the call.
 */
export interface TestFunctionDescriptor {
  _handler: (ctx: any, args: any) => any;
  isQuery: boolean;
  isMutation: boolean;
  isAction: boolean;
}

/** Wrap a handler as a query-typed function descriptor. */
export function testQuery(
  handler: (ctx: any, args: any) => any,
): TestFunctionDescriptor {
  return {
    _handler: handler,
    isQuery: true,
    isMutation: false,
    isAction: false,
  };
}

/** Wrap a handler as a mutation-typed function descriptor. */
export function testMutation(
  handler: (ctx: any, args: any) => any,
): TestFunctionDescriptor {
  return {
    _handler: handler,
    isQuery: false,
    isMutation: true,
    isAction: false,
  };
}

/** Wrap a handler as an action-typed function descriptor. */
export function testAction(
  handler: (ctx: any, args: any) => any,
): TestFunctionDescriptor {
  return {
    _handler: handler,
    isQuery: false,
    isMutation: false,
    isAction: true,
  };
}

// ---------------------------------------------------------------------------
// EmbeddedTest types
// ---------------------------------------------------------------------------

export interface EmbeddedTestOptions {
  /**
   * Parsed schema definition. Pass `null` (or omit) for schema-less mode.
   */
  schema?: ParsedSchema | null;

  /**
   * Inline module map keyed by `"moduleName:exportName"`.
   *
   * Values can be:
   * - A {@link TestFunctionDescriptor} from `testQuery` / `testMutation` / `testAction`
   * - A real Convex SDK function object returned by `query()` / `mutation()` / `action()`
   * - A plain async function (will be used as-is; `getHandler` accepts bare functions)
   */
  modules: Record<string, any>;
}

export interface EmbeddedTestContext {
  /** Execute a query by UDF path (e.g. `"messages:list"`). */
  query(path: string, args?: any): Promise<any>;
  /** Execute a mutation by UDF path. */
  mutation(path: string, args?: any): Promise<any>;
  /** Execute an action by UDF path. */
  action(path: string, args?: any): Promise<any>;
  /** Direct access to the underlying Database for low-level assertions. */
  db: Database;
}

// ---------------------------------------------------------------------------
// embeddedTest
// ---------------------------------------------------------------------------

/**
 * Create an isolated test runtime with inline function definitions.
 *
 * Internally wires up a {@link Database}, {@link ModuleLoader}, and
 * {@link UdfExecutor} so that `query` / `mutation` / `action` calls go
 * through the same execution pipeline as the real `EmbeddedRuntime` —
 * including global patching, syscall installation, and transaction
 * management.
 */
export function embeddedTest(
  options: EmbeddedTestOptions,
): EmbeddedTestContext {
  const schema = options.schema ?? null;
  const db = new Database(schema);

  // ---- Build glob record from inline modules ----
  //
  // The ModuleLoader expects an `import.meta.glob`-style record where
  // keys are file paths and values are lazy loaders. It also requires a
  // `_generated` entry so that `findModulesRoot` can determine the prefix.
  //
  // We group entries by the module name (the part before ":") and
  // synthesise a `_generated/api.ts` entry for the root detection.

  const modulesByPath = new Map<string, Record<string, any>>();

  for (const [key, fn] of Object.entries(options.modules)) {
    const colonIdx = key.indexOf(":");
    const modulePath = colonIdx === -1 ? key : key.slice(0, colonIdx);
    const exportName = colonIdx === -1 ? "default" : key.slice(colonIdx + 1);

    if (!modulesByPath.has(modulePath)) {
      modulesByPath.set(modulePath, {});
    }
    modulesByPath.get(modulePath)![exportName] = fn;
  }

  const globRecord: Record<string, () => Promise<any>> = {
    // Sentinel entry so `findModulesRoot` can locate the root.
    "./_generated/api.ts": () => Promise.resolve({}),
  };

  for (const [modulePath, exports] of modulesByPath) {
    globRecord[`./${modulePath}.ts`] = () => Promise.resolve(exports);
  }

  const moduleLoader = new ModuleLoader(globRecord);

  // ---- Create executor ----
  //
  // The `runUdf` callback dispatches back into the executor so that
  // nested calls (e.g. ctx.runQuery inside an action) work.

  const runUdf = async (
    type: "query" | "mutation" | "action",
    path: FunctionPath,
    args: any,
  ): Promise<any> => {
    switch (type) {
      case "query":
        return executor.executeQuery(path, args);
      case "mutation": {
        const { result } = await executor.executeMutation(path, args);
        return result;
      }
      case "action":
        return executor.executeAction(path, args);
    }
  };

  const executor = new UdfExecutor({
    db,
    moduleLoader,
    runUdf,
  });

  // ---- Public API ----

  return {
    async query(path: string, args?: any): Promise<any> {
      const functionPath = resolveFunctionPath({ name: path });
      return executor.executeQuery(functionPath, args ?? {});
    },

    async mutation(path: string, args?: any): Promise<any> {
      const functionPath = resolveFunctionPath({ name: path });
      const { result } = await executor.executeMutation(
        functionPath,
        args ?? {},
      );
      return result;
    },

    async action(path: string, args?: any): Promise<any> {
      const functionPath = resolveFunctionPath({ name: path });
      return executor.executeAction(functionPath, args ?? {});
    },

    db,
  };
}
