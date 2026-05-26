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

import { AuthResolver, getIdentityKey } from "@/auth";
import type { UserIdentity } from "@/auth";
import { ModuleLoader } from "@/kernel/modules";
import type { ConvexInput, FunctionPath } from "@/kernel/modules";
import { getFunctionPath } from "@/kernel/modules";
import { SYSTEM_FUNCTIONS } from "@/kernel/system";
import type { SystemFunctionDef } from "@/kernel/system";
import { TransactionManager } from "@/kernel/transaction";
import { UdfExecutor } from "@/kernel/udf";
import { ReplicationProtocolHandler } from "@/replication/protocol";
import type {
  ClientMessage,
  ProtocolChange,
  ProtocolExecutor,
  ServerMessage,
} from "@/replication/protocol";
import { SessionManager } from "@/replication/session";
import { SubscriptionManager } from "@/replication/subscriptions";
import {
  blobShaBase64,
  createAmbientCryptoProvider,
  type EmbeddedCryptoProvider,
} from "@/runtime/crypto";
import { Database } from "@/runtime/db/database";
import type { DatabaseCommitResult } from "@/runtime/db/database";
import { parseSchema } from "@/runtime/db/schema";
import type { ParsedSchema, SchemaExport } from "@/runtime/db/schema";
import type { QueryDependency } from "@/runtime/db/types";
import type { DocumentId, StoredDocument } from "@/runtime/db/types";
import { createHttpDispatcher, type HttpDispatcher } from "@/runtime/http";
import {
  createNoopWriteBroadcast,
  type WriteBroadcast,
} from "@/runtime/platform";
import {
  LocalQueryEvaluationError,
  RuntimeProtocolQueryRegistry,
  RuntimeQueryObserverRegistry,
  type ProtocolQueryRecord,
  type RuntimeQueryObserver,
} from "@/runtime/registry";
import type { StorageSurface } from "@/runtime/storage";
import { createTransport } from "@/runtime/transport";
import type { EmbeddedTransport } from "@/runtime/transport";
import { discoverCronJobs } from "@/scheduler/cron/discover";
import { CronRunner } from "@/scheduler/cron/runner";
import { SchedulerExecutor } from "@/scheduler/executor";
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
import { DisposableScope } from "@/utils/scope";

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

type RuntimeState = {
  schema: ParsedSchema | null;
  storageAdapter: StorageAdapter | null;
  verifyTokenHook: ((token: string) => Promise<UserIdentity | null>) | null;
  crypto: EmbeddedCryptoProvider;
  db: Database;
  moduleLoader: ModuleLoader;
  executor: UdfExecutor;
  transactionManager: TransactionManager;
  subscriptions: SubscriptionManager;
  protocolQueryObservers: RuntimeQueryObserverRegistry<ProtocolQueryRecord>;
  localQueryWatches: RuntimeQueryObserverRegistry<LocalQueryWatchRecord>;
  localPaginatedQueryWatches: RuntimeQueryObserverRegistry<LocalPaginatedWatchRecord>;
  protocolQueries: RuntimeProtocolQueryRegistry;
  auth: AuthResolver;
  syncProtocol: ReplicationProtocolHandler;
  sessions: SessionManager;
  writeFanout: WriteBroadcast;
  scheduler: SchedulerExecutor;
  cronRunner: CronRunner;
};

interface RuntimeInput {
  readonly runtime: EmbeddedRuntime;
  readonly options: EmbeddedRuntimeOptions;
}

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
 * const runtime = new EmbeddedRuntime({
 *   modules,
 *   schema,
 * });
 * const { url, webSocketConstructor } = runtime.createTransport();
 * const client = new ConvexClient(url, { webSocketConstructor });
 * ```
 */
export class EmbeddedRuntime {
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
  private readonly _verifyTokenHook:
    | ((token: string) => Promise<UserIdentity | null>)
    | null;
  readonly scheduler: SchedulerExecutor;
  readonly cronRunner: CronRunner;
  private _httpDispatcher: HttpDispatcher | null = null;
  private readonly _localQueryWatches: RuntimeQueryObserverRegistry<LocalQueryWatchRecord>;
  private readonly _localPaginatedQueryWatches: RuntimeQueryObserverRegistry<LocalPaginatedWatchRecord>;
  private readonly _queryTablesReadCache = new Map<string, Set<string>>();
  private readonly _tableWriteListeners = new Map<
    string,
    Set<(source: "local" | "remote") => void>
  >();
  private readonly _uploadTokenSources = new Map<string, string>();
  private readonly _userTableSpecs: Map<string, InternalTableSpec> | null;

  private _storageAdapter: StorageAdapter | null;
  private _transports: EmbeddedTransport[] = [];
  private _storageHydrated: Promise<void>;
  private _storageHydratedComplete = false;
  private _crossTabSyncChain: Promise<void> = Promise.resolve();
  private _shutdown = false;
  private readonly _scope = new DisposableScope();

  /**
   * Shared set of active timer IDs from scheduled function `setTimeout`
   * calls (via `1.0/schedule` syscall). Cleared on {@link shutdown} to
   * prevent leaked timers accessing the database after teardown.
   */
  private _activeTimers = new Set<ReturnType<typeof setTimeout>>();
  private _scheduledRecovery = new Set<string>();

  constructor(options: EmbeddedRuntimeOptions) {
    if (options.debug === true || readDebugEnvFlag()) {
      setLoggerDebug(true);
    }
    runtimeLog.debug(
      "creating runtime, modules:",
      Object.keys(options.convex.modules).length,
    );
    const state = this._buildRuntimeState({ runtime: this, options });
    this._storageAdapter = state.storageAdapter;
    this._verifyTokenHook = state.verifyTokenHook;
    this.crypto = state.crypto;
    this.db = state.db;
    this.moduleLoader = state.moduleLoader;
    this.executor = state.executor;
    this.transactionManager = state.transactionManager;
    this.subscriptions = state.subscriptions;
    this._localQueryWatches = state.localQueryWatches;
    this._localPaginatedQueryWatches = state.localPaginatedQueryWatches;
    this.protocolQueries = state.protocolQueries;
    this.auth = state.auth;
    this.syncProtocol = state.syncProtocol;
    this.sessions = state.sessions;
    this.writeFanout = state.writeFanout;
    this.scheduler = state.scheduler;
    this.cronRunner = state.cronRunner;
    this._userTableSpecs = state.schema
      ? buildUserTableSpecs(
          state.schema,
          extractOmittedFieldsByTable(options.schema),
        )
      : null;
    if (this._storageAdapter && this._userTableSpecs) {
      const setUserTableSpecs = (
        this._storageAdapter as {
          setUserTableSpecs?: (
            specs: Map<string, InternalTableSpec> | undefined,
          ) => void;
        }
      ).setUserTableSpecs;
      if (typeof setUserTableSpecs === "function") {
        try {
          setUserTableSpecs.call(this._storageAdapter, this._userTableSpecs);
        } catch (error) {
          runtimeLog.warn(
            "failed to install user table specs on storage adapter",
            error,
          );
        }
      }
    }

    this.writeFanout.onNotification((tablesWritten) => {
      this._crossTabSyncChain = this._crossTabSyncChain
        .then(() => this._handleCrossTabSync(tablesWritten))
        .catch((err) => runtimeLog.error("cross-tab sync:", err));
    });

    this._scope.addFinalizer(() => {
      for (const transport of this._transports) {
        transport.closeAll();
      }
      this._transports.length = 0;
      this.scheduler.shutdown();
      this.cronRunner.shutdown();
      for (const timerId of this._activeTimers) {
        clearTimeout(timerId);
      }
      this._activeTimers.clear();
      this._scheduledRecovery.clear();
      this.sessions.clear();
      this.protocolQueries.clear();
      this.subscriptions.clear();
      this._localQueryWatches.clear();
      this._localPaginatedQueryWatches.clear();
      this._tableWriteListeners.clear();
      this.writeFanout.close();
    });
    this._scope.addFinalizer(async () => {
      await this.db.waitForPersistence();
      if (this._storageAdapter?.close) {
        await Promise.resolve(this._storageAdapter.close());
      }
    });

    const hasInitialStorage = options.storage != null;
    const db = this.db;
    const moduleLoader = this.moduleLoader;

    this._storageHydrated = (async () => {
      try {
        if (hasInitialStorage) {
          await db.hydrateSystemTables();
        }
        if (hasInitialStorage) {
          await this._resumeScheduledFunctions();
        }
        await this._startCronRunner();
        await this._initializeHttpDispatcher();
        // Preload user modules so the first user-triggered query / mutation
        // doesn't pay the dynamic-import cost on its critical path. Runs
        // concurrently with the cron / http startup above where it would
        // overlap, but is sequenced last here so failures don't mask
        // hydration errors.
        await moduleLoader.preloadAll();
      } catch (err) {
        storageLog.error("hydration failed:", err);
        throw err;
      } finally {
        this._storageHydratedComplete = true;
      }
    })();
  }

  /**
   * Wait for storage hydration to complete.
   *
   * Hydration starts automatically in the constructor. Callers that need
   * to guarantee the database is populated before proceeding can `await`
   * this method, but it is not required — {@link handleMessage} gates
   * on the same promise internally.
   *
   * @returns A promise that resolves when persisted state and scheduled job
   * recovery have finished loading.
   */
  hydrate(): Promise<void> {
    return this._storageHydrated;
  }

  /**
   * Execute a public Convex query directly against the embedded runtime.
   *
   * This is the runtime-first query helper for SSR flows where you want to
   * render from embedded data without constructing a browser client. The query
   * runs after storage hydration completes.
   *
   * @typeParam Query - The Convex query reference type.
   * @param query - Query reference to execute locally.
   * @param args - Query arguments. Omit for zero-arg queries.
   * @returns The local query result.
   *
   * @example
   * ```ts
   * const tasks = await runtime.query(api.tasks.list, {});
   * ```
   *
   * @see paginate
   * @category Execution
   */
  async query<Query extends FunctionReference<"query">>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<FunctionReturnType<Query>> {
    return (await this.executeLocal({
      kind: "query",
      path: getFunctionName(query),
      args: (args[0] ?? {}) as Record<string, unknown>,
    })) as FunctionReturnType<Query>;
  }

  /**
   * Execute one page of a paginated Convex query against the embedded runtime.
   *
   * This mirrors Convex pagination at the runtime layer by injecting the
   * standard `paginationOpts` argument shape expected by paginated queries.
   * Use it during SSR when first render needs page-shaped data before a browser
   * client exists.
   *
   * @typeParam Query - The Convex query reference type.
   * @param query - Paginated query reference to execute locally.
   * @param args - Query arguments excluding `paginationOpts`.
   * @param options - Pagination options for the requested page.
   * @param options.initialNumItems - Number of documents to request.
   * @param options.cursor - Optional cursor returned by a previous page.
   * @returns The paginated query result returned by the embedded function.
   *
   * @throws {Error} When `initialNumItems` is missing, non-finite, or less than 1.
   *
   * @example
   * ```ts
   * const page = await runtime.paginate(
   *   api.tasks.list,
   *   {},
   *   { initialNumItems: 20 },
   * );
   * ```
   *
   * @see query
   * @category Execution
   */
  async paginate<Query extends FunctionReference<"query">>(
    query: Query,
    ...argsAndOptions: ArgsAndOptions<
      Query,
      {
        initialNumItems: number;
        cursor?: string | null;
      }
    >
  ): Promise<FunctionReturnType<Query>> {
    const [args, options] = argsAndOptions;
    if (!options || !Number.isFinite(options.initialNumItems)) {
      throw new Error(
        "[convex-embedded] paginate requires a finite initialNumItems value.",
      );
    }
    if (options.initialNumItems <= 0) {
      throw new Error(
        "[convex-embedded] paginate requires initialNumItems to be greater than zero.",
      );
    }

    return (await this.executeLocal({
      kind: "query",
      path: getFunctionName(query),
      args: {
        ...((args ?? {}) as Record<string, unknown>),
        paginationOpts: {
          cursor: options.cursor ?? null,
          numItems: options.initialNumItems,
          id: -1,
        },
      },
    })) as FunctionReturnType<Query>;
  }

  async resumePersistedState(): Promise<void> {
    await this._resumeScheduledFunctions();
  }

  /**
   * Install or clear the storage surface used by local file upload helpers.
   *
   * @param surface - Browser/Expo storage surface, or `null` to disable file helpers.
   */
  setStorageSurface(surface: StorageSurface | null): void {
    this.executor.setStorageSurface(surface);
  }

  /**
   * Toggle the storage upload queue. When enabled, every
   * `ctx.storage.store(blob)` call also writes a row into
   * `_resolve_pending_uploads` so the engine can replay the upload to the
   * remote deployment on reconnect. The sync engine flips this on at attach
   * time and off on detach.
   */
  setUploadQueueEnabled(enabled: boolean): void {
    this.executor.setShouldQueueUploads(enabled);
  }

  /**
   * Replace the durable storage adapter backing the runtime.
   *
   * @param storage - Storage adapter for durable writes.
   */
  setStorage(storage: StorageAdapter | null): void {
    if (storage && this._userTableSpecs) {
      const setUserTableSpecs = (
        storage as {
          setUserTableSpecs?: (
            specs: Map<string, InternalTableSpec> | undefined,
          ) => void;
        }
      ).setUserTableSpecs;
      if (typeof setUserTableSpecs === "function") {
        try {
          setUserTableSpecs.call(storage, this._userTableSpecs);
        } catch (error) {
          runtimeLog.warn(
            "failed to install user table specs on storage adapter",
            error,
          );
        }
      }
    }
    this._storageAdapter = storage;
    this.db.setStorage(storage);
  }

  /** Read-only access to the underlying storage adapter, if any. */
  getStorage(): StorageAdapter | null {
    return this._storageAdapter;
  }

  /** Read-only access to the per-table SQL column specs derived from the schema. */
  getUserTableSpecs(): Map<string, InternalTableSpec> | null {
    return this._userTableSpecs;
  }

  /** Chain an additional readiness promise into the hydration gate. */
  extendStorageReady(ready: Promise<void>): void {
    const prior = this._storageHydrated;
    this._storageHydratedComplete = false;
    this._storageHydrated = (async () => {
      try {
        await prior;
        await ready;
      } finally {
        this._storageHydratedComplete = true;
      }
    })();
  }

  /**
   * Read a blob stored in the embedded `_storage` table.
   *
   * @param storageId - Embedded storage id.
   * @returns The blob, or `null` when the storage id is unknown.
   */
  async getStorageBlob(storageId: string): Promise<Blob | null> {
    await this._storageHydrated;
    const started = globalThis.performance?.now?.() ?? Date.now();
    const blob = await this.db.loadFile(storageId as DocumentId);
    storageLog.debug(
      `getStorageBlob(${storageId}) -> ${blob === null ? "null" : `${blob.size} bytes`} in ${((globalThis.performance?.now?.() ?? Date.now()) - started).toFixed(1)}ms`,
    );
    return blob;
  }

  async getStorageMetadata(
    storageId: string,
  ): Promise<Record<string, unknown> | null> {
    await this._storageHydrated;
    const metadata = (await this.db.getAsync(
      "_storage",
      storageId as DocumentId,
    )) as Record<string, unknown> | null;
    storageLog.debug(
      `getStorageMetadata(${storageId}) -> ${metadata === null ? "null" : "found"}`,
    );
    return metadata;
  }

  async storeUploadedBlob(blob: Blob): Promise<string> {
    return this.storeUploadedBlobWithMetadata(blob, {});
  }

  /**
   * Persist a blob and optional upload provenance metadata in the embedded
   * `_storage` table.
   *
   * @param blob - Blob to persist locally.
   * @param metadata - Optional metadata such as the upload URL source ref.
   * @returns The generated embedded storage id.
   */
  async storeUploadedBlobWithMetadata(
    blob: Blob,
    metadata: { uploadSourceRef?: string },
  ): Promise<string> {
    await this._storageHydrated;
    storageLog.info(
      `storeUploadedBlob start (${blob.size} bytes, ${blob.type || "unknown type"})`,
    );

    this.db.startTransaction();
    try {
      const sha256 = await blobShaBase64(blob, this.crypto);
      storageLog.debug(
        `computed blob sha256 for upload (${sha256.slice(0, 12)}...)`,
      );
      const storageId = this.db.insert("_storage", {
        size: blob.size,
        sha256,
        contentType: blob.type || undefined,
        uploadSourceRef: metadata.uploadSourceRef,
      });
      await this.db.storeFile(storageId, blob);
      const commit = await this.db.commitAsync();
      this.onMutationCommit(commit);
      storageLog.info(`storeUploadedBlob committed as ${storageId}`);
      return storageId as string;
    } catch (error) {
      this.db.rollbackWrites();
      storageLog.error("storeUploadedBlob failed", error);
      throw error;
    }
  }

  /**
   * Associate an upload URL token with the Convex function that generated it.
   *
   * @param uploadUrl - Signed upload URL emitted by a remote function.
   * @param refName - Function reference name that produced the URL.
   */
  registerUploadUrlSource(uploadUrl: string, refName: string): void {
    const token = this.extractUploadToken(uploadUrl);
    if (token !== null) {
      this._uploadTokenSources.set(token, refName);
    }
  }

  /**
   * Consume and clear the function reference associated with an upload token.
   *
   * @param token - Upload token extracted from an embedded upload URL.
   * @returns The originating function reference name, if known.
   */
  consumeUploadUrlSource(token: string): string | undefined {
    const refName = this._uploadTokenSources.get(token);
    this._uploadTokenSources.delete(token);
    return refName;
  }

  private extractUploadToken(uploadUrl: string): string | null {
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

  /**
   * Build the transport config that ConvexClient needs.
   *
   * Returns `{ url, webSocketConstructor }` — pass these to the
   * `ConvexClient` constructor.
   *
   * @returns Loopback transport config for a `ConvexClient` instance.
   */
  createTransport(ready?: Promise<void>): EmbeddedTransport {
    const transport = createTransport(this, ready);
    this._transports.push(transport);
    return transport;
  }

  /**
   * Set (or clear) the current user identity.
   * Delegates to the {@link AuthResolver} and updates the active storage
   * identity key.
   *
   * @param identity - Identity to install, or `null` to clear auth state.
   */
  setIdentity(identity: UserIdentity | null): void {
    this.auth.setIdentity(identity);
    this.db.setActiveIdentityKey(getIdentityKey(identity));
  }

  /**
   * Set the active storage identity key directly.
   *
   * @param identityKey - Identity partition key for persisted local data.
   */
  setActiveIdentityKey(identityKey: string | null): void {
    this.db.setActiveIdentityKey(identityKey);
  }

  /**
   * Read the current embedded identity.
   *
   * @returns The active user identity, or `null` when unauthenticated.
   */
  getIdentity(): UserIdentity | null {
    return this.auth.peekUserIdentity();
  }

  /**
   * Read the active storage identity key.
   *
   * @returns The current identity partition key used by persisted local data.
   */
  getIdentityKey(): string | null {
    return this.db.getActiveIdentityKey();
  }

  /**
   * Move anonymous local data into an authenticated identity partition.
   *
   * @param identityKey - Authenticated identity key to migrate anonymous rows into.
   */
  async migrateAnonymousDataToIdentity(identityKey: string): Promise<void> {
    await this._storageHydrated;

    const tablesWritten = new Set<string>();
    this.db.startTransaction();
    try {
      for (const tableName of this.db.migrateAnonymousDataToIdentity(
        identityKey,
      )) {
        tablesWritten.add(tableName);
      }
      const commit = await this.db.commitAsync();
      this.onMutationCommit(commit);
    } catch (error) {
      this.db.rollbackWrites();
      throw error;
    }

    for (const tableName of await this.db.reStampAnonymousUserTablesInStorage(
      identityKey,
    )) {
      tablesWritten.add(tableName);
    }

    if (tablesWritten.size === 0) {
      await this.refreshLocalQueryWatches();
      return;
    }

    this.db.bumpTableVersions(tablesWritten);
    this.subscriptions.invalidate(tablesWritten);
    const updates = await this.syncProtocol.reEvaluateQueries(
      Array.from(tablesWritten).map((tableName) => ({
        tableName,
        before: null,
        after: null,
      })),
    );
    await this.refreshLocalQueryWatches();
    await this._pushProtocolUpdates(updates);
  }

  /**
   * Remove a sync-protocol session and stop routing messages to it.
   *
   * @param sessionId - Protocol session id to tear down.
   */
  teardownSession(sessionId: string): void {
    this.syncProtocol.deleteSession(sessionId);
  }

  private async _buildLocalDocumentMap(
    table: string,
    scopeArgs?: Record<string, unknown>,
    candidateIds?: ReadonlySet<string>,
  ): Promise<Map<string, StoredDocument>> {
    if (candidateIds !== undefined) {
      const entries = await Promise.all(
        [...candidateIds].map(
          async (id): Promise<[string, StoredDocument] | null> => {
            const doc = await this.db.getAsync(table, id as DocumentId);
            return doc !== null && this._documentMatchesScope(doc, scopeArgs)
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
    return (await this.db.listDocumentsAsync(table)).reduce((acc, doc) => {
      if (this._documentMatchesScope(doc, scopeArgs)) {
        acc.set(doc._id as string, doc);
      }
      return acc;
    }, new Map<string, StoredDocument>());
  }

  private _documentMatchesScope(
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

  private _buildRemoteDocumentMap(
    remoteDocs: Array<Record<string, unknown>>,
  ): Map<string, Record<string, unknown>> {
    return remoteDocs.reduce((acc, doc) => {
      const id = doc._id;
      return typeof id === "string" ? acc.set(id, doc) : acc;
    }, new Map<string, Record<string, unknown>>());
  }

  private _diffIngestDocuments(
    localMap: Map<string, StoredDocument>,
    remoteMap: Map<string, Record<string, unknown>>,
    options?: IngestDocumentsOptions,
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

    if (options?.deleteAbsent === false) {
      return { toDelete: [], toUpsert };
    }

    const keepIds = options?.keepIds;
    const toDelete = [...localMap.keys()].filter(
      (id) => !remoteMap.has(id) && !(keepIds?.has(id) ?? false),
    );

    return { toDelete, toUpsert };
  }

  private async _pushProtocolUpdates(
    updates: Map<string, ServerMessage[]>,
  ): Promise<void> {
    for (const [sessionId, messages] of updates) {
      for (const message of messages) {
        const data = JSON.stringify(message);
        for (const transport of this._transports) {
          transport.pushMessage(sessionId, data);
        }
      }
    }
  }

  /**
   * Route a raw JSON message from the loopback WebSocket to the sync
   * protocol handler. Returns an array of JSON response strings.
   *
   * This is the method that {@link createTransport} binds to — it
   * satisfies the `ProtocolHandler` interface expected by the transport.
   */
  async handleMessage(message: string): Promise<string[]> {
    await this._storageHydrated;

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
      const responses: ServerMessage[] = await this.syncProtocol.handleMessage(
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

  /**
   * Called after a mutation commits. Invalidates local subscriptions and
   * schedules cross-tab fanout after the storage write settles.
   */
  onMutationCommit(commit: DatabaseCommitResult): void {
    if (commit.tablesWritten.size === 0) return;
    const startedAt = nowMs();

    this.db.bumpTableVersions(commit.tablesWritten);

    const changes = this._commitToQueryUpdates(commit.invalidation);
    const tablesWritten = commit.invalidation.tables;
    const invalidateStart = nowMs();
    if (changes.length > 0) {
      this.subscriptions.invalidate(changes);
    } else if (tablesWritten.size > 0) {
      this.subscriptions.invalidate(tablesWritten);
    }
    const invalidateMs = nowMs() - invalidateStart;
    this._notifyTableWriteListeners(tablesWritten);
    runDetached(
      () => this._notifyCrossTabAfterStorage(commit),
      "[convex-embedded] post-commit fanout failed:",
    );
    runtimeLog.debug(
      `onMutationCommit tables=${[...tablesWritten].join(",")} changes=${changes.length} invalidate_ms=${invalidateMs.toFixed(1)} total_ms=${(nowMs() - startedAt).toFixed(1)}`,
    );
  }

  private _notifyTableWriteListeners(
    tablesWritten: Iterable<string>,
    source: "local" | "remote" = "local",
  ): void {
    for (const tableName of tablesWritten) {
      const listeners = this._tableWriteListeners.get(tableName);
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

  private _commitToQueryUpdates(batch: {
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

  async pushLocalQueryUpdates(commit: DatabaseCommitResult): Promise<void> {
    return withSpan("convex-embedded.pushLocalQueryUpdates", async (span) => {
      if (commit.tablesWritten.size === 0) {
        span.setAttributes({ "convex.commit.tables_written": 0 });
        return;
      }
      span.setAttributes({
        "convex.commit.tables_written": commit.tablesWritten.size,
      });

      const changes = this._commitToQueryUpdates(commit.invalidation);
      span.setAttributes({ "convex.commit.changes": changes.length });
      if (changes.length === 0) return;

      const updates = await this.syncProtocol.reEvaluateQueries(changes);
      await this._pushProtocolUpdates(updates);
    });
  }

  private async _notifyCrossTabAfterStorage(
    commit: DatabaseCommitResult,
  ): Promise<void> {
    try {
      await commit.persisted;
      this.writeFanout.notify(commit.tablesWritten);
    } catch (err) {
      runtimeLog.error("skipping cross-tab notify after storage failure:", err);
    }
  }

  /**
   * Handle a cross-tab write notification from another tab.
   *
   * 1. Re-read the affected tables from IndexedDB (each tab's wa-sqlite
   *    worker reads the same shared database).
   * 2. Re-evaluate all active queries against the now-updated in-memory
   *    database.
   * 3. Push `Transition` messages through the loopback WebSocket so the
   *    ConvexClient sees the updated query results instantly.
   */
  private async _handleCrossTabSync(tablesWritten: Set<string>): Promise<void> {
    try {
      const tablesToSync = Array.from(tablesWritten).filter(
        (table) =>
          !(
            this._storageAdapter != null && isQueryable(this._storageAdapter)
          ) || this.db.isTableHydrationAttempted(table),
      );
      await Promise.all(
        tablesToSync.map((table) => this.db.replicateTable(table)),
      );

      const updates = await this.syncProtocol.reEvaluateQueries(
        Array.from(tablesWritten).map((tableName) => ({
          tableName,
          before: null,
          after: null,
        })),
      );
      await this.refreshLocalQueryWatches();
      this._notifyTableWriteListeners(tablesWritten, "remote");

      for (const [sessionId, messages] of updates) {
        for (const msg of messages) {
          const data = JSON.stringify(msg);
          for (const transport of this._transports) {
            transport.pushMessage(sessionId, data);
          }
        }
      }
    } catch (err) {
      runtimeLog.error("cross-tab remote failed:", err);
    }
  }

  /**
   * Ingest authoritative documents from a remote source into the local
   * embedded database.
   *
   * This is the primary mechanism for receiving reactive query results
   * from a remote Convex backend. The method:
   *
   *  1. Diffs the incoming documents against the current local state.
   *  2. Applies only the actual changes (inserts, updates, deletes)
   *     within a single transaction.
   *  3. Persists to IndexedDB (via the storage adapter).
   *  4. Invalidates local subscriptions and notifies other tabs.
   *  5. Re-evaluates all active queries and pushes `Transition`
   *     messages to every connected `ConvexClient`.
   *
   * If the incoming data is identical to the local state the method
   * is a no-op — no transaction is opened and no notifications fire.
   *
   * @param table       The table name to ingest into.
   * @param remoteDocs  Authoritative documents from the remote backend.
   *                    Each must have `_id` (string) and `_creationTime`
   *                    (number) fields.
   */
  async ingestDocuments(
    table: string,
    remoteDocs: Array<Record<string, unknown>>,
    scopeArgs?: Record<string, unknown>,
    options?: IngestDocumentsOptions,
  ): Promise<void> {
    try {
      await this._storageHydrated;

      const remoteMap = this._buildRemoteDocumentMap(remoteDocs);
      const localMap = await this._buildLocalDocumentMap(
        table,
        scopeArgs,
        options?.deleteAbsent === false ? new Set(remoteMap.keys()) : undefined,
      );
      const { toDelete, toUpsert } = this._diffIngestDocuments(
        localMap,
        remoteMap,
        options,
      );

      if (toUpsert.length === 0 && toDelete.length === 0) {
        return;
      }

      runtimeLog.debug(
        `ingestDocuments("${table}"): ` +
          `${toUpsert.length} upsert(s), ${toDelete.length} delete(s)`,
      );

      this.db.startTransaction();
      try {
        for (const doc of toUpsert) {
          this.db.writeDocument(table, doc);
        }
        for (const id of toDelete) {
          this.db.deleteDocument(table, id as unknown as DocumentId);
        }
        const commit = await this.db.commitAsync();

        this.db.bumpTableVersions(commit.tablesWritten);

        const changes = this._commitToQueryUpdates(commit.invalidation);
        const tablesWritten = commit.invalidation.tables;
        if (changes.length > 0) {
          this.subscriptions.invalidate(changes);
        } else if (tablesWritten.size > 0) {
          this.subscriptions.invalidate(tablesWritten);
        }
        this._notifyTableWriteListeners(tablesWritten, "remote");
        runDetached(
          () => this._notifyCrossTabAfterStorage(commit),
          "[convex-embedded] post-commit fanout failed:",
        );
      } catch (e) {
        this.db.rollbackWrites();
        throw e;
      }

      const updates = await this.syncProtocol.reEvaluateQueries([
        { tableName: table, before: null, after: null },
      ]);
      await this._pushProtocolUpdates(updates);
    } catch (err) {
      runtimeLog.error(`ingestDocuments("${table}") failed:`, err);
      throw err;
    }
  }

  async upsertDocsFromCache(
    table: string,
    docs: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (docs.length === 0) return;
    const totalStart = nowMs();
    try {
      await this._storageHydrated;
    } catch {
      return;
    }

    const candidates = docs.filter(
      (doc): doc is Record<string, unknown> & { _id: string } =>
        typeof doc?._id === "string",
    );
    if (candidates.length === 0) return;

    const tableSpec = this._userTableSpecs?.get(table) ?? null;
    const requiredFields = tableSpec
      ? Object.entries(tableSpec.fields)
          .filter(([, spec]) => spec.notNull === true)
          .map(([name]) => name)
      : [];
    const knownFields = tableSpec
      ? new Set(Object.keys(tableSpec.fields))
      : null;

    const docHasRequired = (doc: Record<string, unknown>): boolean => {
      if (requiredFields.length === 0) return true;
      for (const field of requiredFields) {
        if (doc[field] === undefined || doc[field] === null) return false;
      }
      return true;
    };

    const stripUnknownFields = (
      doc: Record<string, unknown>,
    ): Record<string, unknown> => {
      if (!knownFields) return doc;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(doc)) {
        if (key === "_id" || key === "_creationTime" || knownFields.has(key)) {
          out[key] = doc[key];
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
      const existing = this.db.get(
        table,
        doc._id as unknown as DocumentId,
      ) as Record<string, unknown> | null;
      const existingCreationTime =
        typeof existing?._creationTime === "number"
          ? (existing._creationTime as number)
          : null;
      const docCreationTime =
        typeof doc._creationTime === "number"
          ? (doc._creationTime as number)
          : null;

      if (existing === null) {
        if (!docHasRequired(doc)) {
          skippedPartial += 1;
          continue;
        }
        const stripped = stripUnknownFields(doc);
        if (docCreationTime !== null) {
          merged.push(
            stripped as Record<string, unknown> & {
              _id: string;
              _creationTime: number;
            },
          );
        } else {
          merged.push({
            ...stripped,
            _creationTime: 0,
          } as Record<string, unknown> & {
            _id: string;
            _creationTime: number;
          });
        }
        continue;
      }

      const candidateNext = {
        ...existing,
        ...doc,
        _id: doc._id,
        _creationTime: docCreationTime ?? existingCreationTime ?? 0,
      };
      const next = stripUnknownFields(candidateNext) as Record<
        string,
        unknown
      > & { _id: string; _creationTime: number };

      if (!docHasRequired(next)) {
        skippedPartial += 1;
        continue;
      }

      if (!structuralEqual(existing, next)) {
        merged.push(next);
      }
    }
    const diffMs = nowMs() - diffStart;

    if (merged.length === 0) {
      runtimeLog.debug(
        `upsertDocsFromCache ${table} candidates=${candidates.length} merged=0 skipped_partial=${skippedPartial} diff_ms=${diffMs.toFixed(1)} total_ms=${(nowMs() - totalStart).toFixed(1)}`,
      );
      return;
    }

    const writeStart = nowMs();
    this.db.startTransaction();
    try {
      for (const doc of merged) {
        try {
          this.db.writeDocument(table, doc, { validate: false });
        } catch {
          /* skip per-doc errors (id collision across tables, etc.) */
        }
      }
      const commit = await this.db.commitAsync();
      this.db.bumpTableVersions(commit.tablesWritten);
      const tablesWritten = commit.invalidation.tables;
      if (tablesWritten.size > 0) {
        this.subscriptions.invalidate(tablesWritten);
      }
    } catch {
      this.db.rollbackWrites();
    }
    runtimeLog.debug(
      `upsertDocsFromCache ${table} candidates=${candidates.length} merged=${merged.length} skipped_partial=${skippedPartial} diff_ms=${diffMs.toFixed(1)} write_ms=${(nowMs() - writeStart).toFixed(1)} total_ms=${(nowMs() - totalStart).toFixed(1)}`,
    );
  }

  async canonicalizeMappedCreate(input: {
    localId: string;
    remoteId: string;
    tableName: string;
    schemas: Record<string, Definition>;
  }): Promise<void> {
    await this._storageHydrated;

    const orderedTableNames = [
      input.tableName,
      ...Object.keys(input.schemas).filter(
        (candidate) => candidate !== input.tableName,
      ),
    ];

    const db = this.db;
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
        const remoteMap = this._buildRemoteDocumentMap(documents);
        const { toDelete, toUpsert } = this._diffIngestDocuments(
          localMap,
          remoteMap,
        );

        for (const doc of toUpsert) {
          db.writeDocument(currentTableName, doc, { validate: false });
        }
        for (const id of toDelete) {
          db.deleteDocument(currentTableName, id as DocumentId);
        }
      }

      commit = await db.commitAsync();
      committed = true;
      this.onMutationCommit(commit);
    } catch (error) {
      if (!committed) {
        db.rollbackWrites();
      }
      throw error;
    }

    if (commit.tablesWritten.size === 0) {
      return;
    }

    await this.pushLocalQueryUpdates(commit);
  }

  /**
   * Return all documents for a given table from the local embedded database.
   *
   * Waits for storage hydration before reading so the result includes
   * persisted data (not just the empty in-memory state).
   *
   * @param table - The table name to read.
   * @returns All currently materialized documents for the table.
   */
  async getDocumentsForTable(
    table: string,
  ): Promise<Array<Record<string, unknown>>> {
    await this._storageHydrated;
    return (await this.db.listDocumentsAsync(table)) as Array<
      Record<string, unknown>
    >;
  }

  async getDocumentsForScope(
    table: string,
    scopeArgs: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>> | null> {
    await this._storageHydrated;
    return (await this.db.listDocumentsForScopeAsync(
      table,
      scopeArgs,
    )) as Array<Record<string, unknown>> | null;
  }

  /**
   * Check whether any local table currently contains the given document id.
   *
   * @param id - Document id to probe.
   * @returns `true` when the id exists locally in any table.
   */
  hasLocalDocumentId(id: string): boolean {
    return this.db.getTableForId(id) !== undefined;
  }

  /**
   * Read one document from a specific table.
   *
   * @param table - Table name to read from.
   * @param id - Document id.
   * @returns The current local document, or `null` when absent.
   */
  async getDocument(
    table: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    await this._storageHydrated;
    return (
      ((await this.db.getAsync(table, id as DocumentId)) as Record<
        string,
        unknown
      > | null) ?? null
    );
  }

  /**
   * Subscribe to writes affecting one local table.
   *
   * @param table - Table name to watch.
   * @param callback - Listener invoked after local or remote writes land.
   * @returns A subscription handle with `unsubscribe()`.
   */
  subscribeTableWrites(
    table: string,
    callback: (source: "local" | "remote") => void,
  ): TableWriteSubscription {
    const listeners =
      this._tableWriteListeners.get(table) ??
      new Set<(source: "local" | "remote") => void>();
    listeners.add(callback);
    this._tableWriteListeners.set(table, listeners);

    return {
      unsubscribe: () => {
        const current = this._tableWriteListeners.get(table);
        if (!current) {
          return;
        }
        current.delete(callback);
        if (current.size === 0) {
          this._tableWriteListeners.delete(table);
        }
      },
    };
  }

  /**
   * Watch a local query and receive push-style updates when its result changes.
   *
   * @typeParam T - Query result type.
   * @param path - Canonical query name.
   * @param args - Serializable query arguments.
   * @returns A watch handle with synchronous snapshot accessors.
   */
  watchLocalQuery<T = unknown>(
    path: string,
    args: Record<string, unknown>,
  ): LocalQueryWatch<T> {
    const token = this._localQueryToken(path, args);
    const observer = this._getOrCreateLocalQueryWatch(token, path, args);

    return {
      onUpdate: (callback) => {
        const unsubscribe = this._localQueryWatches.subscribe(token, callback);
        const current = this._localQueryWatches.get(token) ?? observer;
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
        const current = this._localQueryWatches.get(token) ?? observer;
        if (current.currentError) {
          throw current.currentError;
        }
        return current.hasValue ? (current.currentValue as T) : undefined;
      },
      localQueryLogs: () => {
        const current = this._localQueryWatches.get(token) ?? observer;
        return current.currentLogs;
      },
    };
  }

  /**
   * Watch a local paginated query and load additional pages on demand.
   *
   * @typeParam T - Row type returned by the paginated query.
   * @param path - Canonical query name.
   * @param args - Serializable query arguments excluding pagination opts.
   * @param options - Initial pagination configuration.
   * @returns A watch handle with the current paginated snapshot.
   */
  watchLocalPaginatedQuery<T = unknown>(
    path: string,
    args: Record<string, unknown>,
    options: { initialNumItems: number },
  ): LocalPaginatedQueryWatch<T> {
    const token = this._localPaginatedQueryToken(
      path,
      args,
      options.initialNumItems,
    );
    const observer = this._getOrCreateLocalPaginatedQueryWatch(
      token,
      path,
      args,
      options.initialNumItems,
    );

    return {
      onUpdate: (callback) => {
        const unsubscribe = this._localPaginatedQueryWatches.subscribe(
          token,
          callback,
        );
        const current = this._localPaginatedQueryWatches.get(token) ?? observer;
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
        const current = this._localPaginatedQueryWatches.get(token) ?? observer;
        if (current.currentError) {
          throw current.currentError;
        }
        return current.currentValue as LocalPaginatedQueryResult<T> | undefined;
      },
      localQueryLogs: () => {
        const current = this._localPaginatedQueryWatches.get(token) ?? observer;
        return current.currentLogs;
      },
    };
  }

  async refreshLocalQueryWatches(): Promise<void> {
    return withSpan(
      "convex-embedded.refreshLocalQueryWatches",
      async (span) => {
        const queryCount =
          this._localQueryWatches.values().length +
          this._localPaginatedQueryWatches.values().length;
        span.setAttributes({ "convex.watches.count": queryCount });
        await Promise.all([
          this._localQueryWatches.refreshAll(),
          this._localPaginatedQueryWatches.refreshAll(),
        ]);
      },
    );
  }

  /**
   * Execute a local function directly against the embedded runtime.
   *
   * This is the unified runtime-first execution primitive used by browser
   * routing. Mutations may optionally apply local subscription/query-update
   * effects immediately.
   *
   * @internal
   */
  async executeLocal(request: LocalExecutionRequest): Promise<unknown> {
    if (!this._storageHydratedComplete) {
      await this._storageHydrated;
    }

    return this._executeLocalResolved(request);
  }

  private async _executeLocalResolved(
    request: LocalExecutionRequest,
  ): Promise<unknown> {
    if (!this._storageHydratedComplete) {
      await this._storageHydrated;
    }
    return matchTag(request, "kind", {
      query: async (current) => {
        const path = getFunctionPath({ name: current.path });
        const systemFn = SYSTEM_FUNCTIONS[path.udfPath];
        if (systemFn !== undefined) {
          return this._runSystemFunction(systemFn, "query", current.args);
        }
        return withSpan("convex-embedded.executeLocal.query", async (span) => {
          span.setAttribute("convex.udf_path", path.udfPath);
          captureValueAttr(span, "convex.args", current.args);
          const result = await this._runUdf("query", path, current.args);
          captureValueAttr(span, "convex.result", result);
          return result;
        });
      },
      mutation: async (current) => {
        const functionPath = getFunctionPath({ name: current.path });
        const systemFn = SYSTEM_FUNCTIONS[functionPath.udfPath];
        if (systemFn !== undefined) {
          return await this._runSystemFunction(
            systemFn,
            "mutation",
            current.args,
            {
              holdsTransactionLock: false,
            },
          );
        }
        return withSpan(
          "convex-embedded.executeLocal.mutation",
          async (span) => {
            span.setAttribute("convex.udf_path", functionPath.udfPath);
            captureValueAttr(span, "convex.args", current.args);
            const runMutation = () =>
              this.executor.executeMutation(functionPath, current.args, {
                holdsTransactionLock: true,
              });
            const { result, commit } =
              await this._runWithTransactionLock(runMutation);

            if (current.applyLocalEffects) {
              this.onMutationCommit(commit);
            }

            captureValueAttr(span, "convex.result", result);
            return result;
          },
        );
      },
      action: (current) =>
        this._runUdf(
          "action",
          getFunctionPath({ name: current.path }),
          current.args,
        ),
    });
  }

  private _localQueryToken(
    path: string,
    args: Record<string, unknown>,
  ): string {
    return `${path}:${stableValueKey(args)}`;
  }

  private _localPaginatedQueryToken(
    path: string,
    args: Record<string, unknown>,
    initialNumItems: number,
  ): string {
    return `${path}:${stableValueKey(args)}:paginated:${initialNumItems}`;
  }

  private _getOrCreateLocalQueryWatch(
    token: string,
    path: string,
    args: Record<string, unknown>,
  ): RuntimeQueryObserver<LocalQueryWatchRecord> {
    const existing = this._localQueryWatches.get(token);
    if (existing) {
      return existing;
    }

    const record: LocalQueryWatchRecord = {
      path,
      args,
    };

    const observer = this._localQueryWatches.ensure(token, record, () =>
      this._evaluateHydratedLocalQuery(path, args),
    );
    void this._localQueryWatches.refresh(observer);
    return observer;
  }

  private _getOrCreateLocalPaginatedQueryWatch(
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

    const observer = this._localPaginatedQueryWatches.ensure(
      token,
      initialMeta,
      () => this._evaluateHydratedLocalPaginatedWatch(observer),
    );
    void this._localPaginatedQueryWatches.refresh(observer);
    return observer;
  }

  private async _evaluateOnePaginatedPage(
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
      evaluated = await this._evaluatePaginatedPageCached(
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

  private _pruneStalePaginatedPageCache(
    observer: RuntimeQueryObserver<LocalPaginatedWatchRecord>,
    liveKeys: Set<string>,
  ): void {
    for (const key of Array.from(observer.meta.pageCache.keys())) {
      if (!liveKeys.has(key)) observer.meta.pageCache.delete(key);
    }
  }

  private _finalizePaginatedWatch(
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
          this._loadMoreLocalPaginatedQuery(observer, numItems),
      },
      tablesRead,
      dependencies,
    };
  }

  private async _evaluateLocalPaginatedWatch(
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
        const { result, cacheKey } = await this._evaluateOnePaginatedPage(
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
      this._pruneStalePaginatedPageCache(observer, liveKeys);
      if (!this._applyPaginatedSplits(observer, pageResults)) break;
    }

    return this._finalizePaginatedWatch(
      observer,
      pageResults,
      tablesRead,
      dependencies,
    );
  }

  private _applyPaginatedSplits(
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

  private async _evaluatePaginatedPageCached(
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
    if (cached !== undefined && this._depVersionsFresh(cached.depVersions)) {
      return {
        result: cached.result,
        tablesRead: cached.tablesRead,
        dependencies: cached.dependencies,
      };
    }

    const evaluated = await this._evaluateLocalPaginatedPage(
      observer.meta.path,
      observer.meta.args,
      cursor,
      endCursor,
      numItems,
    );

    const depVersions = new Map<string, number>();
    for (const table of evaluated.tablesRead) {
      depVersions.set(table, this.db.getTableVersion(table));
    }
    observer.meta.pageCache.set(cacheKey, {
      result: evaluated.result,
      tablesRead: evaluated.tablesRead,
      dependencies: evaluated.dependencies,
      depVersions,
    });
    return evaluated;
  }

  private _depVersionsFresh(depVersions: Map<string, number>): boolean {
    for (const [table, version] of depVersions) {
      if (this.db.getTableVersion(table) !== version) {
        return false;
      }
    }
    return true;
  }

  private async _evaluateHydratedLocalQuery(
    pathName: string,
    args: Record<string, unknown>,
  ): Promise<LocalQueryEvaluation> {
    await this._awaitTableHydrationFor(pathName);
    const evaluation = await this._evaluateLocalQuery(pathName, args);
    this._recordQueryTablesRead(pathName, evaluation.tablesRead);
    return evaluation;
  }

  private async _evaluateHydratedLocalPaginatedWatch(
    observer: RuntimeQueryObserver<LocalPaginatedWatchRecord>,
  ): Promise<LocalQueryEvaluation> {
    await this._awaitTableHydrationFor(observer.meta.path);
    const evaluation = await this._evaluateLocalPaginatedWatch(observer);
    this._recordQueryTablesRead(observer.meta.path, evaluation.tablesRead);
    return evaluation;
  }

  private async _awaitTableHydrationFor(pathName: string): Promise<void> {
    const cached = this._queryTablesReadCache.get(pathName);
    if (cached === undefined) {
      if (this._storageHydratedComplete) return;
      await this._storageHydrated;
      return;
    }
    if (cached.size === 0) {
      return;
    }
    if (this._storageHydratedComplete) return;
    await Promise.all(
      Array.from(cached, (tableName) => this.db.tableHydrated(tableName)),
    );
  }

  private _recordQueryTablesRead(
    pathName: string,
    tablesRead: Set<string>,
  ): void {
    const existing = this._queryTablesReadCache.get(pathName);
    if (existing === undefined) {
      this._queryTablesReadCache.set(pathName, new Set(tablesRead));
      return;
    }
    for (const tableName of tablesRead) {
      existing.add(tableName);
    }
  }

  private _loadMoreLocalPaginatedQuery(
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
          this._loadMoreLocalPaginatedQuery(observer, nextNumItems),
      };
      for (const listener of Array.from(observer.listeners)) {
        listener();
      }
    }
    observer.depVersions = null;
    void this._localPaginatedQueryWatches.refresh(observer);
    return true;
  }

  private async _evaluateLocalQuery(
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
          const result = await this._runSystemFunction(
            systemFn,
            "query",
            args,
            {
              holdsTransactionLock: false,
            },
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
          result = await this._runWithTransactionLock(() => {
            execStart = nowMs();
            return this.executor.executeQuery(path, args, {
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

  private async _evaluateLocalPaginatedPage(
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
    const evaluation = await this._evaluateLocalQuery(pathName, {
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

  /** Tear down all resources. */
  shutdown(): void {
    if (this._shutdown) return;
    this._shutdown = true;
    for (const transport of this._transports) {
      transport.closeAll();
    }
    this._transports.length = 0;
    void this._scope.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.shutdown();
  }

  /**
   * Central dispatch for running Convex UDFs. Used by:
   * - The `runUdf` callback wired into syscalls (for nested calls)
   * - The protocol executor bridge (for top-level calls from clients)
   * - The scheduler (for deferred function execution)
   *
   * System functions (paths starting with `_system:`) are intercepted
   * here and executed directly against the database — they bypass the
   * module loader and UDF executor entirely.
   *
   * After a mutation executes, the commit result is inspected and
   * subscriptions + fanout are notified of written tables.
   */
  private async _runUdf(
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
          return this._runSystemFunction(systemFn, type, args, context);
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
              this.executor.executeQuery(path, args, {
                holdsTransactionLock: true,
              });
            return context.holdsTransactionLock
              ? runQuery()
              : this._runWithTransactionLock(runQuery);
          },
          mutation: async () => {
            const runMutation = () =>
              this.executor.executeMutation(path, args, {
                holdsTransactionLock: true,
              });
            const { result, commit } = context.holdsTransactionLock
              ? await runMutation()
              : await this._runWithTransactionLock(runMutation);
            this.onMutationCommit(commit);
            return result;
          },
          action: () => {
            const runAction = () =>
              this.executor.executeAction(path, args, {
                ...context,
                holdsTransactionLock: true,
              });
            return context.holdsTransactionLock
              ? runAction()
              : this._runWithTransactionLock(runAction);
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

  /**
   * Execute a system function directly against the database.
   *
   * System functions run within a transaction managed by try/finally:
   * - Start transaction
   * - Run the handler, commit on success (mutations) or rollback (queries)
   * - On failure: rollback
   */
  private async _runSystemFunction(
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

    const db = this.db;
    const onCommit = this.onMutationCommit.bind(this);

    const runSystemFunction = async (): Promise<unknown> => {
      db.startTransaction();
      try {
        const result = await def.handler(db, args);

        if (def.type === "mutation") {
          onCommit(await db.commitAsync());
        } else {
          db.rollbackWrites();
        }

        return result;
      } catch (e) {
        db.rollbackWrites();
        throw e;
      }
    };

    return context.holdsTransactionLock
      ? runSystemFunction()
      : this._runWithTransactionLock(runSystemFunction);
  }

  private async _startCronRunner(): Promise<void> {
    try {
      const jobs = await discoverCronJobs(this.moduleLoader);
      this.cronRunner.setJobs(jobs);
      this.cronRunner.start();
      runtimeLog.debug(`cron runner started with ${jobs.length} job(s)`);
    } catch (err) {
      runtimeLog.error("cron runner start failed:", err);
    }
  }

  private async _initializeHttpDispatcher(): Promise<void> {
    try {
      this._httpDispatcher = await createHttpDispatcher(
        this.moduleLoader,
        this.executor,
        (fn) => this._runWithTransactionLock(fn),
      );
      runtimeLog.debug(
        `http dispatcher initialized (hasRoutes=${this._httpDispatcher.hasRoutes()})`,
      );
    } catch (err) {
      runtimeLog.error("http dispatcher init failed:", err);
    }
  }

  /**
   * Dispatch a `Request` against the user's `convex/http.ts` route table and
   * return the resulting `Response`.
   *
   * Mirrors what Convex's hosted `httpAction` does, except the call is in-
   * process. Use this directly from any Web fetch-handler runtime
   * (Bun/Deno/Cloudflare Workers/Hono) or wrap with
   * `@whatwg-node/server`'s `createServerAdapter` for Node.
   */
  async dispatchHttpRequest(request: Request): Promise<Response> {
    await this._storageHydrated;
    return (this._httpDispatcher ?? noopHttpDispatcher).dispatch(request);
  }

  private async _resumeScheduledFunctions(): Promise<void> {
    const qid = this.db.startQueryAsync({
      source: {
        type: "FullTableScan",
        tableName: "_scheduled_functions",
        order: "asc",
      },
      operators: [],
    });

    let next = await this.db.queryNextAsync(qid);
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
        this._scheduleRecoveredJob(
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
      next = await this.db.queryNextAsync(qid);
    }
    this.db.queryCleanup(qid);
  }

  private _scheduleRecoveredJob(
    jobId: string,
    udfPath: string,
    args: Record<string, unknown>,
    scheduledTime: number,
  ): void {
    if (this._scheduledRecovery.has(jobId)) {
      return;
    }
    this._scheduledRecovery.add(jobId);

    let timerId: ReturnType<typeof setTimeout>;
    timerId = setTimeout(
      () => {
        const db = this.db;
        const runUdf = this._runUdf.bind(this);
        this._activeTimers.delete(timerId);
        this._scheduledRecovery.delete(jobId);

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

          await this._runWithTransactionLock(async () => {
            db.startTransaction();
            try {
              db.patch("_scheduled_functions", jobId as DocumentId, {
                state: { kind: "inProgress" },
              });
              this.onMutationCommit(await db.commitAsync());
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
            await this._runWithTransactionLock(async () => {
              db.startTransaction();
              try {
                db.patch("_scheduled_functions", jobId as DocumentId, {
                  state: { kind: finalState },
                  ...(finalState === "failed"
                    ? { completedTime: Date.now() }
                    : {}),
                });
                this.onMutationCommit(await db.commitAsync());
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

    this._activeTimers.add(timerId);
  }

  private async _runWithTransactionLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.transactionManager.begin(false);

    try {
      const result = await fn();
      this.transactionManager.commit(false);
      return result;
    } catch (err) {
      this.transactionManager.rollback(false);
      throw err;
    }
  }

  /**
   * Build the executor facade that {@link ReplicationProtocolHandler} expects.
   *
   * The protocol calls:
   *   - `executor.runQuery(udfPath, ...args)`
   *   - `executor.runMutation(udfPath, ...args)`
   *   - `executor.runAction(udfPath, ...args)`
   *
   * The SDK sends `args` as a single-element array `[convexToJson(userArgs)]`.
   * Our `_runUdf` → `executeQuery/Mutation/Action` handles deserialization
   * internally via `func.invokeQuery(argsStr)` which expects the raw
   * JSON-serialized args. We pass the first element through as the args
   * object.
   */
  private _buildProtocolExecutor(): ProtocolExecutor {
    return {
      runQuery: async (context, udfPath: string, ...args: unknown[]) => {
        const path = getFunctionPath({ name: udfPath });
        const convexArgs = (args[0] ?? {}) as Record<string, unknown>;
        const dependencies: QueryDependency[] = [];
        const result = (await this._runWithTransactionLock(() =>
          this.executor.executeQuery(path, convexArgs, {
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
        const { result, commit } = await this._runWithTransactionLock(() =>
          this.executor.executeMutation(path, convexArgs, {
            holdsTransactionLock: true,
            identity: context.identity,
            identityKey: context.identityKey,
          }),
        );
        this.onMutationCommit(commit);
        return {
          result: result as JSONValue,
          tablesWritten: commit.tablesWritten,
          changes: this._commitToQueryUpdates(commit.invalidation),
        };
      },

      runAction: async (context, udfPath: string, ...args: unknown[]) => {
        const path = getFunctionPath({ name: udfPath });
        const convexArgs = (args[0] ?? {}) as Record<string, unknown>;
        return (await this._runUdf("action", path, convexArgs, {
          identity: context.identity,
          identityKey: context.identityKey,
        })) as JSONValue;
      },
    };
  }

  /**
   * Build the auth facade that {@link ReplicationProtocolHandler} expects.
   *
   * The protocol calls `auth.verifyToken(token)`. Since AuthResolver
   * is a simple identity holder (no actual JWT verification for the
   * embedded runtime), we treat any non-empty token as valid and
   * return the currently set identity.
   */
  private _buildProtocolAuth() {
    return {
      verifyToken: async (token: string) => {
        if (this._verifyTokenHook) {
          const verified = await this._verifyTokenHook(token);
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
        const identity = await this.auth.getUserIdentity();
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

  private _buildRuntimeState(input: RuntimeInput): RuntimeState {
    const { runtime, options } = input;
    const schemaExport = extractConvexSchemaExport(options.schema);
    const schema = schemaExport
      ? parseSchema(schemaExport as SchemaExport)
      : null;

    const storageAdapter = options.storage ?? null;
    const verifyTokenHook = options.verifyToken ?? null;
    const crypto = options.crypto ?? createAmbientCryptoProvider();
    const db = new Database(schema, options.storage, crypto);
    const moduleLoader = new ModuleLoader(options.convex.modules);
    const transactionManager = new TransactionManager();
    const subscriptions = new SubscriptionManager();
    const tableVersionGetter = (tableName: string): number =>
      db.getTableVersion(tableName);
    const protocolQueryObservers =
      new RuntimeQueryObserverRegistry<ProtocolQueryRecord>(
        subscriptions,
        tableVersionGetter,
      );
    const localQueryWatches =
      new RuntimeQueryObserverRegistry<LocalQueryWatchRecord>(
        subscriptions,
        tableVersionGetter,
      );
    const localPaginatedQueryWatches =
      new RuntimeQueryObserverRegistry<LocalPaginatedWatchRecord>(
        subscriptions,
        tableVersionGetter,
      );
    const protocolQueries = new RuntimeProtocolQueryRegistry(
      protocolQueryObservers,
    );
    const auth = new AuthResolver();
    const executor = new UdfExecutor({
      db,
      crypto,
      moduleLoader,
      runUdf: (
        type: "query" | "mutation" | "action",
        path: FunctionPath,
        args: Record<string, unknown>,
        context?: { holdsTransactionLock?: boolean },
      ) => runtime._runUdf(type, path, args, context),
      getIdentity: () => runtime.auth.getUserIdentity(),
      activeTimers: runtime._activeTimers,
      runWithTransactionLock: (fn) => runtime._runWithTransactionLock(fn),
    });
    const syncProtocol = new ReplicationProtocolHandler({
      executor: runtime._buildProtocolExecutor(),
      queryStore: protocolQueries,
      auth: runtime._buildProtocolAuth(),
    });
    const sessions = new SessionManager();
    const writeFanout = options.writeBroadcast ?? createNoopWriteBroadcast();
    const scheduler = new SchedulerExecutor({
      db,
      runFunction: async (path: string, args: Record<string, unknown>) => {
        await runtime._runUdf(
          "mutation",
          getFunctionPath({ name: path }),
          args,
        );
      },
    });

    const cronRunner = new CronRunner({
      jobs: [],
      runFunction: async (type, functionName, args) => {
        await runtime._runUdf(
          type,
          getFunctionPath({ name: functionName }),
          args,
        );
      },
    });

    return {
      schema,
      storageAdapter,
      verifyTokenHook,
      crypto,
      db,
      moduleLoader,
      executor,
      transactionManager,
      subscriptions,
      protocolQueryObservers,
      localQueryWatches,
      localPaginatedQueryWatches,
      protocolQueries,
      auth,
      syncProtocol,
      sessions,
      writeFanout,
      scheduler,
      cronRunner,
    } satisfies RuntimeState;
  }
}
