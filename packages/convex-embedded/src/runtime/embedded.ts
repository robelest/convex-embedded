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
import type { JSONValue } from "convex/values";

import { AuthResolver, getIdentityKey } from "@/auth/resolver";
import type { UserIdentity } from "@/auth/resolver";
import { Database } from "@/core/database";
import type { DatabaseCommitResult } from "@/core/database";
import { parseSchema } from "@/core/schema";
import type { ParsedSchema, SchemaExport } from "@/core/schema";
import type { QueryDependency } from "@/core/types";
import type { DocumentId, StoredDocument } from "@/core/types";
import { ModuleLoader } from "@/kernel/module-loader";
import type { ConvexModule, FunctionPath } from "@/kernel/module-loader";
import { resolveFunctionPath } from "@/kernel/module-loader";
import { SYSTEM_FUNCTIONS } from "@/kernel/system-functions";
import type { SystemFunctionDef } from "@/kernel/system-functions";
import { TransactionManager } from "@/kernel/transaction";
import { UdfExecutor } from "@/kernel/udf-executor";
import { createTransport } from "@/runtime/transport";
import type { EmbeddedTransport } from "@/runtime/transport";
import { WriteFanout } from "@/runtime/write-fanout";
import { SchedulerExecutor } from "@/scheduler/executor";
import type { StorageAdapter } from "@/storage/adapter";
import { SyncProtocolHandler } from "@/sync/protocol";
import type {
  ClientMessage,
  ProtocolExecutor,
  ServerMessage,
} from "@/sync/protocol";
import { SessionManager } from "@/sync/session";
import { SubscriptionManager } from "@/sync/subscriptions";

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
  const handler = handlers[value[key] as T[K] & string] as (
    current: T,
  ) => ReturnType<Handlers[T[K] & string]>;
  return handler(value);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddedRuntimeOptions {
  /** Vite `import.meta.glob` record pointing at your Convex modules. */
  modules: Record<string, () => Promise<ConvexModule>>;
  /** Optional Convex schema definition (the default export from schema.ts). */
  schema?: SchemaExport;
  /** Optional durable storage backend. When omitted the runtime is purely in-memory. */
  storage?: StorageAdapter;
  /** Optional verifier for embedded auth tokens. */
  verifyToken?: (token: string) => Promise<UserIdentity | null>;
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
 * const runtime = new EmbeddedRuntime({
 *   modules: import.meta.glob("./convex/**\/*.ts"),
 *   schema,
 * });
 * const { url, webSocketConstructor } = runtime.createTransport();
 * const client = new ConvexClient(url, { webSocketConstructor });
 * ```
 */
export class EmbeddedRuntime {
  // -- Subsystems (public for testing / advanced use) -----------------------

  readonly db: Database;
  readonly moduleLoader: ModuleLoader;
  readonly executor: UdfExecutor;
  readonly transactionManager: TransactionManager;
  readonly subscriptions: SubscriptionManager;
  readonly syncProtocol: SyncProtocolHandler;
  readonly sessions: SessionManager;
  readonly writeFanout: WriteFanout;
  readonly auth: AuthResolver;
  private readonly _verifyTokenHook:
    | ((token: string) => Promise<UserIdentity | null>)
    | null;
  readonly scheduler: SchedulerExecutor;

  private _schema: ParsedSchema | null;
  private _storageAdapter: StorageAdapter | null;
  private _transports: EmbeddedTransport[] = [];
  private _hydrated: Promise<void>;
  private _shutdown = false;

  /**
   * Shared set of active timer IDs from scheduled function `setTimeout`
   * calls (via `1.0/schedule` syscall). Cleared on {@link shutdown} to
   * prevent leaked timers accessing the database after teardown.
   */
  private _activeTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: EmbeddedRuntimeOptions) {
    console.debug(
      "[convex-embedded] creating runtime, modules:",
      Object.keys(options.modules).length,
    );

    // 1. Parse schema (if provided) ----------------------------------------
    this._schema = options.schema ? parseSchema(options.schema) : null;
    this._storageAdapter = options.storage ?? null;
    this._verifyTokenHook = options.verifyToken ?? null;

    // 2. Core database -----------------------------------------------------
    this.db = new Database(this._schema, options.storage);

    // 3. Module loader -----------------------------------------------------
    this.moduleLoader = new ModuleLoader(options.modules);

    // 4. UDF executor — needs db, moduleLoader, and a runUdf callback ------
    //    The runUdf callback dispatches to executeQuery / executeMutation /
    //    executeAction on this executor instance. We bind it via a closure
    //    that captures `this` so it works even though `executor` doesn't
    //    exist yet at construction time.
    this.executor = new UdfExecutor({
      db: this.db,
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
      subscriptions: this.subscriptions,
      auth: this._buildProtocolAuth(),
    });

    // 9. Session manager ---------------------------------------------------
    this.sessions = new SessionManager();

    // 10. Write fanout (cross-tab) -----------------------------------------
    this.writeFanout = new WriteFanout();

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
    this._hydrated = Fx.run(
      Fx.from({
        ok: () => this.db.hydrate(),
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
      return;
    }

    const updates = await this.syncProtocol.reEvaluateQueries(
      Array.from(tablesWritten).map((tableName) => ({
        tableName,
        before: null,
        after: null,
      })),
    );
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

    this.subscriptions.invalidate(commit.tablesWritten);
    Fx.detach(
      () => this._notifyCrossTabAfterPersistence(commit),
      "[convex-embedded] post-commit fanout failed:",
    );
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
  // Cross-tab sync
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
              after,
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
              { tableName, before: null, after: null },
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

  /**
   * Execute a query directly against the embedded database, bypassing
   * the ConvexClient subscription machinery.
   *
   * This avoids the `Invalid start version` bug caused by engine
   * hydration queries (IdMap, PendingQueue) going through the same
   * `ConvexClient` as the app's `useQuery` subscriptions. Direct
   * queries run inside a transaction with no WebSocket, no version
   * counter, and no subscription bookkeeping.
   *
   * @param path  UDF path string, e.g. `"_system:idMapGetAll"`.
   * @param args  Arguments passed to the function handler.
   * @returns The query result.
   *
   * @internal
   */
  async queryDirect(
    path: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    await this._hydrated;
    return this._runUdf("query", resolveFunctionPath({ name: path }), args);
  }

  /**
   * Execute a mutation directly against the embedded database, bypassing
   * the ConvexClient session, version counter, and loopback WebSocket.
   *
   * Used by the resolve engine's internal bookkeeping (IdMap, PendingQueue)
   * so that `_system:idMapSet`, `_system:pendingPush`, etc. never touch
   * the shared ConvexClient. Without this, internal mutations produce
   * extra Transition messages that race with app-query Transitions,
   * causing `Invalid start version` errors.
   *
   * The mutation still runs inside a proper transaction (via
   * `_runSystemFunction` or `_runUdf`), commits to the database, and
   * triggers subscription invalidation + persistence. It just skips the
   * WebSocket round-trip that `ConvexClient.mutation()` would do.
   *
   * @param path  UDF path string, e.g. `"_system:idMapSet"`.
   * @param args  Arguments passed to the function handler.
   * @returns The mutation result.
   *
   * @internal
   */
  async mutationDirect(
    path: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    await this._hydrated;
    return this._runUdf("mutation", resolveFunctionPath({ name: path }), args);
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
    this.subscriptions.clear();
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
