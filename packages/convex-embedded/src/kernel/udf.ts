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
import { ConvexError, convexToJson, jsonToConvex } from "convex/values";

import type { FunctionPath, ModuleLoader } from "@/kernel/modules";
import { OpsContext, createOpsContext } from "@/kernel/ops";
import {
  createSyncSyscall,
  createAsyncSyscall,
  createJsSyscall,
} from "@/kernel/syscalls";
import type { RunUdfFn } from "@/kernel/syscalls";
import type { EmbeddedCryptoProvider } from "@/runtime/crypto";
import type { Database } from "@/runtime/db/database";
import type { DatabaseCommitResult } from "@/runtime/db/database";
import type { QueryDependency } from "@/runtime/db/types";
import type { StorageSurface } from "@/runtime/storage";
import { createLogger } from "@/shared/logger";
import { componentRouteTargetLabel, isRemoteOnly } from "@/shared/route";

const log = createLogger("udf");
const loaderLog = createLogger("loader");

declare global {
  var Convex:
    | {
        syscall: (op: string, args: string) => string;
        asyncSyscall: (op: string, args: string) => Promise<string>;
        jsSyscall: (
          op: string,
          args: Record<string, unknown>,
        ) => Promise<unknown>;
      }
    | undefined;
}

interface SavedGlobals {
  mathRandom: typeof Math.random;
  dateNow: typeof Date.now;
  cryptoRandomUUID:
    | (() => `${string}-${string}-${string}-${string}-${string}`)
    | undefined;
  mathRandomDescriptor: PropertyDescriptor | undefined;
  dateNowDescriptor: PropertyDescriptor | undefined;
  cryptoRandomUUIDDescriptor: PropertyDescriptor | undefined;
  patchedMathRandom: boolean;
  patchedDateNow: boolean;
  patchedCryptoRandomUUID: boolean;
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
    mathRandomDescriptor: Object.getOwnPropertyDescriptor(Math, "random"),
    dateNowDescriptor: Object.getOwnPropertyDescriptor(Date, "now"),
    cryptoRandomUUIDDescriptor:
      typeof crypto !== "undefined"
        ? Object.getOwnPropertyDescriptor(crypto, "randomUUID")
        : undefined,
    patchedMathRandom: false,
    patchedDateNow: false,
    patchedCryptoRandomUUID: false,
  };

  saved.patchedMathRandom = patchObjectProperty(Math, "random", () =>
    ops.random(),
  );
  saved.patchedDateNow = patchObjectProperty(Date, "now", () => ops.now());

  if (typeof crypto !== "undefined") {
    saved.patchedCryptoRandomUUID = patchObjectProperty(
      crypto,
      "randomUUID",
      () =>
        ops.randomUUID() as `${string}-${string}-${string}-${string}-${string}`,
    );
  }

  return saved;
}

function restoreGlobals(saved: SavedGlobals): void {
  restoreObjectProperty(
    Math,
    "random",
    saved.mathRandom,
    saved.mathRandomDescriptor,
    saved.patchedMathRandom,
  );
  restoreObjectProperty(
    Date,
    "now",
    saved.dateNow,
    saved.dateNowDescriptor,
    saved.patchedDateNow,
  );
  if (typeof crypto !== "undefined") {
    if (saved.cryptoRandomUUID !== undefined) {
      restoreObjectProperty(
        crypto,
        "randomUUID",
        saved.cryptoRandomUUID,
        saved.cryptoRandomUUIDDescriptor,
        saved.patchedCryptoRandomUUID,
      );
    } else if (
      saved.patchedCryptoRandomUUID &&
      saved.cryptoRandomUUIDDescriptor?.configurable
    ) {
      delete (crypto as { randomUUID?: unknown }).randomUUID;
    }
  }
}

function patchObjectProperty<T extends object, K extends keyof T>(
  object: T,
  key: K,
  value: T[K],
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);

  if (descriptor === undefined || descriptor.writable !== false) {
    try {
      object[key] = value;
      return true;
    } catch {}
  }

  if (descriptor?.configurable) {
    try {
      Object.defineProperty(object, key, {
        ...descriptor,
        value,
      });
      return true;
    } catch {}
  }

  log.debug(
    `skipping deterministic patch for ${String(key)}; property is not writable/configurable`,
  );
  return false;
}

function restoreObjectProperty<T extends object, K extends keyof T>(
  object: T,
  key: K,
  value: T[K],
  descriptor: PropertyDescriptor | undefined,
  patched: boolean,
): void {
  if (!patched) {
    return;
  }

  if (descriptor === undefined || descriptor.writable !== false) {
    try {
      object[key] = value;
      return;
    } catch {}
  }

  if (descriptor?.configurable) {
    try {
      Object.defineProperty(object, key, descriptor);
    } catch {}
  }
}

/**
 * Extract the handler function from a registered Convex function export.
 * The Convex SDK wraps user handlers in objects with an `_handler` property.
 *
 * Used only for the test-wrapper path. When the function has `invokeQuery`
 * or `invokeMutation`, we prefer those (see _resolveFunc).
 */
type HandlerFn = (
  ctx: Record<string, unknown>,
  args: Record<string, unknown>,
) => unknown;

function getHandler(func: Record<string, unknown>): HandlerFn | null {
  if (typeof func === "function") return func as unknown as HandlerFn;
  if (func && typeof func._handler === "function")
    return func._handler as HandlerFn;
  if (func && typeof func.handler === "function")
    return func.handler as HandlerFn;
  return null;
}

export interface MutationResult {
  result: unknown;
  commit: DatabaseCommitResult;
}

export interface UdfExecutorOptions {
  db: Database;
  crypto: EmbeddedCryptoProvider;
  moduleLoader: ModuleLoader;
  runUdf: RunUdfFn;
  /** Optional callback for `1.0/getUserIdentity` syscall (auth). */
  getIdentity?: () => Promise<unknown>;
  /**
   * Optional set of active timer IDs from scheduled function `setTimeout`
   * calls. When provided, the runtime can clear these on shutdown to
   * prevent leaked timers.
   */
  activeTimers?: Set<ReturnType<typeof setTimeout>>;
  storageSurface?: StorageSurface | null;
  runWithTransactionLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

interface ExecutionContext {
  holdsTransactionLock?: boolean;
  identity?: unknown;
  identityKey?: string | null;
  dependencies?: QueryDependency[];
}

/**
 * Executes Convex user-defined functions (queries, mutations, actions)
 * with proper global patching, syscall wiring, and transaction management.
 *
 * For real Convex SDK functions (those registered with `query()`, `mutation()`,
 * `action()`), we call their `invokeQuery` / `invokeMutation`
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
  private _crypto: EmbeddedCryptoProvider;
  private _moduleLoader: ModuleLoader;
  private _runUdf: RunUdfFn;
  private _getIdentity?: () => Promise<unknown>;
  private _activeTimers?: Set<ReturnType<typeof setTimeout>>;
  private _storageSurface: StorageSurface | null;
  private _shouldQueueUploads = false;
  private _contextStack: ExecutionContext[] = [];
  private _actionRequestCounter = 0;
  private _installedConvex!: NonNullable<typeof globalThis.Convex>;
  private _resolvedFunctions = new Map<string, Record<string, unknown>>();

  constructor({
    db,
    crypto,
    moduleLoader,
    runUdf,
    getIdentity,
    activeTimers,
    storageSurface,
    runWithTransactionLock,
  }: UdfExecutorOptions) {
    this._db = db;
    this._crypto = crypto;
    this._moduleLoader = moduleLoader;
    this._runUdf = runUdf;
    this._getIdentity = getIdentity;
    this._activeTimers = activeTimers;
    this._storageSurface = storageSurface ?? null;
    this._installedConvex = {
      syscall: createSyncSyscall(this._db, {
        onDependency: (dependency) => this._pushDependency(dependency),
      }),
      asyncSyscall: createAsyncSyscall(
        this._db,
        (type, path, udfArgs, nestedContext) =>
          this._runUdf(type, path, udfArgs, {
            ...this._currentExecutionContext(),
            ...nestedContext,
          }),
        {
          getIdentity: () => this._resolveCurrentIdentity(),
          getStorageSurface: () => this._storageSurface,
          activeTimers: this._activeTimers,
          onDependency: (dependency) => this._pushDependency(dependency),
          runWithTransactionLock,
        },
      ),
      jsSyscall: createJsSyscall(this._db, this._crypto, {
        getIdentityKey: () =>
          this._currentExecutionContext().identityKey ?? null,
        shouldQueueUploads: () => this._shouldQueueUploads,
      }),
    };
  }

  setStorageSurface(surface: StorageSurface | null): void {
    this._storageSurface = surface;
  }

  /**
   * Toggle the upload queue. When enabled, `ctx.storage.store(blob)` writes
   * a row into `_resolve_pending_uploads` so the engine can replay the
   * upload to the remote deployment on reconnect.
   */
  setShouldQueueUploads(enabled: boolean): void {
    this._shouldQueueUploads = enabled;
  }

  /**
   * Execute a query function. Read-only — starts a transaction for
   * snapshot isolation but always rolls back (no writes persisted).
   */
  async executeQuery(
    functionPath: FunctionPath,
    args: Record<string, unknown>,
    executionContext: ExecutionContext = {},
  ): Promise<unknown> {
    const db = this._db;
    return this._runWithGlobals(async () => {
      db.startTransaction();
      try {
        const func = await this._resolveFunc(functionPath, "query");

        if (typeof func.invokeQuery === "function") {
          const argsStr = JSON.stringify(convexToJson([(args ?? {}) as Value]));
          const rawResult = await (
            func.invokeQuery as (s: string) => Promise<string>
          )(argsStr);
          return jsonToConvex(JSON.parse(rawResult));
        }

        const handler = getHandler(func);
        if (handler === null) {
          throw this._noHandlerError(functionPath);
        }
        return await Promise.resolve(handler({}, args ?? {}));
      } finally {
        db.rollbackWrites();
      }
    }, executionContext);
  }

  /**
   * Execute a mutation function. Wraps in a transaction and commits
   * on success, rolls back on error.
   *
   * Uses try/finally to manage the transaction lifecycle:
   * - Start: startTransaction()
   * - Success: run mutation body + commitAsync()
   * - Failure: rollbackWrites()
   */
  async executeMutation(
    functionPath: FunctionPath,
    args: Record<string, unknown>,
    executionContext: ExecutionContext = {},
  ): Promise<MutationResult> {
    const db = this._db;
    return this._runWithGlobals(async () => {
      db.startTransaction();
      let succeeded = false;
      try {
        const func = await this._resolveFunc(functionPath, "mutation");

        let result: unknown;
        if (typeof func.invokeMutation === "function") {
          const invokeMutation = func.invokeMutation as (
            argsStr: string,
          ) => Promise<string>;
          const argsStr = JSON.stringify(convexToJson([(args ?? {}) as Value]));
          const rawResult = await invokeMutation(argsStr);
          result = jsonToConvex(JSON.parse(rawResult));
        } else {
          const handler = getHandler(func);
          if (handler === null) {
            throw this._noHandlerError(functionPath);
          }
          result = await Promise.resolve(handler({}, args ?? {}));
        }

        const commit = await db.commitAsync();
        succeeded = true;
        return { result, commit } as MutationResult;
      } finally {
        if (!succeeded) {
          db.rollbackWrites();
        }
      }
    }, executionContext);
  }

  /**
   * Execute an action function. Actions do not run inside a transaction
   * but can invoke queries and mutations via the syscall layer.
   */
  async executeAction(
    functionPath: FunctionPath,
    args: Record<string, unknown>,
    executionContext: ExecutionContext = {},
  ): Promise<unknown> {
    return this._runWithGlobals(async () => {
      const func = await this._resolveFunc(functionPath, "action");

      if (typeof func.invokeAction === "function") {
        const requestId = "action_" + ++this._actionRequestCounter;
        const argsStr = JSON.stringify(convexToJson([(args ?? {}) as Value]));
        const rawResult = await func.invokeAction(requestId, argsStr);
        return jsonToConvex(JSON.parse(rawResult));
      }

      const handler = getHandler(func);
      if (handler === null) {
        throw this._noHandlerError(functionPath);
      }
      return await handler({}, args ?? {});
    }, executionContext);
  }

  /**
   * Execute an HTTP action (registered via {@link httpRouter}).
   *
   * HTTP actions are actions semantically — no transaction, syscalls available
   * via {@link runQuery} / {@link runMutation} — but their public entry point
   * takes a `Request` and returns a `Response`. The caller is responsible for
   * route matching; this just runs the chosen handler under the action
   * runtime.
   */
  async executeHttpAction(
    action: { invokeHttpAction?: (request: Request) => Promise<Response> },
    request: Request,
    executionContext: ExecutionContext = {},
  ): Promise<Response> {
    if (typeof action.invokeHttpAction !== "function") {
      throw new Error(
        "[convex-embedded] httpAction is missing invokeHttpAction; route handler is not a Convex httpAction.",
      );
    }
    return this._runWithGlobals(
      () => action.invokeHttpAction!(request),
      executionContext,
    );
  }

  /**
   * Run a callback with:
   * - A fresh {@link OpsContext} providing deterministic random/time
   * - Patched globals (Math.random, Date.now, crypto.randomUUID)
   * - `globalThis.Convex` syscalls installed
   *
   * Everything is restored after the callback completes (or throws).
   */
  private async _runWithGlobals<T>(
    fn: () => Promise<T>,
    executionContext: ExecutionContext = {},
  ): Promise<T> {
    const db = this._db as Database & {
      getActiveIdentityKey?: () => string | null;
      setActiveIdentityKey?: (key: string | null) => void;
    };
    const previousIdentityKey =
      typeof db.getActiveIdentityKey === "function"
        ? db.getActiveIdentityKey()
        : null;

    const ops = createOpsContext();
    const savedGlobals = patchGlobals(ops);
    const previousConvexDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "Convex",
    );
    const previousConvex = globalThis.Convex;
    this._contextStack.push(executionContext);
    if (typeof db.setActiveIdentityKey === "function") {
      db.setActiveIdentityKey(executionContext.identityKey ?? null);
    }
    installGlobalConvex(this._installedConvex);

    try {
      return await fn();
    } finally {
      restoreGlobalConvex(previousConvex, previousConvexDescriptor);
      this._contextStack.pop();
      if (typeof db.setActiveIdentityKey === "function") {
        db.setActiveIdentityKey(previousIdentityKey);
      }
      restoreGlobals(savedGlobals);
    }
  }

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
    if (functionPath.componentPath.length > 0) {
      const target = componentRouteTargetLabel(functionPath);
      throw new ConvexError({
        code: "NESTED_COMPONENT_LOCAL_UNSUPPORTED",
        message:
          `[convex-embedded] Local execution reached component function "${target}". ` +
          "Component refs are remote-routed in alpha; move the boundary remote or mark the caller remoteOnly().",
        componentPath: functionPath.componentPath,
        udfPath: functionPath.udfPath,
        target,
      });
    }

    const cacheKey = `${expectedType}:${functionPath.componentPath}:${functionPath.udfPath}`;
    const cached = this._resolvedFunctions.get(cacheKey);
    if (cached) {
      return cached;
    }

    const [modulePath, maybeExportName] = functionPath.udfPath.split(":");
    const exportName =
      maybeExportName === undefined ? "default" : maybeExportName;

    const mod = await this._moduleLoader.load(modulePath);
    loaderLog.debug(
      "resolved module exports:",
      modulePath,
      Object.keys(mod),
      "looking for",
      exportName,
    );

    const rawExport = mod[exportName];
    if (rawExport === undefined) {
      throw new Error(
        `Expected a Convex function exported from module "${modulePath}" ` +
          `as \`${exportName}\`, but there is no such export.`,
      );
    }

    if (isRemoteOnly(rawExport)) {
      throw new ConvexError({
        code: "ROUTE_REMOTE_LOCAL_UNSUPPORTED",
        message:
          `[convex-embedded] Function "${modulePath}:${exportName}" is marked remoteOnly() and cannot run in the embedded runtime. ` +
          "Call it through a remote client instead.",
        target: `${modulePath}:${exportName}`,
      });
    }

    const func = rawExport as Record<string, unknown>;

    if (expectedType === "query") {
      if (func.isQuery === false || func.isMutation || func.isAction) {
        throw new Error(
          `Expected a query function from module "${modulePath}" ` +
            `export \`${exportName}\`, but it is not a query.`,
        );
      }
    } else if (expectedType === "mutation") {
      if (func.isMutation === false || func.isQuery || func.isAction) {
        throw new Error(
          `Expected a mutation function from module "${modulePath}" ` +
            `export \`${exportName}\`, but it is not a mutation.`,
        );
      }
    } else if (expectedType === "action") {
      if (func.isAction === false || func.isQuery || func.isMutation) {
        throw new Error(
          `Expected an action function from module "${modulePath}" ` +
            `export \`${exportName}\`, but it is not an action.`,
        );
      }
    }

    this._resolvedFunctions.set(cacheKey, func);
    return func;
  }

  private _currentExecutionContext(): ExecutionContext {
    return this._contextStack[this._contextStack.length - 1] ?? {};
  }

  private async _resolveCurrentIdentity(): Promise<unknown> {
    const current = this._currentExecutionContext();
    if (current.identity !== undefined) {
      return current.identity;
    }
    return this._getIdentity ? await this._getIdentity() : null;
  }

  private _pushDependency(dependency: QueryDependency): void {
    this._currentExecutionContext().dependencies?.push(dependency);
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

function installGlobalConvex(
  value: NonNullable<typeof globalThis.Convex>,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Convex");

  if (descriptor?.writable === false && descriptor.configurable === false) {
    throw new Error(
      "[convex-embedded] globalThis.Convex is not writable or configurable in this runtime.",
    );
  }

  if (descriptor?.writable !== false) {
    globalThis.Convex = value;
    return;
  }

  Object.defineProperty(globalThis, "Convex", {
    value,
    writable: true,
    configurable: true,
  });
}

function restoreGlobalConvex(
  previousValue: typeof globalThis.Convex,
  previousDescriptor: PropertyDescriptor | undefined,
): void {
  if (previousDescriptor === undefined) {
    delete (globalThis as { Convex?: typeof globalThis.Convex }).Convex;
    return;
  }

  if (previousDescriptor.writable !== false) {
    globalThis.Convex = previousValue;
    return;
  }

  Object.defineProperty(globalThis, "Convex", previousDescriptor);
}
