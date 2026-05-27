/**
 * Main embedded runtime.
 *
 * Wires together all subsystems — database, module loader, UDF executor,
 * transaction manager, subscriptions, remote protocol, sessions, write fanout,
 * auth, scheduler, and blob storage — into a single cohesive runtime that
 * ConvexClient can talk to via an in-memory transport.
 */

import type {
  ArgsAndOptions,
  FunctionReference,
  FunctionReturnType,
  OptionalRestArgs,
} from "convex/server";
import { getFunctionName } from "convex/server";
import { ConvexError, type JSONValue } from "convex/values";

import { createAuthResolver, getIdentityKey, type AuthResolver } from "@/auth";
import type { UserIdentity } from "@/auth";
import { ModuleLoader } from "@/kernel/modules";
import type { ConvexInput, FunctionPath } from "@/kernel/modules";
import { getFunctionPath } from "@/kernel/modules";
import { SYSTEM_FUNCTIONS } from "@/kernel/system";
import type { SystemFunctionDef } from "@/kernel/system";
import {
  createTransactionManager,
  type TransactionManager,
} from "@/kernel/transaction";
import { UdfExecutor } from "@/kernel/udf";
import { ReplicationProtocolHandler } from "@/replication/protocol";
import type {
  ClientMessage,
  ProtocolChange,
  ProtocolExecutor,
  ServerMessage,
} from "@/replication/protocol";
import { createSessionManager, type SessionManager } from "@/replication/session";
import {
  createSubscriptionManager,
  type SubscriptionManager,
} from "@/replication/subscriptions";
import {
  blobShaBase64,
  createAmbientCryptoProvider,
  type EmbeddedCryptoProvider,
} from "@/runtime/crypto";
import { createDatabase, type Database } from "@/runtime/db/database";
import type { DatabaseCommitResult } from "@/runtime/db/database";
import { parseSchema } from "@/runtime/db/schema";
import type { SchemaExport } from "@/runtime/db/schema";
import type { QueryDependency } from "@/runtime/db/types";
import type { DocumentId, StoredDocument } from "@/runtime/db/types";
import { createHttpDispatcher, type HttpDispatcher } from "@/runtime/http";
import {
  createNoopWriteBroadcast,
  type WriteBroadcast,
} from "@/runtime/platform";
import {
  LocalQueryEvaluationError,
  createRuntimeProtocolQueryRegistry,
  createRuntimeQueryObserverRegistry,
  type ProtocolQueryRecord,
  type RuntimeProtocolQueryRegistry,
  type RuntimeQueryObserver,
} from "@/runtime/registry";
import type { StorageSurface } from "@/runtime/storage";
import { createTransport } from "@/runtime/transport";
import type { EmbeddedTransport } from "@/runtime/transport";
import { discoverCronJobs } from "@/scheduler/cron/discover";
import { CronRunner } from "@/scheduler/cron/runner";
import {
  createSchedulerExecutor,
  type SchedulerExecutor,
} from "@/scheduler/executor";
import { canonicalizeMappedCreateTable } from "@/shared/canonicalize";
import { structuralEqual } from "@/shared/equals";
import { createLogger, setLoggerDebug } from "@/shared/logger";
import { matchTag } from "@/shared/match";
import { nowMs } from "@/shared/perf";
import { componentRouteTargetLabel } from "@/shared/route";
import {
  extractConvexSchemaExport,
  extractEmbeddedTableDefinitions,
  type Definition,
} from "@/shared/schema";
import { stableValueKey } from "@/shared/valuekey";
import type { StorageAdapter } from "@/storage/adapter";
import { isQueryable } from "@/storage/adapter";
import {
  buildUserTableSpecs,
  type InternalTableSpec,
} from "@/storage/sqlite/factory";
import { captureValueAttr, withSpan } from "@/tracing/spans";
import { runDetached } from "@/utils/detached";
import { createDisposableScope } from "@/utils/scope";

const storageLog = createLogger("runtime-storage");
const runtimeLog = createLogger("runtime");

const noopHttpDispatcher: HttpDispatcher = {
  dispatch: () =>
    Promise.resolve(
      new Response("Not Found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      }),
    ),
  hasRoutes: () => false,
};

function readDebugEnvFlag(): boolean {
  if (typeof process === "undefined") return false;
  const env = (process as { env?: Record<string, string | undefined> }).env;
  return env?.CONVEX_EMBEDDED_DEBUG === "1";
}

export type LocalExecutionRequest =
  | {
      kind: "query";
      path: string;
      args: Record<string, unknown>;
    }
  | {
      kind: "mutation";
      path: string;
      args: Record<string, unknown>;
      applyLocalEffects: boolean;
    }
  | {
      kind: "action";
      path: string;
      args: Record<string, unknown>;
    };

/**
 * Subscription handle for a local query watch.
 *
 * @typeParam T - Materialized query result type.
 */
export interface LocalQueryWatch<T = unknown> {
  /** Subscribe to result changes. */
  onUpdate(callback: () => void): () => void;
  /** Read the latest materialized result snapshot synchronously. */
  localQueryResult(): T | undefined;
  /** Read the latest log lines emitted by the local query, if any. */
  localQueryLogs(): string[] | undefined;
}

/**
 * Snapshot returned by a watched local paginated query.
 *
 * @typeParam T - Row type for the paginated result page.
 */
export type LocalPaginatedQueryResult<T = unknown> = {
  /** Materialized rows loaded so far. */
  results: T[];
  /** Pagination state compatible with Convex paginated query semantics. */
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  /** Request additional rows. Returns `false` when another load is already active. */
  loadMore: (numItems: number) => boolean;
};

/**
 * Subscription handle for a local paginated query watch.
 *
 * @typeParam T - Row type for the paginated result page.
 */
export interface LocalPaginatedQueryWatch<T = unknown> {
  /** Subscribe to page/result changes. */
  onUpdate(callback: () => void): () => void;
  /** Read the latest paginated result snapshot synchronously. */
  localQueryResult(): LocalPaginatedQueryResult<T> | undefined;
  /** Read the latest log lines emitted by the local paginated query, if any. */
  localQueryLogs(): string[] | undefined;
}

/**
 * Disposable table-write subscription returned by `subscribeTableWrites(...)`.
 */
export interface TableWriteSubscription {
  /** Stop listening for table write notifications. */
  unsubscribe(): void;
}

type LocalQueryEvaluation = {
  result: unknown;
  tablesRead: Set<string>;
  dependencies: QueryDependency[];
};

type LocalQueryWatchRecord = {
  path: string;
  args: Record<string, unknown>;
};

type LocalPaginatedPageResult = {
  page: unknown[];
  isDone: boolean;
  continueCursor: string;
  splitCursor: string | null;
  pageStatus: "SplitRecommended" | "SplitRequired" | null;
};

type LocalPaginatedPageRecord = {
  cursor: string | null;
  numItems: number;
};

type LocalPaginatedPageCacheEntry = {
  result: LocalPaginatedPageResult;
  tablesRead: Set<string>;
  dependencies: QueryDependency[];
  depVersions: Map<string, number>;
};

type LocalPaginatedWatchRecord = {
  path: string;
  args: Record<string, unknown>;
  initialNumItems: number;
  pages: LocalPaginatedPageRecord[];
  loadingMore: boolean;
  lastContinueCursor: string | null;
  lastIsDone: boolean;
  pageCache: Map<string, LocalPaginatedPageCacheEntry>;
};

/**
 * Controls how {@link EmbeddedRuntime.ingestDocuments} reconciles the
 * incoming snapshot against local state.
 *
 * - `deleteAbsent: false` ingests in append/upsert-only mode: local
 *   documents absent from `remoteDocs` are kept. Used while streaming a
 *   paginated full resolve so earlier pages are not deleted by later ones.
 * - `keepIds` retains the given ids even when reconciling deletes, so a
 *   final reconcile pass can prune against the union of all streamed pages.
 */
export interface IngestDocumentsOptions {
  deleteAbsent?: boolean;
  keepIds?: ReadonlySet<string>;
}

/**
 * Shallow-compare two documents, ignoring `_id` and `_creationTime`.
 *
 * Used by {@link EmbeddedRuntime.ingestDocuments} to determine whether
 * a remote document has actually changed relative to the local copy.
 * Returns `true` when all user-facing fields are identical.
 */
const DOCS_EQUAL_SKIP_KEYS = new Set(["_id", "_creationTime", "__identityKey"]);

function docsEqual(a: StoredDocument, b: Record<string, unknown>): boolean {
  if (a === b) return true;

  const aKeys = Object.keys(a).filter((k) => !DOCS_EQUAL_SKIP_KEYS.has(k));
  const bKeys = Object.keys(b).filter((k) => !DOCS_EQUAL_SKIP_KEYS.has(k));

  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!(key in b)) {
      return false;
    }
    if (!structuralEqual(a[key as keyof StoredDocument], b[key])) {
      return false;
    }
  }

  return true;
}

export interface EmbeddedRuntimeOptions {
  /** Generated Convex input containing modules and manifest metadata. */
  convex: ConvexInput;
  /** Optional Convex schema definition or `convex/schema.ts` module namespace. */
  schema?: unknown;
  /** Optional durable storage backend. When omitted the runtime is purely in-memory. */
  storage?: StorageAdapter;
  /** Optional crypto implementation for ids and hashing. */
  crypto?: EmbeddedCryptoProvider;
  /** Optional verifier for embedded auth tokens used by local auth flows. */
  verifyToken?: (token: string) => Promise<UserIdentity | null>;
  /** Optional cross-context write broadcast implementation. */
  writeBroadcast?: WriteBroadcast;
  /**
   * Enable verbose debug logging via {@link createLogger}. Off by default.
   * Also enabled when `process.env.CONVEX_EMBEDDED_DEBUG === "1"`.
   */
  debug?: boolean;
}

function extractOmittedFieldsByTable(
  schemaExport: EmbeddedRuntimeOptions["schema"],
): Map<string, ReadonlySet<string>> {
  const result = new Map<string, ReadonlySet<string>>();
  for (const [tableName, schemaDef] of extractEmbeddedTableDefinitions(
    schemaExport,
  )) {
    const omitted = schemaDef.getOmittedFields();
    if (omitted.length > 0) {
      result.set(tableName, new Set(omitted));
    }
  }

  return result;
}

/**
 * Top-level runtime that owns all subsystems and provides the transport
 * configuration for ConvexClient.
 *
 * @remarks
 * This is the framework-agnostic core of the package. Use it directly for SSR,
 * tests, tooling, or advanced local-first flows where you need direct access to
 * the embedded database and protocol layers without going through a browser or
 * Expo client wrapper.
 *
 * @example
 * ```ts
 * import { modules } from "./convex-modules";
 *
 * const runtime = createEmbeddedRuntime({
 *   modules,
 *   schema,
 * });
 * const { url, webSocketConstructor } = runtime.createTransport();
 * const client = new ConvexClient(url, { webSocketConstructor });
 * ```
 */
export interface EmbeddedRuntime {
  readonly crypto: EmbeddedCryptoProvider;
  readonly db: Database;
  readonly moduleLoader: ModuleLoader;
  readonly executor: UdfExecutor;
  readonly transactionManager: TransactionManager;
  readonly subscriptions: SubscriptionManager;
  readonly protocolQueries: RuntimeProtocolQueryRegistry;
  readonly syncProtocol: ReplicationProtocolHandler;
  readonly sessions: SessionManager;
  readonly writeFanout: WriteBroadcast;
  readonly auth: AuthResolver;
  readonly scheduler: SchedulerExecutor;
  readonly cronRunner: CronRunner;

  hydrate(): Promise<void>;
  query<Query extends FunctionReference<"query">>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<FunctionReturnType<Query>>;
  paginate<Query extends FunctionReference<"query">>(
    query: Query,
    ...argsAndOptions: ArgsAndOptions<
      Query,
      {
        initialNumItems: number;
        cursor?: string | null;
      }
    >
  ): Promise<FunctionReturnType<Query>>;
  resumePersistedState(): Promise<void>;
  setStorageSurface(surface: StorageSurface | null): void;
  setUploadQueueEnabled(enabled: boolean): void;
  setStorage(storage: StorageAdapter | null): void;
  getStorage(): StorageAdapter | null;
  getUserTableSpecs(): Map<string, InternalTableSpec> | null;
  extendStorageReady(ready: Promise<void>): void;
  getStorageBlob(storageId: string): Promise<Blob | null>;
  getStorageMetadata(
    storageId: string,
  ): Promise<Record<string, unknown> | null>;
  storeUploadedBlob(blob: Blob): Promise<string>;
  storeUploadedBlobWithMetadata(
    blob: Blob,
    metadata: { uploadSourceRef?: string },
  ): Promise<string>;
  registerUploadUrlSource(uploadUrl: string, refName: string): void;
  consumeUploadUrlSource(token: string): string | undefined;
  createTransport(ready?: Promise<void>): EmbeddedTransport;
  setIdentity(identity: UserIdentity | null): void;
  setActiveIdentityKey(identityKey: string | null): void;
  getIdentity(): UserIdentity | null;
  getIdentityKey(): string | null;
  migrateAnonymousDataToIdentity(identityKey: string): Promise<void>;
  teardownSession(sessionId: string): void;
  handleMessage(message: string): Promise<string[]>;
  onMutationCommit(commit: DatabaseCommitResult): void;
  pushLocalQueryUpdates(commit: DatabaseCommitResult): Promise<void>;
  ingestDocuments(
    table: string,
    remoteDocs: Array<Record<string, unknown>>,
    scopeArgs?: Record<string, unknown>,
    options?: IngestDocumentsOptions,
  ): Promise<void>;
  writeDocsFromCache(
    table: string,
    docs: Array<Record<string, unknown>>,
  ): Promise<void>;
  canonicalizeMappedCreate(input: {
    localId: string;
    remoteId: string;
    tableName: string;
    schemas: Record<string, Definition>;
  }): Promise<void>;
  getDocumentsForTable(
    table: string,
  ): Promise<Array<Record<string, unknown>>>;
  getDocumentsForScope(
    table: string,
    scopeArgs: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>> | null>;
  hasLocalDocumentId(id: string): boolean;
  getDocument(
    table: string,
    id: string,
  ): Promise<Record<string, unknown> | null>;
  subscribeTableWrites(
    table: string,
    callback: (source: "local" | "remote") => void,
  ): TableWriteSubscription;
  watchLocalQuery<T = unknown>(
    path: string,
    args: Record<string, unknown>,
  ): LocalQueryWatch<T>;
  watchLocalPaginatedQuery<T = unknown>(
    path: string,
    args: Record<string, unknown>,
    options: { initialNumItems: number },
  ): LocalPaginatedQueryWatch<T>;
  refreshLocalQueryWatches(): Promise<void>;
  executeLocal(request: LocalExecutionRequest): Promise<unknown>;
  shutdown(): void;
  dispatchHttpRequest(request: Request): Promise<Response>;
  [Symbol.asyncDispose](): Promise<void>;
  _runUdf(
    type: "query" | "mutation" | "action",
    path: FunctionPath,
    args: Record<string, unknown>,
    context?: {
      holdsTransactionLock?: boolean;
      identity?: unknown;
      identityKey?: string | null;
      dependencies?: QueryDependency[];
    },
  ): Promise<unknown>;
  _evaluateLocalQuery(
    pathName: string,
    args: Record<string, unknown>,
  ): Promise<LocalQueryEvaluation>;
  _evaluateLocalPaginatedPage(
    pathName: string,
    args: Record<string, unknown>,
    cursor: string | null,
    endCursor: string | null,
    numItems: number,
  ): Promise<{
    result: LocalPaginatedPageResult;
    tablesRead: Set<string>;
    dependencies: QueryDependency[];
  }>;
  _buildProtocolAuth(): {
    verifyToken(token: string): Promise<{
      identity: UserIdentity;
      identityKey: string | null;
    }>;
  };
  readonly _crossTabSyncChain: Promise<void>;
}

export function createEmbeddedRuntime(
  options: EmbeddedRuntimeOptions,
): EmbeddedRuntime {
  if (options.debug === true || readDebugEnvFlag()) {
    setLoggerDebug(true);
  }
  runtimeLog.debug(
    "creating runtime, modules:",
    Object.keys(options.convex.modules).length,
  );

  let httpDispatcher: HttpDispatcher | null = null;
  const queryTablesReadCache = new Map<string, Set<string>>();
  const tableWriteListeners = new Map<
    string,
    Set<(source: "local" | "remote") => void>
  >();
  const uploadTokenSources = new Map<string, string>();
  const transports: EmbeddedTransport[] = [];
  let storageHydratedComplete = false;
  let crossTabSyncChain: Promise<void> = Promise.resolve();
  let shutdownFlag = false;
  const scope = createDisposableScope();
  const activeTimers = new Set<ReturnType<typeof setTimeout>>();
  const scheduledRecovery = new Set<string>();

  const schemaExport = extractConvexSchemaExport(options.schema);
  const parsedSchema = schemaExport
    ? parseSchema(schemaExport as SchemaExport)
    : null;
  let storageAdapter: StorageAdapter | null = options.storage ?? null;
  const verifyTokenHook = options.verifyToken ?? null;
  const crypto = options.crypto ?? createAmbientCryptoProvider();
  const db = createDatabase(parsedSchema, options.storage, crypto);
  const moduleLoader = new ModuleLoader(options.convex.modules);
  const transactionManager = createTransactionManager();
  const subscriptions = createSubscriptionManager();
  const tableVersionGetter = (tableName: string): number =>
    db.getTableVersion(tableName);
  const protocolQueryObservers =
    createRuntimeQueryObserverRegistry<ProtocolQueryRecord>(
      subscriptions,
      tableVersionGetter,
    );
  const localQueryWatches =
    createRuntimeQueryObserverRegistry<LocalQueryWatchRecord>(
      subscriptions,
      tableVersionGetter,
    );
  const localPaginatedQueryWatches =
    createRuntimeQueryObserverRegistry<LocalPaginatedWatchRecord>(
      subscriptions,
      tableVersionGetter,
    );
  const protocolQueries = createRuntimeProtocolQueryRegistry(
    protocolQueryObservers,
  );
  const auth = createAuthResolver();
  const executor = new UdfExecutor({
    db,
    crypto,
    moduleLoader,
    runUdf: (
      type: "query" | "mutation" | "action",
      path: FunctionPath,
      args: Record<string, unknown>,
      context?: { holdsTransactionLock?: boolean },
    ) => runUdf(type, path, args, context),
    getIdentity: () => auth.getUserIdentity(),
    activeTimers,
    runWithTransactionLock: (fn) => runWithTransactionLock(fn),
  });
  const syncProtocol = new ReplicationProtocolHandler({
    executor: buildProtocolExecutor(),
    queryStore: protocolQueries,
    auth: buildProtocolAuth(),
  });
  const sessions = createSessionManager();
  const writeFanout = options.writeBroadcast ?? createNoopWriteBroadcast();
  const scheduler = createSchedulerExecutor({
    db,
    runFunction: async (path: string, args: Record<string, unknown>) => {
      await runUdf("mutation", getFunctionPath({ name: path }), args);
    },
  });
  const cronRunner = new CronRunner({
    jobs: [],
    runFunction: async (type, functionName, args) => {
      await runUdf(type, getFunctionPath({ name: functionName }), args);
    },
  });

  const userTableSpecs = parsedSchema
    ? buildUserTableSpecs(
        parsedSchema,
        extractOmittedFieldsByTable(options.schema),
      )
    : null;
  if (storageAdapter && userTableSpecs) {
    const setUserTableSpecs = (
      storageAdapter as {
        setUserTableSpecs?: (
          specs: Map<string, InternalTableSpec> | undefined,
        ) => void;
      }
    ).setUserTableSpecs;
    if (typeof setUserTableSpecs === "function") {
      try {
        setUserTableSpecs.call(storageAdapter, userTableSpecs);
      } catch (error) {
        runtimeLog.warn(
          "failed to install user table specs on storage adapter",
          error,
        );
      }
    }
  }

  writeFanout.onNotification((tablesWritten) => {
    crossTabSyncChain = crossTabSyncChain
      .then(() => handleCrossTabSync(tablesWritten))
      .catch((err) => runtimeLog.error("cross-tab sync:", err));
  });

  scope.addFinalizer(() => {
    for (const transport of transports) {
      transport.closeAll();
    }
    transports.length = 0;
    scheduler.shutdown();
    cronRunner.shutdown();
    for (const timerId of activeTimers) {
      clearTimeout(timerId);
    }
    activeTimers.clear();
    scheduledRecovery.clear();
    sessions.clear();
    protocolQueries.clear();
    subscriptions.clear();
    localQueryWatches.clear();
    localPaginatedQueryWatches.clear();
    tableWriteListeners.clear();
    writeFanout.close();
  });
  scope.addFinalizer(async () => {
    await db.waitForPersistence();
    if (storageAdapter?.close) {
      await Promise.resolve(storageAdapter.close());
    }
  });

  const hasInitialStorage = options.storage != null;

  const storageHydratedRef: { current: Promise<void> } = {
    current: (async () => {
      try {
        if (hasInitialStorage) {
          await db.hydrateSystemTables();
        }
        if (hasInitialStorage) {
          await resumeScheduledFunctions();
        }
        await Promise.all([startCronRunner(), initializeHttpDispatcher()]);
        await moduleLoader.preloadAll();
      } catch (err) {
        storageLog.error("hydration failed:", err);
        throw err;
      } finally {
        storageHydratedComplete = true;
      }
    })(),
  };

  function hydrate(): Promise<void> {
    return storageHydratedRef.current;
  }

  async function query<Query extends FunctionReference<"query">>(
    queryRef: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<FunctionReturnType<Query>> {
    return (await runtime.executeLocal({
      kind: "query",
      path: getFunctionName(queryRef),
      args: (args[0] ?? {}) as Record<string, unknown>,
    })) as FunctionReturnType<Query>;
  }

  async function paginate<Query extends FunctionReference<"query">>(
    queryRef: Query,
    ...argsAndOptions: ArgsAndOptions<
      Query,
      {
        initialNumItems: number;
        cursor?: string | null;
      }
    >
  ): Promise<FunctionReturnType<Query>> {
    const [args, opts] = argsAndOptions;
    if (!opts || !Number.isFinite(opts.initialNumItems)) {
      throw new Error(
        "[convex-embedded] paginate requires a finite initialNumItems value.",
      );
    }
    if (opts.initialNumItems <= 0) {
      throw new Error(
        "[convex-embedded] paginate requires initialNumItems to be greater than zero.",
      );
    }

    return (await runtime.executeLocal({
      kind: "query",
      path: getFunctionName(queryRef),
      args: {
        ...((args ?? {}) as Record<string, unknown>),
        paginationOpts: {
          cursor: opts.cursor ?? null,
          numItems: opts.initialNumItems,
          id: -1,
        },
      },
    })) as FunctionReturnType<Query>;
  }

  async function resumePersistedState(): Promise<void> {
    await resumeScheduledFunctions();
  }

  function setStorageSurface(surface: StorageSurface | null): void {
    executor.setStorageSurface(surface);
  }

  function setUploadQueueEnabled(enabled: boolean): void {
    executor.setShouldQueueUploads(enabled);
  }

  function setStorage(storage: StorageAdapter | null): void {
    if (storage && userTableSpecs) {
      const setUserTableSpecs = (
        storage as {
          setUserTableSpecs?: (
            specs: Map<string, InternalTableSpec> | undefined,
          ) => void;
        }
      ).setUserTableSpecs;
      if (typeof setUserTableSpecs === "function") {
        try {
          setUserTableSpecs.call(storage, userTableSpecs);
        } catch (error) {
          runtimeLog.warn(
            "failed to install user table specs on storage adapter",
            error,
          );
        }
      }
    }
    storageAdapter = storage;
    db.setStorage(storage);
  }

  function getStorage(): StorageAdapter | null {
    return storageAdapter;
  }

  function getUserTableSpecs(): Map<string, InternalTableSpec> | null {
    return userTableSpecs;
  }

  function extendStorageReady(ready: Promise<void>): void {
    const prior = storageHydratedRef.current;
    storageHydratedComplete = false;
    storageHydratedRef.current = (async () => {
      try {
        await prior;
        await ready;
      } finally {
        storageHydratedComplete = true;
      }
    })();
  }

  async function getStorageBlob(storageId: string): Promise<Blob | null> {
    await storageHydratedRef.current;
    const started = globalThis.performance?.now?.() ?? Date.now();
    const blob = await db.loadFile(storageId as DocumentId);
    storageLog.debug(
      `getStorageBlob(${storageId}) -> ${blob === null ? "null" : `${blob.size} bytes`} in ${((globalThis.performance?.now?.() ?? Date.now()) - started).toFixed(1)}ms`,
    );
    return blob;
  }

  async function getStorageMetadata(
    storageId: string,
  ): Promise<Record<string, unknown> | null> {
    await storageHydratedRef.current;
    const metadata = (await db.getAsync(
      "_storage",
      storageId as DocumentId,
    )) as Record<string, unknown> | null;
    storageLog.debug(
      `getStorageMetadata(${storageId}) -> ${metadata === null ? "null" : "found"}`,
    );
    return metadata;
  }

  async function storeUploadedBlob(blob: Blob): Promise<string> {
    return storeUploadedBlobWithMetadata(blob, {});
  }

  async function storeUploadedBlobWithMetadata(
    blob: Blob,
    metadata: { uploadSourceRef?: string },
  ): Promise<string> {
    await storageHydratedRef.current;
    storageLog.info(
      `storeUploadedBlob start (${blob.size} bytes, ${blob.type || "unknown type"})`,
    );

    db.startTransaction();
    try {
      const sha256 = await blobShaBase64(blob, crypto);
      storageLog.debug(
        `computed blob sha256 for upload (${sha256.slice(0, 12)}...)`,
      );
      const storageId = db.insert("_storage", {
        size: blob.size,
        sha256,
        contentType: blob.type || undefined,
        uploadSourceRef: metadata.uploadSourceRef,
      });
      await db.storeFile(storageId, blob);
      const commit = await db.commitAsync();
      onMutationCommit(commit);
      storageLog.info(`storeUploadedBlob committed as ${storageId}`);
      return storageId as string;
    } catch (error) {
      db.rollbackWrites();
      storageLog.error("storeUploadedBlob failed", error);
      throw error;
    }
  }

  function registerUploadUrlSource(uploadUrl: string, refName: string): void {
    const token = extractUploadToken(uploadUrl);
    if (token !== null) {
      uploadTokenSources.set(token, refName);
    }
  }

  function consumeUploadUrlSource(token: string): string | undefined {
    const refName = uploadTokenSources.get(token);
    uploadTokenSources.delete(token);
    return refName;
  }

  function extractUploadToken(uploadUrl: string): string | null {
    try {
      const url = new URL(uploadUrl, "http://convex-embedded.local");
      const prefix = "/__convex_embedded/upload/";
      return url.pathname.startsWith(prefix)
        ? url.pathname.slice(prefix.length)
        : null;
    } catch {
      return null;
    }
  }

  function makeTransport(ready?: Promise<void>): EmbeddedTransport {
    const transport = createTransport(runtime, ready);
    transports.push(transport);
    return transport;
  }

  function setIdentity(identity: UserIdentity | null): void {
    auth.setIdentity(identity);
    db.setActiveIdentityKey(getIdentityKey(identity));
  }

  function setActiveIdentityKey(identityKey: string | null): void {
    db.setActiveIdentityKey(identityKey);
  }

  function getIdentity(): UserIdentity | null {
    return auth.peekUserIdentity();
  }

  function getActiveIdentityKey(): string | null {
    return db.getActiveIdentityKey();
  }

  async function migrateAnonymousDataToIdentity(
    identityKey: string,
  ): Promise<void> {
    await storageHydratedRef.current;

    const tablesWritten = new Set<string>();
    db.startTransaction();
    try {
      for (const tableName of db.migrateAnonymousDataToIdentity(identityKey)) {
        tablesWritten.add(tableName);
      }
      const commit = await db.commitAsync();
      onMutationCommit(commit);
    } catch (error) {
      db.rollbackWrites();
      throw error;
    }

    for (const tableName of await db.reStampAnonymousUserTablesInStorage(
      identityKey,
    )) {
      tablesWritten.add(tableName);
    }

    if (tablesWritten.size === 0) {
      await refreshLocalQueryWatches();
      return;
    }

    db.bumpTableVersions(tablesWritten);
    subscriptions.invalidate(tablesWritten);
    const updates = await syncProtocol.reEvaluateQueries(
      Array.from(tablesWritten).map((tableName) => ({
        tableName,
        before: null,
        after: null,
      })),
    );
    await refreshLocalQueryWatches();
    await pushProtocolUpdates(updates);
  }

  function teardownSession(sessionId: string): void {
    syncProtocol.deleteSession(sessionId);
  }

  async function buildLocalDocumentMap(
    table: string,
    scopeArgs?: Record<string, unknown>,
    candidateIds?: ReadonlySet<string>,
  ): Promise<Map<string, StoredDocument>> {
    if (candidateIds !== undefined) {
      const entries = await Promise.all(
        [...candidateIds].map(
          async (id): Promise<[string, StoredDocument] | null> => {
            const doc = await db.getAsync(table, id as DocumentId);
            return doc !== null && documentMatchesScope(doc, scopeArgs)
              ? [id, doc]
              : null;
          },
        ),
      );
      return new Map(
        entries.filter(
          (entry): entry is [string, StoredDocument] => entry !== null,
        ),
      );
    }
    return (await db.listDocumentsAsync(table)).reduce((acc, doc) => {
      if (documentMatchesScope(doc, scopeArgs)) {
        acc.set(doc._id as string, doc);
      }
      return acc;
    }, new Map<string, StoredDocument>());
  }

  function documentMatchesScope(
    doc: Record<string, unknown>,
    scopeArgs?: Record<string, unknown>,
  ): boolean {
    if (!scopeArgs || Object.keys(scopeArgs).length === 0) {
      return true;
    }
    return Object.entries(scopeArgs).every(([fieldPath, expected]) => {
      const actual = fieldPath
        .split(".")
        .reduce<unknown>((current, segment) => {
          if (current === null || typeof current !== "object") {
            return undefined;
          }
          return (current as Record<string, unknown>)[segment];
        }, doc);
      return structuralEqual(actual, expected);
    });
  }

  function buildRemoteDocumentMap(
    remoteDocs: Array<Record<string, unknown>>,
  ): Map<string, Record<string, unknown>> {
    return remoteDocs.reduce((acc, doc) => {
      const id = doc._id;
      return typeof id === "string" ? acc.set(id, doc) : acc;
    }, new Map<string, Record<string, unknown>>());
  }

  function diffIngestDocuments(
    localMap: Map<string, StoredDocument>,
    remoteMap: Map<string, Record<string, unknown>>,
    opts?: IngestDocumentsOptions,
  ): {
    toDelete: string[];
    toUpsert: Array<
      Record<string, unknown> & { _id: string; _creationTime: number }
    >;
  } {
    const toUpsert = [...remoteMap.entries()].flatMap(([id, remoteDoc]) => {
      const localDoc = localMap.get(id);
      return localDoc === undefined || !docsEqual(localDoc, remoteDoc)
        ? [
            remoteDoc as Record<string, unknown> & {
              _id: string;
              _creationTime: number;
            },
          ]
        : [];
    });

    if (opts?.deleteAbsent === false) {
      return { toDelete: [], toUpsert };
    }

    const keepIds = opts?.keepIds;
    const toDelete = [...localMap.keys()].filter(
      (id) => !remoteMap.has(id) && !(keepIds?.has(id) ?? false),
    );

    return { toDelete, toUpsert };
  }

  async function pushProtocolUpdates(
    updates: Map<string, ServerMessage[]>,
  ): Promise<void> {
    for (const [sessionId, messages] of updates) {
      for (const message of messages) {
        const data = JSON.stringify(message);
        for (const transport of transports) {
          transport.pushMessage(sessionId, data);
        }
      }
    }
  }

  async function handleMessage(message: string): Promise<string[]> {
    await storageHydratedRef.current;

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message);
    } catch (err) {
      runtimeLog.error("failed to parse message:", err);
      return [JSON.stringify({ type: "FatalError", error: "Invalid JSON" })];
    }

    runtimeLog.debug("handleMessage:", parsed.type);

    const sessionId =
      ((parsed as unknown as Record<string, unknown>).sessionId as string) ??
      "default";

    try {
      const responses: ServerMessage[] = await syncProtocol.handleMessage(
        sessionId,
        parsed,
      );

      runtimeLog.debug(
        "handleMessage responses:",
        parsed.type,
        responses.map((response) => response.type),
      );

      return responses.map((r) => JSON.stringify(r));
    } catch (err) {
      runtimeLog.error("protocol error on", parsed.type, ":", err);
      return [
        JSON.stringify({
          type: "FatalError",
          error: err instanceof Error ? err.message : String(err),
        }),
      ];
    }
  }

  function onMutationCommit(commit: DatabaseCommitResult): void {
    if (commit.tablesWritten.size === 0) return;
    const startedAt = nowMs();

    db.bumpTableVersions(commit.tablesWritten);

    const changes = commitToQueryUpdates(commit.invalidation);
    const tablesWritten = commit.invalidation.tables;
    const invalidateStart = nowMs();
    if (changes.length > 0) {
      subscriptions.invalidate(changes);
    } else if (tablesWritten.size > 0) {
      subscriptions.invalidate(tablesWritten);
    }
    const invalidateMs = nowMs() - invalidateStart;
    notifyTableWriteListeners(tablesWritten);
    runDetached(
      () => notifyCrossTabAfterStorage(commit),
      "[convex-embedded] post-commit fanout failed:",
    );
    runtimeLog.debug(
      `onMutationCommit tables=${[...tablesWritten].join(",")} changes=${changes.length} invalidate_ms=${invalidateMs.toFixed(1)} total_ms=${(nowMs() - startedAt).toFixed(1)}`,
    );
  }

  function notifyTableWriteListeners(
    tablesWritten: Iterable<string>,
    source: "local" | "remote" = "local",
  ): void {
    for (const tableName of tablesWritten) {
      const listeners = tableWriteListeners.get(tableName);
      if (!listeners || listeners.size === 0) {
        continue;
      }
      for (const listener of Array.from(listeners)) {
        try {
          listener(source);
        } catch (error) {
          runtimeLog.error(
            `table write listener failed for "${tableName}":`,
            error,
          );
        }
      }
    }
  }

  function commitToQueryUpdates(batch: {
    tables: Set<string>;
    changes: Array<ProtocolChange>;
  }): ProtocolChange[] {
    const changes = [...batch.changes];
    const preciseTables = new Set(changes.map((change) => change.tableName));
    for (const tableName of batch.tables) {
      if (!preciseTables.has(tableName)) {
        changes.push({ tableName, before: null, after: null });
      }
    }
    return changes;
  }

  async function pushLocalQueryUpdates(
    commit: DatabaseCommitResult,
  ): Promise<void> {
    return withSpan("convex-embedded.pushLocalQueryUpdates", async (span) => {
      if (commit.tablesWritten.size === 0) {
        span.setAttributes({ "convex.commit.tables_written": 0 });
        return;
      }
      span.setAttributes({
        "convex.commit.tables_written": commit.tablesWritten.size,
      });

      const changes = commitToQueryUpdates(commit.invalidation);
      span.setAttributes({ "convex.commit.changes": changes.length });
      if (changes.length === 0) return;

      const updates = await syncProtocol.reEvaluateQueries(changes);
      await pushProtocolUpdates(updates);
    });
  }

  async function notifyCrossTabAfterStorage(
    commit: DatabaseCommitResult,
  ): Promise<void> {
    try {
      await commit.persisted;
      writeFanout.notify(commit.tablesWritten);
    } catch (err) {
      runtimeLog.error("skipping cross-tab notify after storage failure:", err);
    }
  }

  async function handleCrossTabSync(
    tablesWritten: Set<string>,
  ): Promise<void> {
    try {
      const tablesToSync = Array.from(tablesWritten).filter(
        (table) =>
          !(storageAdapter != null && isQueryable(storageAdapter)) ||
          db.isTableHydrationAttempted(table),
      );
      await Promise.all(
        tablesToSync.map((table) => db.replicateTable(table)),
      );

      const updates = await syncProtocol.reEvaluateQueries(
        Array.from(tablesWritten).map((tableName) => ({
          tableName,
          before: null,
          after: null,
        })),
      );
      await refreshLocalQueryWatches();
      notifyTableWriteListeners(tablesWritten, "remote");

      for (const [sessionId, messages] of updates) {
        for (const msg of messages) {
          const data = JSON.stringify(msg);
          for (const transport of transports) {
            transport.pushMessage(sessionId, data);
          }
        }
      }
    } catch (err) {
      runtimeLog.error("cross-tab remote failed:", err);
    }
  }

  async function ingestDocuments(
    table: string,
    remoteDocs: Array<Record<string, unknown>>,
    scopeArgs?: Record<string, unknown>,
    opts?: IngestDocumentsOptions,
  ): Promise<void> {
    try {
      await storageHydratedRef.current;

      const remoteMap = buildRemoteDocumentMap(remoteDocs);
      const localMap = await buildLocalDocumentMap(
        table,
        scopeArgs,
        opts?.deleteAbsent === false ? new Set(remoteMap.keys()) : undefined,
      );
      const { toDelete, toUpsert } = diffIngestDocuments(
        localMap,
        remoteMap,
        opts,
      );

      if (toUpsert.length === 0 && toDelete.length === 0) {
        return;
      }

      runtimeLog.debug(
        `ingestDocuments("${table}"): ` +
          `${toUpsert.length} upsert(s), ${toDelete.length} delete(s)`,
      );

      db.startTransaction();
      try {
        for (const doc of toUpsert) {
          db.writeDocument(table, doc);
        }
        for (const id of toDelete) {
          db.deleteDocument(table, id as unknown as DocumentId);
        }
        const commit = await db.commitAsync();

        db.bumpTableVersions(commit.tablesWritten);

        const changes = commitToQueryUpdates(commit.invalidation);
        const tablesWritten = commit.invalidation.tables;
        if (changes.length > 0) {
          subscriptions.invalidate(changes);
        } else if (tablesWritten.size > 0) {
          subscriptions.invalidate(tablesWritten);
        }
        notifyTableWriteListeners(tablesWritten, "remote");
        runDetached(
          () => notifyCrossTabAfterStorage(commit),
          "[convex-embedded] post-commit fanout failed:",
        );
      } catch (e) {
        db.rollbackWrites();
        throw e;
      }

      const updates = await syncProtocol.reEvaluateQueries([
        { tableName: table, before: null, after: null },
      ]);
      await pushProtocolUpdates(updates);
    } catch (err) {
      runtimeLog.error(`ingestDocuments("${table}") failed:`, err);
      throw err;
    }
  }

  async function writeDocsFromCache(
    table: string,
    docs: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (docs.length === 0) return;
    const totalStart = nowMs();
    try {
      await storageHydratedRef.current;
    } catch {
      return;
    }

    const candidates = docs.filter(
      (doc): doc is Record<string, unknown> & { _id: string } =>
        typeof doc?._id === "string",
    );
    if (candidates.length === 0) return;

    const tableSpec = userTableSpecs?.get(table) ?? null;
    const requiredFields = tableSpec
      ? Object.entries(tableSpec.fields)
          .filter(([, spec]) => spec.notNull === true)
          .map(([name]) => name)
      : [];
    const knownFields = tableSpec
      ? new Set(Object.keys(tableSpec.fields))
      : null;
    const docHasRequired = (d: Record<string, unknown>): boolean => {
      if (requiredFields.length === 0) return true;
      for (const field of requiredFields) {
        if (d[field] === undefined || d[field] === null) return false;
      }
      return true;
    };
    const stripUnknownFields = (
      d: Record<string, unknown>,
    ): Record<string, unknown> => {
      if (!knownFields) return d;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(d)) {
        if (key === "_id" || key === "_creationTime" || knownFields.has(key)) {
          out[key] = d[key];
        }
      }
      return out;
    };

    const diffStart = nowMs();
    const merged: Array<
      Record<string, unknown> & { _id: string; _creationTime: number }
    > = [];
    let skippedPartial = 0;
    for (const doc of candidates) {
      const existing = db.get(
        table,
        doc._id as unknown as DocumentId,
      ) as Record<string, unknown> | null;
      const existingCt =
        typeof existing?._creationTime === "number"
          ? (existing._creationTime as number)
          : null;
      const docCt =
        typeof doc._creationTime === "number"
          ? (doc._creationTime as number)
          : null;

      if (existing === null) {
        if (!docHasRequired(doc)) {
          skippedPartial += 1;
          continue;
        }
        const stripped = stripUnknownFields(doc);
        const next = (
          docCt !== null ? stripped : { ...stripped, _creationTime: 0 }
        ) as Record<string, unknown> & { _id: string; _creationTime: number };
        merged.push(next);
        continue;
      }

      const candidateNext = {
        ...existing,
        ...doc,
        _id: doc._id,
        _creationTime: docCt ?? existingCt ?? 0,
      };
      const next = stripUnknownFields(candidateNext) as Record<
        string,
        unknown
      > & {
        _id: string;
        _creationTime: number;
      };
      if (!docHasRequired(next)) {
        skippedPartial += 1;
        continue;
      }
      if (structuralEqual(existing, next)) continue;
      merged.push(next);
    }
    const diffMs = nowMs() - diffStart;

    if (merged.length === 0) {
      runtimeLog.debug(
        `writeDocsFromCache ${table} candidates=${candidates.length} merged=0 skipped_partial=${skippedPartial} diff_ms=${diffMs.toFixed(1)} total_ms=${(nowMs() - totalStart).toFixed(1)}`,
      );
      return;
    }

    const writeStart = nowMs();
    db.startTransaction();
    try {
      for (const doc of merged) {
        try {
          db.writeDocument(table, doc, { validate: false });
        } catch (err) {
          runtimeLog.debug(
            `writeDocsFromCache skip ${table}/${doc._id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const commit = await db.commitAsync();
      db.bumpTableVersions(commit.tablesWritten);
      const tablesWritten = commit.invalidation.tables;
      if (tablesWritten.size > 0) {
        subscriptions.invalidate(tablesWritten);
      }
    } catch (err) {
      runtimeLog.warn(
        `writeDocsFromCache rollback (${table}): ${err instanceof Error ? err.message : String(err)}`,
      );
      db.rollbackWrites();
    }
    runtimeLog.debug(
      `writeDocsFromCache ${table} candidates=${candidates.length} merged=${merged.length} skipped_partial=${skippedPartial} diff_ms=${diffMs.toFixed(1)} write_ms=${(nowMs() - writeStart).toFixed(1)} total_ms=${(nowMs() - totalStart).toFixed(1)}`,
    );
  }

  async function canonicalizeMappedCreate(input: {
    localId: string;
    remoteId: string;
    tableName: string;
    schemas: Record<string, Definition>;
  }): Promise<void> {
    await storageHydratedRef.current;

    const orderedTableNames = [
      input.tableName,
      ...Object.keys(input.schemas).filter(
        (candidate) => candidate !== input.tableName,
      ),
    ];

    let committed = false;
    let commit: DatabaseCommitResult;

    db.startTransaction();
    try {
      for (const currentTableName of orderedTableNames) {
        const schema = input.schemas[currentTableName];
        if (!schema) {
          continue;
        }

        const currentDocs = (await db.listDocumentsAsync(
          currentTableName,
        )) as Array<Record<string, unknown>>;
        const { changed, documents } = canonicalizeMappedCreateTable({
          docs: currentDocs,
          schema,
          localId: input.localId,
          remoteId: input.remoteId,
          rewriteOwnId: currentTableName === input.tableName,
          tableName: currentTableName,
        });
        if (!changed) {
          continue;
        }

        const localMap = currentDocs.reduce(
          (acc, doc) => acc.set(doc._id as string, doc as StoredDocument),
          new Map<string, StoredDocument>(),
        );
        const remoteMap = buildRemoteDocumentMap(documents);
        const { toDelete, toUpsert } = diffIngestDocuments(localMap, remoteMap);

        for (const doc of toUpsert) {
          db.writeDocument(currentTableName, doc, { validate: false });
        }
        for (const id of toDelete) {
          db.deleteDocument(currentTableName, id as DocumentId);
        }
      }

      commit = await db.commitAsync();
      committed = true;
      onMutationCommit(commit);
    } catch (error) {
      if (!committed) {
        db.rollbackWrites();
      }
      throw error;
    }

    if (commit.tablesWritten.size === 0) {
      return;
    }

    await pushLocalQueryUpdates(commit);
  }

  async function getDocumentsForTable(
    table: string,
  ): Promise<Array<Record<string, unknown>>> {
    await storageHydratedRef.current;
    return (await db.listDocumentsAsync(table)) as Array<
      Record<string, unknown>
    >;
  }

  async function getDocumentsForScope(
    table: string,
    scopeArgs: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>> | null> {
    await storageHydratedRef.current;
    return (await db.listDocumentsForScopeAsync(table, scopeArgs)) as Array<
      Record<string, unknown>
    > | null;
  }

  function hasLocalDocumentId(id: string): boolean {
    return db.getTableForId(id) !== undefined;
  }

  async function getDocument(
    table: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    await storageHydratedRef.current;
    return (
      ((await db.getAsync(table, id as DocumentId)) as Record<
        string,
        unknown
      > | null) ?? null
    );
  }

  function subscribeTableWrites(
    table: string,
    callback: (source: "local" | "remote") => void,
  ): TableWriteSubscription {
    const listeners =
      tableWriteListeners.get(table) ??
      new Set<(source: "local" | "remote") => void>();
    listeners.add(callback);
    tableWriteListeners.set(table, listeners);

    return {
      unsubscribe: () => {
        const current = tableWriteListeners.get(table);
        if (!current) {
          return;
        }
        current.delete(callback);
        if (current.size === 0) {
          tableWriteListeners.delete(table);
        }
      },
    };
  }

  function watchLocalQuery<T = unknown>(
    path: string,
    args: Record<string, unknown>,
  ): LocalQueryWatch<T> {
    const token = localQueryToken(path, args);
    const observer = getOrCreateLocalQueryWatch(token, path, args);

    return {
      onUpdate: (callback) => {
        const unsubscribe = localQueryWatches.subscribe(token, callback);
        const current = localQueryWatches.get(token) ?? observer;
        if (current.hasValue) {
          queueMicrotask(() => {
            if (current.listeners.has(callback)) {
              callback();
            }
          });
        }

        return unsubscribe;
      },
      localQueryResult: () => {
        const current = localQueryWatches.get(token) ?? observer;
        if (current.currentError) {
          throw current.currentError;
        }
        return current.hasValue ? (current.currentValue as T) : undefined;
      },
      localQueryLogs: () => {
        const current = localQueryWatches.get(token) ?? observer;
        return current.currentLogs;
      },
    };
  }

  function watchLocalPaginatedQuery<T = unknown>(
    path: string,
    args: Record<string, unknown>,
    opts: { initialNumItems: number },
  ): LocalPaginatedQueryWatch<T> {
    const token = localPaginatedQueryToken(path, args, opts.initialNumItems);
    const observer = getOrCreateLocalPaginatedQueryWatch(
      token,
      path,
      args,
      opts.initialNumItems,
    );

    return {
      onUpdate: (callback) => {
        const unsubscribe = localPaginatedQueryWatches.subscribe(
          token,
          callback,
        );
        const current = localPaginatedQueryWatches.get(token) ?? observer;
        if (current.hasValue) {
          queueMicrotask(() => {
            if (current.listeners.has(callback)) {
              callback();
            }
          });
        }

        return unsubscribe;
      },
      localQueryResult: () => {
        const current = localPaginatedQueryWatches.get(token) ?? observer;
        if (current.currentError) {
          throw current.currentError;
        }
        return current.currentValue as LocalPaginatedQueryResult<T> | undefined;
      },
      localQueryLogs: () => {
        const current = localPaginatedQueryWatches.get(token) ?? observer;
        return current.currentLogs;
      },
    };
  }

  async function refreshLocalQueryWatches(): Promise<void> {
    return withSpan(
      "convex-embedded.refreshLocalQueryWatches",
      async (span) => {
        const queryCount =
          localQueryWatches.values().length +
          localPaginatedQueryWatches.values().length;
        span.setAttributes({ "convex.watches.count": queryCount });
        await Promise.all([
          localQueryWatches.refreshAll(),
          localPaginatedQueryWatches.refreshAll(),
        ]);
      },
    );
  }

  async function executeLocal(
    request: LocalExecutionRequest,
  ): Promise<unknown> {
    if (!storageHydratedComplete) {
      await storageHydratedRef.current;
    }

    return executeLocalResolved(request);
  }

  async function executeLocalResolved(
    request: LocalExecutionRequest,
  ): Promise<unknown> {
    if (!storageHydratedComplete) {
      await storageHydratedRef.current;
    }
    return matchTag(request, "kind", {
      query: async (current) => {
        const path = getFunctionPath({ name: current.path });
        const systemFn = SYSTEM_FUNCTIONS[path.udfPath];
        if (systemFn !== undefined) {
          return runSystemFunction(systemFn, "query", current.args);
        }
        return withSpan("convex-embedded.executeLocal.query", async (span) => {
          span.setAttribute("convex.udf_path", path.udfPath);
          captureValueAttr(span, "convex.args", current.args);
          const result = await runUdf("query", path, current.args);
          captureValueAttr(span, "convex.result", result);
          return result;
        });
      },
      mutation: async (current) => {
        const functionPath = getFunctionPath({ name: current.path });
        const systemFn = SYSTEM_FUNCTIONS[functionPath.udfPath];
        if (systemFn !== undefined) {
          return await runSystemFunction(
            systemFn,
            "mutation",
            current.args,
            { holdsTransactionLock: false },
          );
        }
        return withSpan(
          "convex-embedded.executeLocal.mutation",
          async (span) => {
            span.setAttribute("convex.udf_path", functionPath.udfPath);
            captureValueAttr(span, "convex.args", current.args);
            const runMutation = () =>
              executor.executeMutation(functionPath, current.args, {
                holdsTransactionLock: true,
              });
            const { result, commit } =
              await runWithTransactionLock(runMutation);

            if (current.applyLocalEffects) {
              onMutationCommit(commit);
            }

            captureValueAttr(span, "convex.result", result);
            return result;
          },
        );
      },
      action: (current) =>
        runUdf(
          "action",
          getFunctionPath({ name: current.path }),
          current.args,
        ),
    });
  }

  function localQueryToken(
    path: string,
    args: Record<string, unknown>,
  ): string {
    return `${path}:${stableValueKey(args)}`;
  }

  function localPaginatedQueryToken(
    path: string,
    args: Record<string, unknown>,
    initialNumItems: number,
  ): string {
    return `${path}:${stableValueKey(args)}:paginated:${initialNumItems}`;
  }

  function getOrCreateLocalQueryWatch(
    token: string,
    path: string,
    args: Record<string, unknown>,
  ): RuntimeQueryObserver<LocalQueryWatchRecord> {
    const existing = localQueryWatches.get(token);
    if (existing) {
      return existing;
    }

    const record: LocalQueryWatchRecord = {
      path,
      args,
    };

    const observer = localQueryWatches.ensure(token, record, () =>
      evaluateHydratedLocalQuery(path, args),
    );
    void localQueryWatches.refresh(observer);
    return observer;
  }

  function getOrCreateLocalPaginatedQueryWatch(
    token: string,
    path: string,
    args: Record<string, unknown>,
    initialNumItems: number,
  ): RuntimeQueryObserver<LocalPaginatedWatchRecord> {
    const initialMeta: LocalPaginatedWatchRecord = {
      path,
      args,
      initialNumItems,
      pages: [{ cursor: null, numItems: initialNumItems }],
      loadingMore: false,
      lastContinueCursor: null,
      lastIsDone: false,
      pageCache: new Map(),
    };

    const observer = localPaginatedQueryWatches.ensure(
      token,
      initialMeta,
      () => evaluateHydratedLocalPaginatedWatch(observer),
    );
    void localPaginatedQueryWatches.refresh(observer);
    return observer;
  }

  async function evaluateOnePaginatedPage(
    observer: RuntimeQueryObserver<LocalPaginatedWatchRecord>,
    cursor: string | null,
    endCursor: string | null,
    numItems: number,
    tablesRead: Set<string>,
    dependencies: QueryDependency[],
  ): Promise<{ result: LocalPaginatedPageResult; cacheKey: string }> {
    const cacheKey = `${cursor ?? " "}|${endCursor ?? " "}|${numItems}`;
    let evaluated;
    try {
      evaluated = await evaluatePaginatedPageCached(
        observer,
        cacheKey,
        cursor,
        endCursor,
        numItems,
      );
    } catch (error) {
      if (error instanceof LocalQueryEvaluationError) {
        for (const table of error.partialTablesRead) tablesRead.add(table);
        dependencies.push(...error.partialDependencies);
        throw new LocalQueryEvaluationError(error.cause, new Set(tablesRead), [
          ...dependencies,
        ]);
      }
      throw error;
    }
    for (const table of evaluated.tablesRead) tablesRead.add(table);
    dependencies.push(...evaluated.dependencies);
    return { result: evaluated.result, cacheKey };
  }

  function pruneStalePaginatedPageCache(
    observer: RuntimeQueryObserver<LocalPaginatedWatchRecord>,
    liveKeys: Set<string>,
  ): void {
    for (const key of Array.from(observer.meta.pageCache.keys())) {
      if (!liveKeys.has(key)) observer.meta.pageCache.delete(key);
    }
  }

  function finalizePaginatedWatch(
    observer: RuntimeQueryObserver<LocalPaginatedWatchRecord>,
    pageResults: LocalPaginatedPageResult[],
    tablesRead: Set<string>,
    dependencies: QueryDependency[],
  ): LocalQueryEvaluation {
    const results = pageResults.flatMap((page) => page.page) as unknown[];
    const lastPage = pageResults.at(-1) ?? null;
    observer.meta.loadingMore = false;
    observer.meta.lastContinueCursor = lastPage?.continueCursor ?? null;
    observer.meta.lastIsDone = lastPage?.isDone ?? false;
    const status =
      lastPage === null
        ? "LoadingFirstPage"
        : lastPage.isDone
          ? "Exhausted"
          : "CanLoadMore";
    return {
      result: {
        results,
        status,
        loadMore: (numItems: number) =>
          loadMoreLocalPaginatedQuery(observer, numItems),
      },
      tablesRead,
      dependencies,
    };
  }

  async function evaluateLocalPaginatedWatch(
    observer: RuntimeQueryObserver<LocalPaginatedWatchRecord>,
  ): Promise<LocalQueryEvaluation> {
    const tablesRead = new Set<string>();
    const dependencies: QueryDependency[] = [];
    const MAX_SPLIT_PASSES = 8;
    let pageResults: LocalPaginatedPageResult[] = [];

    for (let pass = 0; pass <= MAX_SPLIT_PASSES; pass += 1) {
      tablesRead.clear();
      dependencies.length = 0;
      pageResults = [];

      const pages = observer.meta.pages;
      const liveKeys = new Set<string>();
      for (let index = 0; index < pages.length; index += 1) {
        const pageRecord = pages[index]!;
        const isLast = index === pages.length - 1;
        const endCursor = isLast ? null : pages[index + 1]!.cursor;
        const { result, cacheKey } = await evaluateOnePaginatedPage(
          observer,
          pageRecord.cursor,
          endCursor,
          pageRecord.numItems,
          tablesRead,
          dependencies,
        );
        liveKeys.add(cacheKey);
        pageResults.push(result);
        if (isLast && result.isDone) break;
      }
      pruneStalePaginatedPageCache(observer, liveKeys);
      if (!applyPaginatedSplits(observer, pageResults)) break;
    }

    return finalizePaginatedWatch(
      observer,
      pageResults,
      tablesRead,
      dependencies,
    );
  }

  function applyPaginatedSplits(
    observer: RuntimeQueryObserver<LocalPaginatedWatchRecord>,
    pageResults: LocalPaginatedPageResult[],
  ): boolean {
    const pages = observer.meta.pages;
    const target = observer.meta.initialNumItems;
    for (let index = 0; index < pageResults.length; index += 1) {
      const result = pageResults[index]!;
      const record = pages[index];
      if (record === undefined) {
        continue;
      }
      const splitCursor = result.splitCursor;
      if (splitCursor === null) {
        continue;
      }
      const overgrown =
        result.pageStatus === "SplitRecommended" ||
        result.pageStatus === "SplitRequired" ||
        (target > 0 && result.page.length > target * 2);
      if (!overgrown) {
        continue;
      }
      if (pages.some((page) => page.cursor === splitCursor)) {
        continue;
      }
      pages.splice(index + 1, 0, {
        cursor: splitCursor,
        numItems: record.numItems,
      });
      return true;
    }
    return false;
  }

  async function evaluatePaginatedPageCached(
    observer: RuntimeQueryObserver<LocalPaginatedWatchRecord>,
    cacheKey: string,
    cursor: string | null,
    endCursor: string | null,
    numItems: number,
  ): Promise<{
    result: LocalPaginatedPageResult;
    tablesRead: Set<string>;
    dependencies: QueryDependency[];
  }> {
    const cached = observer.meta.pageCache.get(cacheKey);
    if (cached !== undefined && depVersionsFresh(cached.depVersions)) {
      return {
        result: cached.result,
        tablesRead: cached.tablesRead,
        dependencies: cached.dependencies,
      };
    }

    const evaluated = await runtime._evaluateLocalPaginatedPage(
      observer.meta.path,
      observer.meta.args,
      cursor,
      endCursor,
      numItems,
    );

    const depVersions = new Map<string, number>();
    for (const table of evaluated.tablesRead) {
      depVersions.set(table, db.getTableVersion(table));
    }
    observer.meta.pageCache.set(cacheKey, {
      result: evaluated.result,
      tablesRead: evaluated.tablesRead,
      dependencies: evaluated.dependencies,
      depVersions,
    });
    return evaluated;
  }

  function depVersionsFresh(depVersions: Map<string, number>): boolean {
    for (const [table, version] of depVersions) {
      if (db.getTableVersion(table) !== version) {
        return false;
      }
    }
    return true;
  }

  async function evaluateHydratedLocalQuery(
    pathName: string,
    args: Record<string, unknown>,
  ): Promise<LocalQueryEvaluation> {
    await awaitTableHydrationFor(pathName);
    const evaluation = await runtime._evaluateLocalQuery(pathName, args);
    recordQueryTablesRead(pathName, evaluation.tablesRead);
    return evaluation;
  }

  async function evaluateHydratedLocalPaginatedWatch(
    observer: RuntimeQueryObserver<LocalPaginatedWatchRecord>,
  ): Promise<LocalQueryEvaluation> {
    await awaitTableHydrationFor(observer.meta.path);
    const evaluation = await evaluateLocalPaginatedWatch(observer);
    recordQueryTablesRead(observer.meta.path, evaluation.tablesRead);
    return evaluation;
  }

  async function awaitTableHydrationFor(pathName: string): Promise<void> {
    const cached = queryTablesReadCache.get(pathName);
    if (cached === undefined) {
      if (storageHydratedComplete) return;
      await storageHydratedRef.current;
      return;
    }
    if (cached.size === 0) {
      return;
    }
    if (storageHydratedComplete) return;
    await Promise.all(
      Array.from(cached, (tableName) => db.tableHydrated(tableName)),
    );
  }

  function recordQueryTablesRead(
    pathName: string,
    tablesRead: Set<string>,
  ): void {
    const existing = queryTablesReadCache.get(pathName);
    if (existing === undefined) {
      queryTablesReadCache.set(pathName, new Set(tablesRead));
      return;
    }
    for (const tableName of tablesRead) {
      existing.add(tableName);
    }
  }

  function loadMoreLocalPaginatedQuery(
    observer: RuntimeQueryObserver<LocalPaginatedWatchRecord>,
    numItems: number,
  ): boolean {
    if (
      !Number.isFinite(numItems) ||
      numItems <= 0 ||
      observer.meta.loadingMore ||
      observer.meta.lastIsDone ||
      (observer.currentValue as LocalPaginatedQueryResult | undefined)
        ?.status === "Exhausted" ||
      observer.currentValue === undefined
    ) {
      return false;
    }

    const nextCursor = observer.meta.lastContinueCursor;
    if (nextCursor === null || nextCursor === "_end_cursor") {
      return false;
    }

    observer.meta.pages.push({ cursor: nextCursor, numItems });
    observer.meta.loadingMore = true;
    const currentValue = observer.currentValue as
      | LocalPaginatedQueryResult
      | undefined;
    if (currentValue) {
      observer.currentValue = {
        ...currentValue,
        status: "LoadingMore",
        loadMore: (nextNumItems: number) =>
          loadMoreLocalPaginatedQuery(observer, nextNumItems),
      };
      for (const listener of Array.from(observer.listeners)) {
        listener();
      }
    }
    observer.depVersions = null;
    void localPaginatedQueryWatches.refresh(observer);
    return true;
  }

  async function evaluateLocalQuery(
    pathName: string,
    args: Record<string, unknown>,
  ): Promise<LocalQueryEvaluation> {
    return withSpan(
      "convex-embedded.evaluateLocalQuery",
      async (span) => {
        const startedAt = nowMs();
        const path = getFunctionPath({ name: pathName });
        const systemFn = SYSTEM_FUNCTIONS[path.udfPath];

        if (systemFn !== undefined) {
          const result = await runSystemFunction(
            systemFn,
            "query",
            args,
            { holdsTransactionLock: false },
          );
          span.setAttributes({
            "convex.query.system": true,
            "convex.query.tables_read": 0,
          });
          return {
            result,
            tablesRead: new Set(),
            dependencies: [],
          };
        }

        const lockStart = nowMs();
        let execStart = lockStart;
        const dependencies: QueryDependency[] = [];
        let result: unknown;
        try {
          result = await runWithTransactionLock(() => {
            execStart = nowMs();
            return executor.executeQuery(path, args, {
              holdsTransactionLock: true,
              dependencies,
            });
          });
        } catch (error) {
          throw new LocalQueryEvaluationError(
            error,
            new Set(dependencies.map((dependency) => dependency.tableName)),
            [...dependencies],
          );
        }
        const lockWaitMs = execStart - lockStart;
        const evalMs = nowMs() - execStart;

        const tablesRead = new Set(
          dependencies.map((dependency) => dependency.tableName),
        );
        span.setAttributes({
          "convex.query.system": false,
          "convex.query.tables_read": tablesRead.size,
          "convex.query.dependencies": dependencies.length,
          "convex.query.lock_wait_ms": lockWaitMs,
        });
        span.setAttribute("convex.udf_path", path.udfPath);
        captureValueAttr(span, "convex.args", args);
        captureValueAttr(span, "convex.result", result);

        runtimeLog.debug(
          `evaluateLocalQuery ${pathName} result.length=${Array.isArray(result) ? result.length : "non-array"} tables=${[...tablesRead].join(",")} eval_ms=${evalMs.toFixed(1)} lock_wait_ms=${lockWaitMs.toFixed(1)} total_ms=${(nowMs() - startedAt).toFixed(1)}`,
        );

        return {
          result,
          tablesRead,
          dependencies,
        };
      },
      {
        attributes: { "convex.query.path": pathName, "convex.source": "local" },
      },
    );
  }

  async function evaluateLocalPaginatedPage(
    pathName: string,
    args: Record<string, unknown>,
    cursor: string | null,
    endCursor: string | null,
    numItems: number,
  ): Promise<{
    result: LocalPaginatedPageResult;
    tablesRead: Set<string>;
    dependencies: QueryDependency[];
  }> {
    const evaluation = await evaluateLocalQuery(pathName, {
      ...args,
      paginationOpts: {
        cursor,
        endCursor,
        numItems,
        id: -1,
      },
    });

    const result = evaluation.result as {
      page?: unknown[];
      isDone?: boolean;
      continueCursor?: string;
      splitCursor?: string | null;
      pageStatus?: "SplitRecommended" | "SplitRequired" | null;
    };

    if (
      !result ||
      !Array.isArray(result.page) ||
      typeof result.isDone !== "boolean" ||
      typeof result.continueCursor !== "string"
    ) {
      throw new Error(
        `[convex-embedded] Local paginated query "${pathName}" did not return a valid pagination result.`,
      );
    }

    return {
      result: {
        page: result.page,
        isDone: result.isDone,
        continueCursor: result.continueCursor,
        splitCursor: result.splitCursor ?? null,
        pageStatus: result.pageStatus ?? null,
      },
      tablesRead: evaluation.tablesRead,
      dependencies: evaluation.dependencies,
    };
  }

  function shutdown(): void {
    if (shutdownFlag) return;
    shutdownFlag = true;
    for (const transport of transports) {
      transport.closeAll();
    }
    transports.length = 0;
    void scope.close();
  }

  async function asyncDispose(): Promise<void> {
    shutdown();
  }

  async function runUdf(
    type: "query" | "mutation" | "action",
    path: FunctionPath,
    args: Record<string, unknown>,
    context: {
      holdsTransactionLock?: boolean;
      identity?: unknown;
      identityKey?: string | null;
      dependencies?: QueryDependency[];
    } = {},
  ): Promise<unknown> {
    return withSpan(
      `convex-embedded.runUdf.${type}`,
      async (span) => {
        if (type === "action") {
          captureValueAttr(span, "convex.args", args);
        }
        const systemFn = SYSTEM_FUNCTIONS[path.udfPath];
        if (systemFn !== undefined) {
          return runSystemFunction(systemFn, type, args, context);
        }

        if (path.componentPath.length > 0) {
          const target = componentRouteTargetLabel(path);
          throw new ConvexError({
            code: "NESTED_COMPONENT_LOCAL_UNSUPPORTED",
            message:
              `[convex-embedded] Local execution reached component function "${target}". ` +
              "Component refs are remote-routed in alpha; move the boundary remote or mark the caller remoteOnly().",
            componentPath: path.componentPath,
            udfPath: path.udfPath,
            target,
          });
        }

        const out = await matchTag({ _tag: type }, "_tag", {
          query: () => {
            const runQuery = () =>
              executor.executeQuery(path, args, {
                holdsTransactionLock: true,
              });
            return context.holdsTransactionLock
              ? runQuery()
              : runWithTransactionLock(runQuery);
          },
          mutation: async () => {
            const runMutation = () =>
              executor.executeMutation(path, args, {
                holdsTransactionLock: true,
              });
            const { result, commit } = context.holdsTransactionLock
              ? await runMutation()
              : await runWithTransactionLock(runMutation);
            onMutationCommit(commit);
            return result;
          },
          action: () => {
            const runAction = () =>
              executor.executeAction(path, args, {
                ...context,
                holdsTransactionLock: true,
              });
            return context.holdsTransactionLock
              ? runAction()
              : runWithTransactionLock(runAction);
          },
        });
        if (type === "action") {
          captureValueAttr(span, "convex.result", out);
        }
        return out;
      },
      {
        attributes: {
          "convex.udf.path": path.udfPath ?? "",
          "convex.udf.component": Array.isArray(path.componentPath)
            ? path.componentPath.join("/")
            : "",
        },
      },
    );
  }

  async function runSystemFunction(
    def: SystemFunctionDef,
    calledAs: "query" | "mutation" | "action",
    args: Record<string, unknown>,
    context: { holdsTransactionLock?: boolean } = {},
  ): Promise<unknown> {
    const incompatibleCall =
      (calledAs === "mutation" && def.type === "query") ||
      (calledAs === "query" && def.type === "mutation");

    if (incompatibleCall) {
      const errorMessage =
        calledAs === "mutation"
          ? "Cannot call a system query as a mutation"
          : "Cannot call a system mutation as a query";
      return Promise.reject(new Error(errorMessage));
    }

    const exec = async (): Promise<unknown> => {
      db.startTransaction();
      try {
        const result = await def.handler(db, args);

        if (def.type === "mutation") {
          onMutationCommit(await db.commitAsync());
        } else {
          db.rollbackWrites();
        }

        return result;
      } catch (e) {
        db.rollbackWrites();
        throw e;
      }
    };

    return context.holdsTransactionLock ? exec() : runWithTransactionLock(exec);
  }

  async function startCronRunner(): Promise<void> {
    try {
      const jobs = await discoverCronJobs(moduleLoader);
      cronRunner.setJobs(jobs);
      cronRunner.start();
      runtimeLog.debug(`cron runner started with ${jobs.length} job(s)`);
    } catch (err) {
      runtimeLog.error("cron runner start failed:", err);
    }
  }

  async function initializeHttpDispatcher(): Promise<void> {
    try {
      httpDispatcher = await createHttpDispatcher(
        moduleLoader,
        executor,
        (fn) => runWithTransactionLock(fn),
      );
      runtimeLog.debug(
        `http dispatcher initialized (hasRoutes=${httpDispatcher.hasRoutes()})`,
      );
    } catch (err) {
      runtimeLog.error("http dispatcher init failed:", err);
    }
  }

  async function dispatchHttpRequest(request: Request): Promise<Response> {
    await storageHydratedRef.current;
    return (httpDispatcher ?? noopHttpDispatcher).dispatch(request);
  }

  async function resumeScheduledFunctions(): Promise<void> {
    const qid = db.startQueryAsync({
      source: {
        type: "FullTableScan",
        tableName: "_scheduled_functions",
        order: "asc",
      },
      operators: [],
    });

    let next = await db.queryNextAsync(qid);
    while (!next.done) {
      const job = next.value as
        | (StoredDocument & {
            name?: string;
            args?: unknown[];
            scheduledTime?: number;
            state?: { kind?: string };
          })
        | null;
      if (
        job &&
        job.state?.kind === "pending" &&
        typeof job.name === "string" &&
        typeof job.scheduledTime === "number"
      ) {
        scheduleRecoveredJob(
          String(job._id),
          job.name,
          Array.isArray(job.args) &&
            job.args[0] &&
            typeof job.args[0] === "object"
            ? (job.args[0] as Record<string, unknown>)
            : {},
          job.scheduledTime,
        );
      }
      next = await db.queryNextAsync(qid);
    }
    db.queryCleanup(qid);
  }

  function scheduleRecoveredJob(
    jobId: string,
    udfPath: string,
    args: Record<string, unknown>,
    scheduledTime: number,
  ): void {
    if (scheduledRecovery.has(jobId)) {
      return;
    }
    scheduledRecovery.add(jobId);

    let timerId: ReturnType<typeof setTimeout>;
    timerId = setTimeout(
      () => {
        activeTimers.delete(timerId);
        scheduledRecovery.delete(jobId);

        runDetached(async () => {
          const job = await db.getAsync(
            "_scheduled_functions",
            jobId as DocumentId,
          );
          const jobState = job?.state as { kind?: string } | null;
          if (job === null || jobState?.kind === "canceled") {
            return;
          }
          if (jobState?.kind !== "pending") {
            return;
          }

          await runWithTransactionLock(async () => {
            db.startTransaction();
            try {
              db.patch("_scheduled_functions", jobId as DocumentId, {
                state: { kind: "inProgress" },
              });
              onMutationCommit(await db.commitAsync());
            } catch (error) {
              db.rollbackWrites();
              throw error;
            }
          });

          let finalState: string;
          try {
            await runUdf("mutation", getFunctionPath({ name: udfPath }), args);
            finalState = "success";
          } catch (error) {
            runtimeLog.error(`recovered scheduled function ${udfPath}:`, error);
            finalState = "failed";
          }

          const finishedJob = await db.getAsync(
            "_scheduled_functions",
            jobId as DocumentId,
          );
          const finishedState = finishedJob?.state as {
            kind?: string;
          } | null;

          if (
            finalState === "failed" ||
            (finishedJob !== null && finishedState?.kind === "inProgress")
          ) {
            await runWithTransactionLock(async () => {
              db.startTransaction();
              try {
                db.patch("_scheduled_functions", jobId as DocumentId, {
                  state: { kind: finalState },
                  ...(finalState === "failed"
                    ? { completedTime: Date.now() }
                    : {}),
                });
                onMutationCommit(await db.commitAsync());
              } catch (error) {
                db.rollbackWrites();
                throw error;
              }
            });
          }
        }, `[convex-embedded] recovered scheduled function ${udfPath}:`);
      },
      Math.max(0, scheduledTime - Date.now()),
    );

    activeTimers.add(timerId);
  }

  async function runWithTransactionLock<T>(fn: () => Promise<T>): Promise<T> {
    await transactionManager.begin(false);

    try {
      const result = await fn();
      transactionManager.commit(false);
      return result;
    } catch (err) {
      transactionManager.rollback(false);
      throw err;
    }
  }

  function buildProtocolExecutor(): ProtocolExecutor {
    return {
      runQuery: async (context, udfPath: string, ...args: unknown[]) => {
        const path = getFunctionPath({ name: udfPath });
        const convexArgs = (args[0] ?? {}) as Record<string, unknown>;
        const dependencies: QueryDependency[] = [];
        const result = (await runWithTransactionLock(() =>
          executor.executeQuery(path, convexArgs, {
            holdsTransactionLock: true,
            identity: context.identity,
            identityKey: context.identityKey,
            dependencies,
          }),
        )) as JSONValue;
        const tablesRead = new Set(
          dependencies.map((dependency) => dependency.tableName),
        );
        return { result, tablesRead, dependencies };
      },

      runMutation: async (context, udfPath: string, ...args: unknown[]) => {
        const path = getFunctionPath({ name: udfPath });
        const convexArgs = (args[0] ?? {}) as Record<string, unknown>;
        const { result, commit } = await runWithTransactionLock(() =>
          executor.executeMutation(path, convexArgs, {
            holdsTransactionLock: true,
            identity: context.identity,
            identityKey: context.identityKey,
          }),
        );
        onMutationCommit(commit);
        return {
          result: result as JSONValue,
          tablesWritten: commit.tablesWritten,
          changes: commitToQueryUpdates(commit.invalidation),
        };
      },

      runAction: async (context, udfPath: string, ...args: unknown[]) => {
        const path = getFunctionPath({ name: udfPath });
        const convexArgs = (args[0] ?? {}) as Record<string, unknown>;
        return (await runUdf("action", path, convexArgs, {
          identity: context.identity,
          identityKey: context.identityKey,
        })) as JSONValue;
      },
    };
  }

  function buildProtocolAuth() {
    return {
      verifyToken: async (token: string) => {
        if (verifyTokenHook) {
          const verified = await verifyTokenHook(token);
          if (!verified) {
            throw new ConvexError({
              code: "AUTH_TOKEN_REJECTED",
              message: "Authentication token rejected",
            });
          }
          return {
            identity: verified,
            identityKey: getIdentityKey(verified as UserIdentity | null),
          };
        }

        if (!token) {
          throw new ConvexError({
            code: "AUTH_TOKEN_MISSING",
            message: "No authentication token provided",
          });
        }
        const identity = await auth.getUserIdentity();
        if (identity === null) {
          throw new ConvexError({
            code: "AUTH_IDENTITY_MISSING",
            message:
              "No identity configured. Call runtime.setIdentity() first.",
          });
        }
        return {
          identity,
          identityKey: getIdentityKey(identity as UserIdentity | null),
        };
      },
    };
  }

  const runtime: EmbeddedRuntime = {
    crypto,
    db,
    moduleLoader,
    executor,
    transactionManager,
    subscriptions,
    protocolQueries,
    syncProtocol,
    sessions,
    writeFanout,
    auth,
    scheduler,
    cronRunner,
    hydrate,
    query,
    paginate,
    resumePersistedState,
    setStorageSurface,
    setUploadQueueEnabled,
    setStorage,
    getStorage,
    getUserTableSpecs,
    extendStorageReady,
    getStorageBlob,
    getStorageMetadata,
    storeUploadedBlob,
    storeUploadedBlobWithMetadata,
    registerUploadUrlSource,
    consumeUploadUrlSource,
    createTransport: makeTransport,
    setIdentity,
    setActiveIdentityKey,
    getIdentity,
    getIdentityKey: getActiveIdentityKey,
    migrateAnonymousDataToIdentity,
    teardownSession,
    handleMessage,
    onMutationCommit,
    pushLocalQueryUpdates,
    ingestDocuments,
    writeDocsFromCache,
    canonicalizeMappedCreate,
    getDocumentsForTable,
    getDocumentsForScope,
    hasLocalDocumentId,
    getDocument,
    subscribeTableWrites,
    watchLocalQuery,
    watchLocalPaginatedQuery,
    refreshLocalQueryWatches,
    executeLocal,
    shutdown,
    dispatchHttpRequest,
    [Symbol.asyncDispose]: asyncDispose,
    _runUdf: runUdf,
    _evaluateLocalQuery: evaluateLocalQuery,
    _evaluateLocalPaginatedPage: evaluateLocalPaginatedPage,
    _buildProtocolAuth: buildProtocolAuth,
    get _crossTabSyncChain() {
      return crossTabSyncChain;
    },
  };
  return runtime;
}
