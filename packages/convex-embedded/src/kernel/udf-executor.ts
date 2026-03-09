/**
 * UDF execution engine with global patching for determinism.
 *
 * Runs Convex queries, mutations, and actions by:
 * 1. Creating an OpsContext for deterministic random/time/console
 * 2. Patching globals (Math.random, Date.now, crypto.randomUUID)
 * 3. Installing syscall handlers on `globalThis.Convex`
 * 4. Loading the target module and invoking the exported function
 * 5. Managing transactions (commit for mutations, rollback for queries)
 * 6. Restoring original globals
 */
import type { FunctionPath, ModuleLoader } from "./module-loader.js";
import { OpsContext, createOpsContext } from "./ops.js";
import {
  createSyncSyscall,
  createAsyncSyscall,
  createJsSyscall,
} from "./syscalls.js";
import type { RunUdfFn } from "./syscalls.js";

// TODO: type properly once database.ts is finalized
type DatabaseFake = any;

// ---------------------------------------------------------------------------
// Global type augmentation for the Convex runtime
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var Convex: {
    syscall: (op: string, args: string) => string;
    asyncSyscall: (op: string, args: string) => Promise<string>;
    jsSyscall: (op: string, args: Record<string, any>) => Promise<any>;
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
 */
function getHandler(func: any): ((ctx: any, args: any) => any) | null {
  if (typeof func === "function") return func;
  if (func && typeof func._handler === "function") return func._handler;
  if (func && typeof func.handler === "function") return func.handler;
  return null;
}

// ---------------------------------------------------------------------------
// UdfExecutor
// ---------------------------------------------------------------------------

export interface UdfExecutorOptions {
  db: DatabaseFake;
  moduleLoader: ModuleLoader;
  runUdf: RunUdfFn;
}

/**
 * Executes Convex user-defined functions (queries, mutations, actions)
 * with proper global patching, syscall wiring, and transaction management.
 */
export class UdfExecutor {
  private _db: DatabaseFake;
  private _moduleLoader: ModuleLoader;
  private _runUdf: RunUdfFn;

  constructor({ db, moduleLoader, runUdf }: UdfExecutorOptions) {
    this._db = db;
    this._moduleLoader = moduleLoader;
    this._runUdf = runUdf;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Execute a query function. Read-only — starts a transaction for
   * snapshot isolation but always rolls back (no writes persisted).
   */
  async executeQuery(functionPath: FunctionPath, args: any): Promise<any> {
    return this._runWithGlobals(async () => {
      this._db.startTransaction();
      try {
        const handler = await this._resolveHandler(functionPath, "query");
        const ctx = this._buildQueryCtx();
        const result = await handler(ctx, args ?? {});
        return result;
      } finally {
        // Queries are read-only: always rollback
        this._db.rollbackWrites();
      }
    });
  }

  /**
   * Execute a mutation function. Wraps in a transaction and commits
   * on success, rolls back on error.
   */
  async executeMutation(functionPath: FunctionPath, args: any): Promise<any> {
    return this._runWithGlobals(async () => {
      this._db.startTransaction();
      try {
        const handler = await this._resolveHandler(functionPath, "mutation");
        const ctx = this._buildMutationCtx();
        const result = await handler(ctx, args ?? {});
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
  async executeAction(functionPath: FunctionPath, args: any): Promise<any> {
    return this._runWithGlobals(async () => {
      const handler = await this._resolveHandler(functionPath, "action");
      const ctx = this._buildActionCtx();
      return await handler(ctx, args ?? {});
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
      asyncSyscall: createAsyncSyscall(this._db, this._runUdf),
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
  // Internal: module & handler resolution
  // -----------------------------------------------------------------------

  /**
   * Load a module via the {@link ModuleLoader} and extract the named export.
   *
   * UDF paths use the format `"module:export"` (e.g. `"messages:list"`).
   * If no export name is specified, `"default"` is assumed.
   */
  private async _resolveHandler(
    functionPath: FunctionPath,
    expectedType: "query" | "mutation" | "action",
  ): Promise<(ctx: any, args: any) => any> {
    const [modulePath, maybeExportName] = functionPath.udfPath.split(":");
    const exportName =
      maybeExportName === undefined ? "default" : maybeExportName;

    const mod = await this._moduleLoader.load(modulePath);

    const func = mod[exportName];
    if (func === undefined) {
      throw new Error(
        `Expected a Convex function exported from module "${modulePath}" ` +
          `as \`${exportName}\`, but there is no such export.`,
      );
    }

    const handler = getHandler(func);
    if (handler === null) {
      throw new Error(
        `Expected a Convex function exported from module "${modulePath}" ` +
          `as \`${exportName}\`, but got: ${func}`,
      );
    }

    // Validate that the export's declared type matches what we expect.
    // The Convex SDK sets flags like `isQuery`, `isMutation`, `isAction`
    // on the registered function objects.
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

    return handler;
  }

  // -----------------------------------------------------------------------
  // Internal: context builders
  // -----------------------------------------------------------------------

  /**
   * Build the context object for a query invocation.
   *
   * The Convex SDK's `queryGeneric` / `mutationGeneric` / `actionGeneric`
   * wrappers construct the full ctx (db, auth, storage, scheduler)
   * internally via the syscalls installed on `globalThis.Convex`.
   * We return an empty object here; the SDK augments it.
   */
  private _buildQueryCtx(): any {
    return {};
  }

  private _buildMutationCtx(): any {
    return {};
  }

  private _buildActionCtx(): any {
    return {};
  }
}
