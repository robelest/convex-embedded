/**
 * UDF execution engine following the convex-test invocation pattern.
 *
 * Runs Convex queries, mutations, and actions by:
 * 1. Installing syscall handlers on `globalThis.Convex`
 * 2. Creating an OpsContext for deterministic random/time
 * 3. Patching globals (Math.random, Date.now, crypto.randomUUID)
 * 4. Loading the target module and resolving the registered function export
 * 5. Calling func.invokeQuery/invokeMutation/invokeAction (NOT raw _handler)
 *    so the Convex SDK builds ctx (db, auth, scheduler, storage) via syscalls
 * 6. Managing transactions (commit for mutations, rollback for queries)
 * 7. Restoring original globals
 *
 * This matches how convex-test invokes UDFs — the SDK's invoke* methods
 * call setupWriter/setupReader/setupAuth internally, which use our
 * installed globalThis.Convex.syscall / asyncSyscall handlers.
 */
import type { Value } from "convex/values";
import { convexToJson, jsonToConvex } from "convex/values";

import type { FunctionPath, ModuleLoader } from "@/kernel/module-loader";
import { OpsContext, createOpsContext } from "@/kernel/ops";
import {
  createSyncSyscall,
  createAsyncSyscall,
  createJsSyscall,
} from "@/kernel/syscalls";
import type { RunUdfFn } from "@/kernel/syscalls";

import type { Database } from "@/core/database";

// ---------------------------------------------------------------------------
// Global type augmentation for the Convex runtime
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var Convex: {
    syscall: (op: string, args: string) => string;
    asyncSyscall: (op: string, args: string) => Promise<string>;
    jsSyscall: (op: string, args: Record<string, unknown>) => Promise<unknown>;
  } | undefined;
}

// ---------------------------------------------------------------------------
// Deterministic global patching
// ---------------------------------------------------------------------------

interface SavedGlobals {
  mathRandom: typeof Math.random;
  dateNow: typeof Date.now;
  cryptoRandomUUID: (() => `${string}-${string}-${string}-${string}-${string}`) | undefined;
}

/**
 * Patch non-deterministic globals with the deterministic replacements
 * provided by an {@link OpsContext}. Returns the original values so
 * they can be restored after the UDF completes.
 */
function patchGlobals(ops: OpsContext): SavedGlobals {
  const saved: SavedGlobals = {
    mathRandom: Math.random,
    dateNow: Date.now,
    cryptoRandomUUID:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID.bind(crypto)
        : undefined,
  };

  Math.random = () => ops.random();
  Date.now = () => ops.now();

  if (typeof crypto !== "undefined") {
    crypto.randomUUID = () =>
      ops.randomUUID() as `${string}-${string}-${string}-${string}-${string}`;
  }

  return saved;
}

function restoreGlobals(saved: SavedGlobals): void {
  Math.random = saved.mathRandom;
  Date.now = saved.dateNow;
  if (saved.cryptoRandomUUID !== undefined && typeof crypto !== "undefined") {
    crypto.randomUUID = saved.cryptoRandomUUID;
  }
}

// ---------------------------------------------------------------------------
// Module function resolution
// ---------------------------------------------------------------------------

/**
 * Extract the handler function from a registered Convex function export.
 * The Convex SDK wraps user handlers in objects with an `_handler` property.
 *
 * Used only for the test-wrapper path. When the function has `invokeQuery`
 * or `invokeMutation`, we prefer those (see _resolveFunc).
 */
type HandlerFn = (ctx: Record<string, unknown>, args: Record<string, unknown>) => unknown;

function getHandler(func: Record<string, unknown>): HandlerFn | null {
  if (typeof func === "function") return func as unknown as HandlerFn;
  if (func && typeof func._handler === "function") return func._handler as HandlerFn;
  if (func && typeof func.handler === "function") return func.handler as HandlerFn;
  return null;
}

// ---------------------------------------------------------------------------
// UdfExecutor
// ---------------------------------------------------------------------------

export interface UdfExecutorOptions {
  db: Database;
  moduleLoader: ModuleLoader;
  runUdf: RunUdfFn;
  /** Optional callback for `1.0/getUserIdentity` syscall (auth). */
  getIdentity?: () => Promise<unknown>;
}

/**
 * Executes Convex user-defined functions (queries, mutations, actions)
 * with proper global patching, syscall wiring, and transaction management.
 *
 * For real Convex SDK functions (those registered with `query()`, `mutation()`,
 * `action()` from `convex/server`), we call their `invokeQuery` / `invokeMutation`
 * / `invokeAction` methods. This lets the SDK build the full `ctx` object
 * (db, auth, scheduler, storage) using our installed syscalls — exactly matching
 * how convex-test works.
 *
 * For test wrappers (simple functions or objects with `_handler` but no `invoke*`),
 * we fall back to calling the handler directly with an empty ctx. This is fine for
 * unit tests that don't need the SDK's ctx wiring.
 */
export class UdfExecutor {
  private _db: Database;
  private _moduleLoader: ModuleLoader;
  private _runUdf: RunUdfFn;
  private _getIdentity?: () => Promise<unknown>;

  constructor({ db, moduleLoader, runUdf, getIdentity }: UdfExecutorOptions) {
    this._db = db;
    this._moduleLoader = moduleLoader;
    this._runUdf = runUdf;
    this._getIdentity = getIdentity;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Execute a query function. Read-only — starts a transaction for
   * snapshot isolation but always rolls back (no writes persisted).
   */
  async executeQuery(functionPath: FunctionPath, args: Record<string, unknown>): Promise<unknown> {
    return this._runWithGlobals(async () => {
      this._db.startTransaction();
      try {
        const func = await this._resolveFunc(functionPath, "query");

        // Prefer SDK's invokeQuery if available (real registered functions).
        if (typeof func.invokeQuery === "function") {
          const argsStr = JSON.stringify(convexToJson([(args ?? {}) as Value]));
          const rawResult = await func.invokeQuery(argsStr);
          return jsonToConvex(JSON.parse(rawResult));
        }

        // Fallback for test wrappers: call handler directly.
        const handler = getHandler(func);
        if (handler === null) {
          throw this._noHandlerError(functionPath);
        }
        return await handler({}, args ?? {});
      } finally {
        this._db.rollbackWrites();
      }
    });
  }

  /**
   * Execute a mutation function. Wraps in a transaction and commits
   * on success, rolls back on error.
   */
  async executeMutation(functionPath: FunctionPath, args: Record<string, unknown>): Promise<unknown> {
    return this._runWithGlobals(async () => {
      this._db.startTransaction();
      try {
        const func = await this._resolveFunc(functionPath, "mutation");

        let result: unknown;

        // Prefer SDK's invokeMutation if available.
        if (typeof func.invokeMutation === "function") {
          const argsStr = JSON.stringify(convexToJson([(args ?? {}) as Value]));
          const rawResult = await func.invokeMutation(argsStr);
          result = jsonToConvex(JSON.parse(rawResult));
        } else {
          // Fallback for test wrappers.
          const handler = getHandler(func);
          if (handler === null) {
            throw this._noHandlerError(functionPath);
          }
          result = await handler({}, args ?? {});
        }

        this._db.commit();
        return result;
      } catch (error) {
        this._db.rollbackWrites();
        throw error;
      }
    });
  }

  /**
   * Execute an action function. Actions do not run inside a transaction
   * but can invoke queries and mutations via the syscall layer.
   */
  async executeAction(functionPath: FunctionPath, args: Record<string, unknown>): Promise<unknown> {
    return this._runWithGlobals(async () => {
      const func = await this._resolveFunc(functionPath, "action");

      // Prefer SDK's invokeAction if available.
      // Note: invokeAction takes (requestId, argsStr) — 2 args.
      if (typeof func.invokeAction === "function") {
        const requestId = "" + Math.random();
        const argsStr = JSON.stringify(convexToJson([(args ?? {}) as Value]));
        const rawResult = await func.invokeAction(requestId, argsStr);
        return jsonToConvex(JSON.parse(rawResult));
      }

      // Fallback for test wrappers.
      const handler = getHandler(func);
      if (handler === null) {
        throw this._noHandlerError(functionPath);
      }
      return await handler({}, args ?? {});
    });
  }

  // -----------------------------------------------------------------------
  // Internal: global patching & syscall wiring
  // -----------------------------------------------------------------------

  /**
   * Run a callback with:
   * - A fresh {@link OpsContext} providing deterministic random/time
   * - Patched globals (Math.random, Date.now, crypto.randomUUID)
   * - `globalThis.Convex` syscalls installed
   *
   * Everything is restored after the callback completes (or throws).
   */
  private async _runWithGlobals<T>(fn: () => Promise<T>): Promise<T> {
    const ops = createOpsContext();
    const savedGlobals = patchGlobals(ops);

    // Install syscalls on the global Convex object
    const previousConvex = globalThis.Convex;
    globalThis.Convex = {
      syscall: createSyncSyscall(this._db),
      asyncSyscall: createAsyncSyscall(this._db, this._runUdf, {
        getIdentity: this._getIdentity,
      }),
      jsSyscall: createJsSyscall(this._db),
    };

    try {
      return await fn();
    } finally {
      globalThis.Convex = previousConvex;
      restoreGlobals(savedGlobals);
    }
  }

  // -----------------------------------------------------------------------
  // Internal: module & function resolution
  // -----------------------------------------------------------------------

  /**
   * Load a module via the {@link ModuleLoader} and return the raw function
   * export object. Unlike `_resolveHandler` (removed), this returns the
   * *whole* registered function object — not just `_handler` — so the
   * caller can check for `invokeQuery` / `invokeMutation` / `invokeAction`.
   *
   * UDF paths use the format `"module:export"` (e.g. `"messages:list"`).
   * If no export name is specified, `"default"` is assumed.
   */
  private async _resolveFunc(
    functionPath: FunctionPath,
    expectedType: "query" | "mutation" | "action",
  ): Promise<Record<string, unknown>> {
    const [modulePath, maybeExportName] = functionPath.udfPath.split(":");
    const exportName =
      maybeExportName === undefined ? "default" : maybeExportName;

    const mod = await this._moduleLoader.load(modulePath);

    const rawExport = mod[exportName];
    if (rawExport === undefined) {
      throw new Error(
        `Expected a Convex function exported from module "${modulePath}" ` +
          `as \`${exportName}\`, but there is no such export.`,
      );
    }

    // The Convex SDK sets flags like `isQuery`, `isMutation`, `isAction`
    // on the registered function objects. We need to cast to access them
    // since ConvexModule values are typed as `unknown`.
    const func = rawExport as Record<string, unknown>;

    // Validate that the export's declared type matches what we expect.
    switch (expectedType) {
      case "query":
        if (func.isQuery === false || func.isMutation || func.isAction) {
          throw new Error(
            `Expected a query function from module "${modulePath}" ` +
              `export \`${exportName}\`, but it is not a query.`,
          );
        }
        break;
      case "mutation":
        if (func.isMutation === false || func.isQuery || func.isAction) {
          throw new Error(
            `Expected a mutation function from module "${modulePath}" ` +
              `export \`${exportName}\`, but it is not a mutation.`,
          );
        }
        break;
      case "action":
        if (func.isAction === false || func.isQuery || func.isMutation) {
          throw new Error(
            `Expected an action function from module "${modulePath}" ` +
              `export \`${exportName}\`, but it is not an action.`,
          );
        }
        break;
    }

    return func;
  }

  private _noHandlerError(functionPath: FunctionPath): Error {
    const [modulePath, maybeExportName] = functionPath.udfPath.split(":");
    const exportName =
      maybeExportName === undefined ? "default" : maybeExportName;
    return new Error(
      `Expected a Convex function exported from module "${modulePath}" ` +
        `as \`${exportName}\`, but could not extract a handler.`,
    );
  }
}
