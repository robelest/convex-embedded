/**
 * Main embedded runtime.
 *
 * Wires together all subsystems — database, module loader, UDF executor,
 * transaction manager, subscriptions, remote protocol, sessions, write fanout,
 * auth, scheduler, and blob storage — into a single cohesive runtime that
 * ConvexClient can talk to via an in-memory transport.
 */

import { Fx } from "@robelest/fx";
import { Cv } from "@robelest/fx/convex";
import type {
  ArgsAndOptions,
  FunctionReference,
  FunctionReturnType,
  OptionalRestArgs,
} from "convex/server";
import { getFunctionName } from "convex/server";
import { convexToJson, jsonToConvex, type JSONValue } from "convex/values";

import { AuthResolver, getIdentityKey } from "@/auth/resolver";
import type { UserIdentity } from "@/auth/resolver";
import type { Replica } from "@/client/replica";
import { componentRouteTargetLabel } from "@/client/routing/metadata";
import { ModuleLoader } from "@/kernel/modules";
import type { ConvexModuleRegistry, FunctionPath } from "@/kernel/modules";
import { resolveFunctionPath } from "@/kernel/modules";
import { SYSTEM_FUNCTIONS } from "@/kernel/system";
import type { SystemFunctionDef } from "@/kernel/system";
import { TransactionManager } from "@/kernel/transaction";
import { UdfExecutor } from "@/kernel/udf";
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
import {
  createNoopWriteBroadcast,
  type WriteBroadcast,
} from "@/runtime/platform";
import {
  RuntimeProtocolQueryRegistry,
  RuntimeQueryObserverRegistry,
  type ProtocolQueryRecord,
  type RuntimeQueryObserver,
} from "@/runtime/registry";
import type { StorageSurface } from "@/runtime/storage";
import { createTransport } from "@/runtime/transport";
import type { EmbeddedTransport } from "@/runtime/transport";
import { SchedulerExecutor } from "@/scheduler/executor";
import { createLogger } from "@/shared/logger";
import type { StorageAdapter } from "@/storage/adapter";
import { SyncProtocolHandler } from "@/sync/protocol";
import type {
  ClientMessage,
  ProtocolChange,
  ProtocolExecutor,
  ServerMessage,
} from "@/sync/protocol";
import { SessionManager } from "@/sync/session";
import { SubscriptionManager } from "@/sync/subscriptions";

const storageLog = createLogger("runtime-storage");

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

export interface LocalQueryWatch<T = unknown> {
  onUpdate(callback: () => void): () => void;
  localQueryResult(): T | undefined;
  localQueryLogs(): string[] | undefined;
}

export type LocalPaginatedQueryResult<T = unknown> = {
  results: T[];
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMore: (numItems: number) => boolean;
};

export interface LocalPaginatedQueryWatch<T = unknown> {
  onUpdate(callback: () => void): () => void;
  localQueryResult(): LocalPaginatedQueryResult<T> | undefined;
  localQueryLogs(): string[] | undefined;
}

export interface TableWriteSubscription {
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
};

type LocalPaginatedWatchRecord = {
  path: string;
  args: Record<string, unknown>;
  initialNumItems: number;
  requestedPageSizes: number[];
  loadingMore: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Shallow-compare two documents, ignoring `_id` and `_creationTime`.
 *
 * Used by {@link EmbeddedRuntime.ingestDocuments} to determine whether
 * a remote document has actually changed relative to the local copy.
 * Returns `true` when all user-facing fields are identical.
 */
function docsEqual(a: StoredDocument, b: Record<string, unknown>): boolean {
  const skipKeys = new Set(["_id", "_creationTime"]);

  const aKeys = Object.keys(a)
    .filter((k) => !skipKeys.has(k))
    .sort();
  const bKeys = Object.keys(b)
    .filter((k) => !skipKeys.has(k))
    .sort();

  if (aKeys.length !== bKeys.length) return false;

  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (
      JSON.stringify(a[aKeys[i]! as keyof StoredDocument]) !==
      JSON.stringify(b[bKeys[i]!])
    ) {
      return false;
    }
  }

  return true;
}

function matchTag<
  T extends Record<K, string>,
  K extends keyof T & string,
  Handlers extends {
    [V in T[K] & string]: (value: Extract<T, Record<K, V>>) => unknown;
  },
>(value: T, key: K, handlers: Handlers): ReturnType<Handlers[T[K] & string]> {
  const handler = handlers[value[key] as T[K] & string] as unknown as (
    current: T,
  ) => ReturnType<Handlers[T[K] & string]>;
  return handler(value);
}

function stableValueKey(value: unknown): string {
  if (value === undefined) {
    return JSON.stringify({ $undefined: true });
  }

  try {
    return JSON.stringify(convexToJson(value as never));
  } catch {
    return JSON.stringify(value);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddedRuntimeOptions {
  /** Lazy ESM registry of your Convex modules keyed by canonical module id. */
  modules: ConvexModuleRegistry;
  /** Optional Convex schema definition (the default export from schema.ts). */
  schema?: SchemaExport;
  /**
   * Optional remote-backed replica used to seed the embedded database.
   *
   * Pass the value returned by `createReplica(...)` to start the runtime with
   * authoritative embedded table data during SSR or bootstrap.
   */
  replica?: Replica;
  /** Optional durable storage backend. When omitted the runtime is purely in-memory. */
  storage?: StorageAdapter;
  /** Optional crypto implementation for ids, hashing, and encryption. */
  crypto?: EmbeddedCryptoProvider;
  /** Optional verifier for embedded auth tokens. */
  verifyToken?: (token: string) => Promise<UserIdentity | null>;
  /** Optional platform write broadcast implementation. */
  writeBroadcast?: WriteBroadcast;
}

// ---------------------------------------------------------------------------
// EmbeddedRuntime
// ---------------------------------------------------------------------------

/**
 * Top-level runtime that owns all subsystems and provides the transport
 * configuration for ConvexClient.
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
  // -- Subsystems (public for testing / advanced use) -----------------------

  readonly db: Database;
  readonly moduleLoader: ModuleLoader;
  readonly executor: UdfExecutor;
  readonly transactionManager: TransactionManager;
  readonly subscriptions: SubscriptionManager;
  readonly protocolQueries: RuntimeProtocolQueryRegistry;
  readonly syncProtocol: SyncProtocolHandler;
  readonly sessions: SessionManager;
  readonly writeFanout: WriteBroadcast;
  readonly auth: AuthResolver;
  private readonly _verifyTokenHook:
    | ((token: string) => Promise<UserIdentity | null>)
    | null;
  readonly scheduler: SchedulerExecutor;
  private readonly _protocolQueryObservers: RuntimeQueryObserverRegistry<ProtocolQueryRecord>;
  private readonly _localQueryWatches: RuntimeQueryObserverRegistry<LocalQueryWatchRecord>;
  private readonly _localPaginatedQueryWatches: RuntimeQueryObserverRegistry<LocalPaginatedWatchRecord>;
  private readonly _tableWriteListeners = new Map<string, Set<() => void>>();

  private _schema: ParsedSchema | null;
  private _storageAdapter: StorageAdapter | null;
  private _transports: EmbeddedTransport[] = [];
  private readonly _storageHydrated: Promise<void>;
  private _hydrated: Promise<void>;
  private _shutdown = false;

  /**
   * Shared set of active timer IDs from scheduled function `setTimeout`
   * calls (via `1.0/schedule` syscall). Cleared on {@link shutdown} to
   * prevent leaked timers accessing the database after teardown.
   */
  private _activeTimers = new Set<ReturnType<typeof setTimeout>>();
  private _scheduledRecovery = new Set<string>();

  constructor(options: EmbeddedRuntimeOptions) {
    console.debug(
      "[convex-embedded] creating runtime, modules:",
      Object.keys(options.modules).length,
    );

    // 1. Parse schema (if provided) ----------------------------------------
    this._schema = options.schema ? parseSchema(options.schema) : null;
    this._storageAdapter = options.storage ?? null;
    this._verifyTokenHook = options.verifyToken ?? null;
    this.crypto = options.crypto ?? createAmbientCryptoProvider();

    // 2. Core database -----------------------------------------------------
    this.db = new Database(this._schema, options.storage, this.crypto);

    // 3. Module loader -----------------------------------------------------
    this.moduleLoader = new ModuleLoader(options.modules);

    // 4. UDF executor — needs db, moduleLoader, and a runUdf callback ------
    //    The runUdf callback dispatches to executeQuery / executeMutation /
    //    executeAction on this executor instance. We bind it via a closure
    //    that captures `this` so it works even though `executor` doesn't
    //    exist yet at construction time.
    this.executor = new UdfExecutor({
      db: this.db,
      crypto: this.crypto,
      moduleLoader: this.moduleLoader,
      runUdf: (
        type: "query" | "mutation" | "action",
        path: FunctionPath,
        args: Record<string, unknown>,
        context?: { holdsTransactionLock?: boolean },
      ) => this._runUdf(type, path, args, context),
      getIdentity: () => this.auth.getUserIdentity(),
      activeTimers: this._activeTimers,
    });

    // 5. Transaction manager -----------------------------------------------
    this.transactionManager = new TransactionManager();

    // 6. Subscriptions -----------------------------------------------------
    this.subscriptions = new SubscriptionManager();
    this._protocolQueryObservers = new RuntimeQueryObserverRegistry(
      this.subscriptions,
    );
    this._localQueryWatches = new RuntimeQueryObserverRegistry(
      this.subscriptions,
    );
    this._localPaginatedQueryWatches = new RuntimeQueryObserverRegistry(
      this.subscriptions,
    );
    this.protocolQueries = new RuntimeProtocolQueryRegistry(
      this._protocolQueryObservers,
    );

    // 7. Auth resolver -----------------------------------------------------
    this.auth = new AuthResolver();

    // 8. Sync protocol handler ---------------------------------------------
    //    The protocol expects:
    //      executor.runQuery(udfPath, ...args)
    //      executor.runMutation(udfPath, ...args)
    //      executor.runAction(udfPath, ...args)
    //      auth.verifyToken(token)
    //    We bridge these to our actual subsystem APIs.
    this.syncProtocol = new SyncProtocolHandler({
      executor: this._buildProtocolExecutor(),
      queryStore: this.protocolQueries,
      auth: this._buildProtocolAuth(),
    });

    // 9. Session manager ---------------------------------------------------
    this.sessions = new SessionManager();

    // 10. Write fanout (cross-tab) -----------------------------------------
    this.writeFanout = options.writeBroadcast ?? createNoopWriteBroadcast();

    // Wire cross-tab write fanout: when a remote tab writes, re-read
    // the affected tables from IndexedDB, re-evaluate active queries,
    // and push updated results to the ConvexClient.
    this.writeFanout.onNotification((tablesWritten) => {
      Fx.detach(
        () => this._handleCrossTabSync(tablesWritten),
        "[convex-embedded] cross-tab sync:",
      );
    });

    // 11. Scheduler --------------------------------------------------------
    this.scheduler = new SchedulerExecutor({
      db: this.db,
      runFunction: async (path: string, args: Record<string, unknown>) => {
        await this._runUdf(
          "mutation",
          resolveFunctionPath({ name: path }),
          args,
        );
      },
    });

    // 13. Hydrate from storage -----------------------------------------------
    //     Messages are gated behind this promise in handleMessage(), so
    //     the runtime is safe to construct synchronously — hydration
    //     completes before any client traffic is processed.
    this._storageHydrated = Fx.run(
      Fx.from({
        ok: async () => {
          await this.db.hydrate();
          await this._ingestReplica(options.replica);
          await this._resumeScheduledFunctions();
        },
        err: (err) => err as Error,
      }).pipe(
        Fx.inspect((err) =>
          Fx.sync(() =>
            console.error("[convex-embedded] hydration failed:", err),
          ),
        ),
        Fx.recover(() => Fx.unit),
      ),
    );
    this._hydrated = this._storageHydrated;
  }

  // -----------------------------------------------------------------------
  // Storage hydration
  // -----------------------------------------------------------------------

  /**
   * Wait for storage hydration to complete.
   *
   * Hydration starts automatically in the constructor. Callers that need
   * to guarantee the database is populated before proceeding can `await`
   * this method, but it is not required — {@link handleMessage} gates
   * on the same promise internally.
   */
  hydrate(): Promise<void> {
    return this._hydrated;
  }

  /**
   * Execute a public Convex query directly against the embedded runtime.
   *
   * This is the runtime-first query helper for SSR/bootstrap flows where you
   * want to render from embedded data without constructing a browser client.
   * The query runs after storage hydration and replica ingest complete.
   *
   * @typeParam Query - The Convex query reference type.
   * @param query - Query reference to execute locally.
   * @param args - Query arguments. Omit for zero-arg queries.
   * @returns The local query result.
   *
   * @example
   * ```ts
   * const dashboard = await runtime.query(api.dashboard.get, {});
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
   * Use it during SSR/bootstrap when first render needs page-shaped data before
   * a browser client exists.
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

  waitForStorageHydration(): Promise<void> {
    return this._storageHydrated;
  }

  /**
   * Replace the hydration gate promise.
   *
   * Used by the browser entry point to defer message processing until
   * the wa-sqlite worker is initialised and persisted data has been
   * loaded. Must be called **before** the ConvexClient starts sending
   * messages (i.e. before `createTransport()` opens a connection).
   *
   * When the provided promise resolves, any queued `handleMessage()`
   * calls proceed and queries are re-evaluated against the now-populated
   * in-memory database.
   */
  setHydrationGate(promise: Promise<void>): void {
    this._hydrated = promise;
  }

  setStorageSurface(surface: StorageSurface | null): void {
    this.executor.setStorageSurface(surface);
  }

  private async _ingestReplica(replica?: Replica): Promise<void> {
    if (!replica) {
      return;
    }
    if (replica.version !== 1) {
      throw new Error(
        `[convex-embedded] Unsupported replica version ${String(replica.version)}.`,
      );
    }

    const tables = Object.entries(replica.tables);
    if (tables.length === 0) {
      return;
    }

    if (tables.some(([tableName]) => this.db.hasDocumentsForTable(tableName))) {
      console.info(
        "[convex-embedded] replica ignored because persisted local data already exists.",
      );
      return;
    }

    this.setActiveIdentityKey(replica.identityKey ?? null);

    for (const [tableName, documents] of tables) {
      if (documents.length === 0) {
        continue;
      }

      this.db.startTransaction();
      try {
        for (const document of documents) {
          const decoded = jsonToConvex(document as JSONValue);
          if (
            !decoded ||
            typeof decoded !== "object" ||
            Array.isArray(decoded)
          ) {
            throw new Error(
              `[convex-embedded] replica table "${tableName}" must contain encoded document objects.`,
            );
          }
          const decodedDocument = decoded as Record<string, unknown>;
          if (
            typeof decodedDocument._id !== "string" ||
            typeof decodedDocument._creationTime !== "number"
          ) {
            throw new Error(
              `[convex-embedded] replica table "${tableName}" must contain documents with string _id and numeric _creationTime.`,
            );
          }
          this.db.putDocument(tableName, decodedDocument as never);
        }
        this.db.commit();
      } catch (error) {
        this.db.rollbackWrites();
        throw error;
      }
    }
  }

  async getStorageBlob(storageId: string): Promise<Blob | null> {
    await this._hydrated;
    const blob = this.db.getFile(storageId as DocumentId);
    storageLog.debug(
      `getStorageBlob(${storageId}) -> ${blob === null ? "null" : `${blob.size} bytes`}`,
    );
    return blob;
  }

  async getStorageMetadata(
    storageId: string,
  ): Promise<Record<string, unknown> | null> {
    await this._hydrated;
    const metadata = this.db.get("_storage", storageId as DocumentId) as Record<
      string,
      unknown
    > | null;
    storageLog.debug(
      `getStorageMetadata(${storageId}) -> ${metadata === null ? "null" : "found"}`,
    );
    return metadata;
  }

  async storeUploadedBlob(blob: Blob): Promise<string> {
    await this._hydrated;
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
      });
      this.db.storeFile(storageId, blob);
      const commit = this.db.commit();
      this.onMutationCommit(commit);
      storageLog.info(`storeUploadedBlob committed as ${storageId}`);
      return storageId as string;
    } catch (error) {
      this.db.rollbackWrites();
      storageLog.error("storeUploadedBlob failed", error);
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // Transport
  // -----------------------------------------------------------------------

  /**
   * Build the transport config that ConvexClient needs.
   *
   * Returns `{ url, webSocketConstructor }` — pass these to the
   * ConvexClient constructor.
   */
  createTransport(): EmbeddedTransport {
    const transport = createTransport(this);
    this._transports.push(transport);
    return transport;
  }

  // -----------------------------------------------------------------------
  // Identity
  // -----------------------------------------------------------------------

  /**
   * Set (or clear) the current user identity.
   * Delegates to the {@link AuthResolver}.
   */
  setIdentity(identity: UserIdentity | null): void {
    this.auth.setIdentity(identity);
    this.db.setActiveIdentityKey(getIdentityKey(identity));
  }

  setActiveIdentityKey(identityKey: string | null): void {
    this.db.setActiveIdentityKey(identityKey);
  }

  getIdentity(): UserIdentity | null {
    return this.auth.peekUserIdentity();
  }

  getIdentityKey(): string | null {
    return this.db.getActiveIdentityKey();
  }

  async migrateAnonymousDataToIdentity(identityKey: string): Promise<void> {
    await this._hydrated;

    this.db.startTransaction();
    let tablesWritten: Set<string>;
    try {
      tablesWritten = this.db.migrateAnonymousDataToIdentity(identityKey);
      const commit = this.db.commit();
      this.onMutationCommit(commit);
    } catch (error) {
      this.db.rollbackWrites();
      throw error;
    }

    if (tablesWritten.size === 0) {
      await this.refreshLocalQueryWatches();
      return;
    }

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

  teardownSession(sessionId: string): void {
    this.syncProtocol.removeSession(sessionId);
  }

  private _buildLocalDocumentMap(table: string): Map<string, StoredDocument> {
    return this.db
      .getDocumentsForTable(table)
      .reduce(
        (acc, doc) => acc.set(doc._id as string, doc),
        new Map<string, StoredDocument>(),
      );
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

    const toDelete = [...localMap.keys()].filter((id) => !remoteMap.has(id));

    return { toDelete, toUpsert };
  }

  private _pushProtocolUpdates(
    updates: Map<string, ServerMessage[]>,
  ): Promise<void> {
    return Fx.run(
      Fx.each([...updates.entries()], ([sessionId, messages]) =>
        Fx.each(messages, (message) =>
          Fx.sync(() => {
            const data = JSON.stringify(message);
            this._transports.forEach((transport) => {
              transport.pushMessage(sessionId, data);
            });
          }),
        ),
      ).pipe(Fx.map(() => undefined)),
    );
  }

  // -----------------------------------------------------------------------
  // Message handling (ProtocolHandler interface for createTransport)
  // -----------------------------------------------------------------------

  /**
   * Route a raw JSON message from the loopback WebSocket to the sync
   * protocol handler. Returns an array of JSON response strings.
   *
   * This is the method that {@link createTransport} binds to — it
   * satisfies the `ProtocolHandler` interface expected by the transport.
   */
  async handleMessage(message: string): Promise<string[]> {
    // Wait for storage hydration to complete before processing any message.
    await this._hydrated;

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message);
    } catch (err) {
      console.error("[convex-embedded] failed to parse message:", err);
      return [JSON.stringify({ type: "FatalError", error: "Invalid JSON" })];
    }

    console.debug("[convex-embedded] handleMessage:", parsed.type);

    // Extract or synthesize a session ID.
    const sessionId =
      ((parsed as unknown as Record<string, unknown>).sessionId as string) ??
      "default";

    try {
      const responses: ServerMessage[] = await this.syncProtocol.handleMessage(
        sessionId,
        parsed,
      );

      console.debug(
        "[convex-embedded] handleMessage responses:",
        parsed.type,
        responses.map((response) => response.type),
      );

      return responses.map((r) => JSON.stringify(r));
    } catch (err) {
      console.error(
        "[convex-embedded] protocol error on",
        parsed.type,
        ":",
        err,
      );
      return [
        JSON.stringify({
          type: "FatalError",
          error: err instanceof Error ? err.message : String(err),
        }),
      ];
    }
  }

  // -----------------------------------------------------------------------
  // Mutation commit hook
  // -----------------------------------------------------------------------

  /**
   * Called after a mutation commits. Invalidates local subscriptions and
   * notifies other tabs via the write fanout.
   */
  onMutationCommit(commit: DatabaseCommitResult): void {
    if (commit.tablesWritten.size === 0) return;

    const changes = commit.changes ?? [];
    this.subscriptions.invalidate(
      changes.length > 0 ? changes : commit.tablesWritten,
    );
    this._notifyTableWriteListeners(commit.tablesWritten);
    Fx.detach(
      () => this._notifyCrossTabAfterPersistence(commit),
      "[convex-embedded] post-commit fanout failed:",
    );
  }

  private _notifyTableWriteListeners(tablesWritten: Iterable<string>): void {
    for (const tableName of tablesWritten) {
      const listeners = this._tableWriteListeners.get(tableName);
      if (!listeners || listeners.size === 0) {
        continue;
      }
      for (const listener of Array.from(listeners)) {
        try {
          listener();
        } catch (error) {
          console.error(
            `[convex-embedded] table write listener failed for "${tableName}":`,
            error,
          );
        }
      }
    }
  }

  private _commitToQueryUpdates(
    commit: DatabaseCommitResult,
  ): ProtocolChange[] {
    const changes = commit.changes ?? [];
    if (changes.length > 0) {
      return changes as ProtocolChange[];
    }

    return Array.from(commit.tablesWritten).map((tableName) => ({
      tableName,
      before: null,
      after: null,
    }));
  }

  async pushLocalQueryUpdates(commit: DatabaseCommitResult): Promise<void> {
    if (commit.tablesWritten.size === 0) {
      return;
    }

    const updates = await this.syncProtocol.reEvaluateQueries(
      this._commitToQueryUpdates(commit),
    );
    await this._pushProtocolUpdates(updates);
  }

  private _notifyCrossTabAfterPersistence(
    commit: DatabaseCommitResult,
  ): Promise<void> {
    return Fx.run(
      Fx.from({
        ok: () => commit.persisted,
        err: (err) => err as Error,
      }).pipe(
        Fx.fold({
          ok: () => {
            this.writeFanout.notify(commit.tablesWritten);
          },
          err: (err) => {
            console.error(
              "[convex-embedded] skipping cross-tab notify after persistence failure:",
              err,
            );
          },
        }),
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Cross-context sync
  // -----------------------------------------------------------------------

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
    await Fx.run(
      Fx.from({
        ok: async () => {
          // 1. Re-read affected tables from IndexedDB into memory.
          await Promise.all(
            Array.from(tablesWritten).map((table) => this.db.syncTable(table)),
          );

          // 2. Re-evaluate all active queries.
          const updates = await this.syncProtocol.reEvaluateQueries(
            Array.from(tablesWritten).map((tableName) => ({
              tableName,
              before: null,
              after: null,
            })),
          );
          await this.refreshLocalQueryWatches();
          this._notifyTableWriteListeners(tablesWritten);

          // 3. Push Transition messages to all connected loopback sockets.
          for (const [sessionId, messages] of updates) {
            for (const msg of messages) {
              const data = JSON.stringify(msg);
              for (const transport of this._transports) {
                transport.pushMessage(sessionId, data);
              }
            }
          }
        },
        err: (e) => e as Error,
      }).pipe(
        Fx.inspect((err) =>
          Fx.sync(() =>
            console.error("[convex-embedded] cross-tab remote failed:", err),
          ),
        ),
        Fx.recover(() => Fx.unit),
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Remote → local ingestion
  // -----------------------------------------------------------------------

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
  ingestDocuments(
    table: string,
    remoteDocs: Array<Record<string, unknown>>,
  ): Promise<void> {
    const db = this.db;
    const hydrated = this._hydrated;
    const onCommit = this.onMutationCommit.bind(this);
    const syncProtocol = this.syncProtocol;
    const buildLocalDocumentMap = this._buildLocalDocumentMap.bind(this);
    const buildRemoteDocumentMap = this._buildRemoteDocumentMap.bind(this);
    const diffIngestDocuments = this._diffIngestDocuments.bind(this);
    const pushProtocolUpdates = this._pushProtocolUpdates.bind(this);

    return Fx.run(
      Fx.gen(function* () {
        // Wait for storage hydration before touching the database.
        yield* Fx.from({
          ok: () => hydrated,
          err: (e) => e as Error,
        });

        const localMap = buildLocalDocumentMap(table);
        const remoteMap = buildRemoteDocumentMap(remoteDocs);
        const { toDelete, toUpsert } = diffIngestDocuments(localMap, remoteMap);

        // --- 3. Early exit if nothing changed --------------------------------

        if (toUpsert.length === 0 && toDelete.length === 0) {
          return;
        }

        console.debug(
          `[convex-embedded] ingestDocuments("${table}"): ` +
            `${toUpsert.length} upsert(s), ${toDelete.length} delete(s)`,
        );

        // --- 4. Apply within a transaction -----------------------------------

        yield* Fx.bracket(
          Fx.sync(() => {
            db.startTransaction();
          }),
          () =>
            Fx.sync(() => {
              for (const doc of toUpsert) {
                db.putDocument(table, doc);
              }
              for (const id of toDelete) {
                db.removeDocument(table, id as unknown as DocumentId);
              }
              return db.commit();
            }),
          (_tx, exit) =>
            Fx.sync(() => {
              if (exit._tag === "Failure") {
                db.rollbackWrites();
              }
            }),
        );

        // --- 5. Propagate changes -------------------------------------------

        onCommit({
          tablesWritten: new Set([table]),
          changes: [
            ...toUpsert.map((after) => ({
              tableName: table,
              before: localMap.get(after._id as string) ?? null,
              after: after as StoredDocument,
            })),
            ...toDelete.map((id) => ({
              tableName: table,
              before: localMap.get(id) ?? null,
              after: null,
            })),
          ],
          persisted: Promise.resolve(),
          timestamp: db.timestamp,
        });

        // Re-evaluate all active queries and push Transition messages.
        yield* Fx.from({
          ok: async () => {
            const updates = await syncProtocol.reEvaluateQueries([
              { tableName: table, before: null, after: null },
            ]);
            await pushProtocolUpdates(updates);
          },
          err: (e) => e as Error,
        });
      }).pipe(
        Fx.inspect((err) =>
          Fx.sync(() => {
            console.error(
              `[convex-embedded] ingestDocuments("${table}") failed:`,
              err,
            );
          }),
        ),
        Fx.recover(() => Fx.unit),
        Fx.map(() => undefined as void),
      ),
    );
  }

  /**
   * Return all documents for a given table from the local embedded database.
   *
   * Waits for storage hydration before reading so the result includes
   * persisted data (not just the empty in-memory state).
   *
   * @param table  The table name to read.
   */
  async getDocumentsForTable(
    table: string,
  ): Promise<Array<Record<string, unknown>>> {
    await this._hydrated;
    return this.db.getDocumentsForTable(table) as Array<
      Record<string, unknown>
    >;
  }

  async getDocument(
    table: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    await this._hydrated;
    return (
      (this.db.get(table, id as DocumentId) as Record<
        string,
        unknown
      > | null) ?? null
    );
  }

  subscribeTableWrites(
    table: string,
    callback: () => void,
  ): TableWriteSubscription {
    const listeners =
      this._tableWriteListeners.get(table) ?? new Set<() => void>();
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
          setTimeout(() => {
            if (current.listeners.has(callback)) {
              callback();
            }
          }, 0);
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
          setTimeout(() => {
            if (current.listeners.has(callback)) {
              callback();
            }
          }, 0);
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
    await Promise.all([
      this._localQueryWatches.refreshAll(),
      this._localPaginatedQueryWatches.refreshAll(),
    ]);
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
    await this._hydrated;

    return this._executeLocalResolved(request);
  }

  async executeBootstrapLocal(
    request: LocalExecutionRequest,
  ): Promise<unknown> {
    await this._storageHydrated;

    return this._executeLocalResolved(request);
  }

  private _executeLocalResolved(
    request: LocalExecutionRequest,
  ): Promise<unknown> {
    return matchTag(request, "kind", {
      query: (current) => {
        const path = resolveFunctionPath({ name: current.path });
        const systemFn = SYSTEM_FUNCTIONS[path.udfPath];
        return systemFn !== undefined
          ? this._runSystemFunction(systemFn, "query", current.args)
          : this._runUdf("query", path, current.args);
      },
      mutation: async (current) => {
        const functionPath = resolveFunctionPath({ name: current.path });
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
        const runMutation = () =>
          this.executor.executeMutation(functionPath, current.args, {
            holdsTransactionLock: true,
          });
        const { result, commit } =
          await this._runWithTransactionLock(runMutation);

        if (current.applyLocalEffects) {
          this.onMutationCommit(commit);
          await this.pushLocalQueryUpdates(commit);
        }

        return result;
      },
      action: (current) => {
        const path = resolveFunctionPath({ name: current.path });
        const systemFn = SYSTEM_FUNCTIONS[path.udfPath];
        return systemFn !== undefined
          ? this._runSystemFunction(systemFn, "action", current.args)
          : this._runUdf("action", path, current.args);
      },
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
      requestedPageSizes: [],
      loadingMore: false,
    };

    const observer = this._localPaginatedQueryWatches.ensure(
      token,
      initialMeta,
      () => this._evaluateHydratedLocalPaginatedWatch(observer),
    );
    void this._localPaginatedQueryWatches.refresh(observer);
    return observer;
  }

  private async _evaluateLocalPaginatedWatch(
    observer: RuntimeQueryObserver<LocalPaginatedWatchRecord>,
  ): Promise<LocalQueryEvaluation> {
    const pageSizes = [
      observer.meta.initialNumItems,
      ...observer.meta.requestedPageSizes,
    ];
    const pageResults: LocalPaginatedPageResult[] = [];
    const tablesRead = new Set<string>();
    const dependencies: QueryDependency[] = [];
    let cursor: string | null = null;

    for (const pageSize of pageSizes) {
      const pageResult = await this._evaluateLocalPaginatedPage(
        observer.meta.path,
        observer.meta.args,
        cursor,
        pageSize,
      );
      pageResults.push(pageResult.result);
      for (const table of pageResult.tablesRead) {
        tablesRead.add(table);
      }
      dependencies.push(...pageResult.dependencies);
      cursor = pageResult.result.isDone
        ? null
        : pageResult.result.continueCursor;
      if (pageResult.result.isDone) {
        break;
      }
    }

    const results = pageResults.flatMap((page) => page.page) as unknown[];
    const lastPage = pageResults.at(-1) ?? null;
    observer.meta.loadingMore = false;
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

  private async _evaluateHydratedLocalQuery(
    pathName: string,
    args: Record<string, unknown>,
  ): Promise<LocalQueryEvaluation> {
    await this._hydrated;
    return this._evaluateLocalQuery(pathName, args);
  }

  private async _evaluateHydratedLocalPaginatedWatch(
    observer: RuntimeQueryObserver<LocalPaginatedWatchRecord>,
  ): Promise<LocalQueryEvaluation> {
    await this._hydrated;
    return this._evaluateLocalPaginatedWatch(observer);
  }

  private _loadMoreLocalPaginatedQuery(
    observer: RuntimeQueryObserver<LocalPaginatedWatchRecord>,
    numItems: number,
  ): boolean {
    if (
      !Number.isFinite(numItems) ||
      numItems <= 0 ||
      observer.meta.loadingMore ||
      (observer.currentValue as LocalPaginatedQueryResult | undefined)
        ?.status === "Exhausted" ||
      observer.currentValue === undefined
    ) {
      return false;
    }

    observer.meta.requestedPageSizes.push(numItems);
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
    void this._localPaginatedQueryWatches.refresh(observer);
    return true;
  }

  private async _evaluateLocalQuery(
    pathName: string,
    args: Record<string, unknown>,
  ): Promise<LocalQueryEvaluation> {
    const path = resolveFunctionPath({ name: pathName });
    const systemFn = SYSTEM_FUNCTIONS[path.udfPath];

    if (systemFn !== undefined) {
      const result = await this._runSystemFunction(systemFn, "query", args, {
        holdsTransactionLock: false,
      });
      return {
        result,
        tablesRead: new Set(),
        dependencies: [],
      };
    }

    const dependencies: QueryDependency[] = [];
    const result = await this._runWithTransactionLock(() =>
      this.executor.executeQuery(path, args, {
        holdsTransactionLock: true,
        dependencies,
      }),
    );

    return {
      result,
      tablesRead: new Set(
        dependencies.map((dependency) => dependency.tableName),
      ),
      dependencies,
    };
  }

  private async _evaluateLocalPaginatedPage(
    pathName: string,
    args: Record<string, unknown>,
    cursor: string | null,
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
        numItems,
        id: -1,
      },
    });

    const result = evaluation.result as {
      page?: unknown[];
      isDone?: boolean;
      continueCursor?: string;
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
      },
      tablesRead: evaluation.tablesRead,
      dependencies: evaluation.dependencies,
    };
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Tear down all resources. */
  shutdown(): void {
    if (this._shutdown) return;
    this._shutdown = true;

    // Close all active WebSocket connections (clears ping intervals).
    for (const transport of this._transports) {
      transport.closeAll();
    }
    this._transports.length = 0;

    this.scheduler.shutdown();

    // Clear any untracked scheduled-function timers from syscalls.
    for (const timerId of this._activeTimers) {
      clearTimeout(timerId);
    }
    this._activeTimers.clear();

    this.sessions.clear();
    this.protocolQueries.clear();
    this.subscriptions.clear();
    this._localQueryWatches.clear();
    this._localPaginatedQueryWatches.clear();
    this._tableWriteListeners.clear();
    this.writeFanout.close();
    if (this._storageAdapter?.close) {
      Fx.detach(
        () => this._storageAdapter!.close!(),
        "[convex-embedded] storage close failed:",
      );
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.shutdown();
  }

  // -----------------------------------------------------------------------
  // Internal: UDF dispatch
  // -----------------------------------------------------------------------

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
    context: { holdsTransactionLock?: boolean } = {},
  ): Promise<unknown> {
    // Intercept system functions — bypass module loader entirely.
    const systemFn = SYSTEM_FUNCTIONS[path.udfPath];
    if (systemFn !== undefined) {
      return this._runSystemFunction(systemFn, type, args, context);
    }

    if (path.componentPath.length > 0) {
      const target = componentRouteTargetLabel(path);
      throw Cv.error({
        code: "NESTED_COMPONENT_LOCAL_UNSUPPORTED",
        message:
          `[convex-embedded] Local execution reached component function "${target}". ` +
          "Component refs are remote-routed in alpha; move the boundary remote or mark the caller remoteOnly().",
        componentPath: path.componentPath,
        udfPath: path.udfPath,
        target,
      });
    }

    return matchTag({ _tag: type }, "_tag", {
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
      action: () => this.executor.executeAction(path, args, context),
    });
  }

  /**
   * Execute a system function directly against the database.
   *
   * System functions run within a transaction managed by Fx.bracket:
   * - Acquire: start transaction
   * - Use: run the handler, commit on success (mutations) or rollback (queries)
   * - Release: rollback on failure
   */
  private _runSystemFunction(
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

    const runSystemFunction = () =>
      Fx.run(
        Fx.bracket(
          Fx.sync(() => {
            db.startTransaction();
          }),
          () =>
            Fx.gen(function* () {
              const result = yield* Fx.sync(() => def.handler(db, args));

              yield* matchTag({ _tag: def.type }, "_tag", {
                mutation: () =>
                  Fx.sync(() => {
                    onCommit(db.commit());
                  }),
                query: () =>
                  Fx.sync(() => {
                    db.rollbackWrites();
                  }),
              });

              return result;
            }),
          (_tx, exit) =>
            Fx.sync(() => {
              if (exit._tag === "Failure") {
                db.rollbackWrites();
              }
            }),
        ),
      );

    return context.holdsTransactionLock
      ? runSystemFunction()
      : this._runWithTransactionLock(runSystemFunction);
  }

  private async _resumeScheduledFunctions(): Promise<void> {
    const qid = this.db.startQuery({
      source: {
        type: "FullTableScan",
        tableName: "_scheduled_functions",
        order: "asc",
      },
      operators: [],
    });

    let next = this.db.queryNext(qid);
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
      next = this.db.queryNext(qid);
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

        Fx.detach(
          () =>
            Fx.run(
              Fx.gen(function* () {
                const job = db.get("_scheduled_functions", jobId as DocumentId);
                const jobState = job?.state as { kind?: string } | null;
                if (job === null || jobState?.kind === "canceled") {
                  return;
                }
                if (jobState?.kind !== "pending") {
                  return;
                }

                yield* Fx.bracket(
                  Fx.sync(() => db.startTransaction()),
                  () =>
                    Fx.sync(() => {
                      db.patch("_scheduled_functions", jobId as DocumentId, {
                        state: { kind: "inProgress" },
                      });
                    }),
                  () =>
                    Fx.sync(() => db.commit()).pipe(
                      Fx.map(() => undefined as void),
                    ),
                );

                const finalState: string = yield* Fx.from({
                  ok: () =>
                    runUdf(
                      "mutation",
                      resolveFunctionPath({ name: udfPath }),
                      args,
                    ),
                  err: (e) => e,
                }).pipe(
                  Fx.fold({
                    ok: () => "success" as string,
                    err: (error) => {
                      console.error(
                        `[convex-embedded] recovered scheduled function ${udfPath}:`,
                        error,
                      );
                      return "failed" as string;
                    },
                  }),
                );

                const finishedJob = db.get(
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
                  yield* Fx.bracket(
                    Fx.sync(() => db.startTransaction()),
                    () =>
                      Fx.sync(() => {
                        db.patch("_scheduled_functions", jobId as DocumentId, {
                          state: { kind: finalState },
                          ...(finalState === "failed"
                            ? { completedTime: Date.now() }
                            : {}),
                        });
                      }),
                    () =>
                      Fx.sync(() => db.commit()).pipe(
                        Fx.map(() => undefined as void),
                      ),
                  );
                }
              }),
            ),
          `[convex-embedded] recovered scheduled function ${udfPath}:`,
        );
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

  // -----------------------------------------------------------------------
  // Internal: protocol adapter bridges
  // -----------------------------------------------------------------------

  /**
   * Build the executor facade that {@link SyncProtocolHandler} expects.
   *
   * The protocol calls:
   *   - `executor.runQuery(udfPath, ...args)`
   *   - `executor.runMutation(udfPath, ...args)`
   *   - `executor.runAction(udfPath, ...args)`
   *
   * We translate these into our internal `_runUdf` dispatch which goes
   * through `UdfExecutor.executeQuery/Mutation/Action`.
   */
  /**
   * Build the executor facade that {@link SyncProtocolHandler} expects.
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
        const path = resolveFunctionPath({ name: udfPath });
        // args[0] is the convexToJson'd args object from the client
        const convexArgs = (args[0] ?? {}) as Record<string, unknown>;
        // _runUdf always returns JSON-serialisable values for queries
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
        const path = resolveFunctionPath({ name: udfPath });
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
          changes: commit.changes,
        };
      },

      runAction: async (context, udfPath: string, ...args: unknown[]) => {
        const path = resolveFunctionPath({ name: udfPath });
        const convexArgs = (args[0] ?? {}) as Record<string, unknown>;
        return (await this.executor.executeAction(path, convexArgs, {
          identity: context.identity,
          identityKey: context.identityKey,
        })) as JSONValue;
      },
    };
  }

  /**
   * Build the auth facade that {@link SyncProtocolHandler} expects.
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
            throw Cv.error({
              code: "AUTH_TOKEN_REJECTED",
              message: "Authentication token rejected",
            });
          }
          return {
            identity: verified,
            identityKey: getIdentityKey(verified as UserIdentity | null),
          };
        }

        // In the embedded runtime, tokens are not cryptographically verified.
        // If an identity has been set via setIdentity(), return it.
        // Otherwise treat an empty/missing token as unauthenticated.
        if (!token) {
          throw Cv.error({
            code: "AUTH_TOKEN_MISSING",
            message: "No authentication token provided",
          });
        }
        const identity = await this.auth.getUserIdentity();
        if (identity === null) {
          throw Cv.error({
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
}
