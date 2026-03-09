/**
 * Main embedded runtime.
 *
 * Wires together all subsystems — database, module loader, UDF executor,
 * transaction manager, subscriptions, sync protocol, sessions, write fanout,
 * auth, scheduler, and blob storage — into a single cohesive runtime that
 * ConvexClient can talk to via an in-memory transport.
 */

import type { JSONValue } from "convex/values";
import { Database } from "@/core/database";
import { parseSchema } from "@/core/schema";
import type { ParsedSchema, SchemaExport } from "@/core/schema";
import { ModuleLoader } from "@/kernel/module-loader";
import type { ConvexModule, FunctionPath } from "@/kernel/module-loader";
import { resolveFunctionPath } from "@/kernel/module-loader";
import { UdfExecutor } from "@/kernel/udf-executor";
import { TransactionManager } from "@/kernel/transaction";
import { SubscriptionManager } from "@/sync/subscriptions";
import { SyncProtocolHandler } from "@/sync/protocol";
import type { ClientMessage, ProtocolExecutor, ServerMessage } from "@/sync/protocol";
import { SessionManager } from "@/sync/session";
import { WriteFanout } from "@/runtime/write-fanout";
import { createTransport } from "@/runtime/transport";
import type { EmbeddedTransport } from "@/runtime/transport";
import { AuthResolver } from "@/auth/resolver";
import type { UserIdentity } from "@/auth/resolver";
import { SchedulerExecutor } from "@/scheduler/executor";
import type { StorageAdapter } from "@/storage/adapter";

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
  readonly scheduler: SchedulerExecutor;

  private _schema: ParsedSchema | null;
  private _storageAdapter: StorageAdapter | null;
  private _transports: EmbeddedTransport[] = [];
  private _hydrated: Promise<void>;
  private _shutdown = false;

  constructor(options: EmbeddedRuntimeOptions) {
    console.debug(
      "[convex-embedded] creating runtime, modules:",
      Object.keys(options.modules).length,
    );

    // 1. Parse schema (if provided) ----------------------------------------
    this._schema = options.schema ? parseSchema(options.schema) : null;
    this._storageAdapter = options.storage ?? null;

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
      ) => this._runUdf(type, path, args),
      getIdentity: () => this.auth.getUserIdentity(),
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
      void this._handleCrossTabSync(tablesWritten);
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

    // 13. Hydrate from storage (fire-and-forget) ---------------------------
    //     Messages are gated behind this promise in handleMessage(), so
    //     the runtime is safe to construct synchronously — hydration
    //     completes before any client traffic is processed.
    this._hydrated = this.db.hydrate().catch((err) => {
      console.error("[convex-embedded] hydration failed:", err);
    });
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
      (parsed as unknown as Record<string, unknown>).sessionId as string ?? "default";

    try {
      const responses: ServerMessage[] =
        await this.syncProtocol.handleMessage(sessionId, parsed);

      return responses.map((r) => JSON.stringify(r));
    } catch (err) {
      console.error("[convex-embedded] protocol error on", parsed.type, ":", err);
      return [JSON.stringify({
        type: "FatalError",
        error: err instanceof Error ? err.message : String(err),
      })];
    }
  }

  // -----------------------------------------------------------------------
  // Mutation commit hook
  // -----------------------------------------------------------------------

  /**
   * Called after a mutation commits. Invalidates local subscriptions and
   * notifies other tabs via the write fanout.
   */
  onMutationCommit(tablesWritten: Set<string>): void {
    if (tablesWritten.size === 0) return;
    this.subscriptions.invalidate(tablesWritten);
    this.writeFanout.notify(tablesWritten);
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
    try {
      // 1. Re-read affected tables from IndexedDB into memory.
      await Promise.all(
        Array.from(tablesWritten).map((table) => this.db.syncTable(table)),
      );

      // 2. Re-evaluate all active queries.
      const updates = await this.syncProtocol.reEvaluateQueries();

      // 3. Push Transition messages to all connected loopback sockets.
      for (const [, messages] of updates) {
        for (const msg of messages) {
          const data = JSON.stringify(msg);
          for (const transport of this._transports) {
            transport.pushMessage(data);
          }
        }
      }
    } catch (err) {
      console.error("[convex-embedded] cross-tab sync failed:", err);
    }
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
    this.sessions.clear();
    this.subscriptions.clear();
    this.writeFanout.close();
    this._storageAdapter?.close?.()?.catch((err) => {
      console.error("[convex-embedded] storage close failed:", err);
    });
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
   * After a mutation executes, the commit result is inspected and
   * subscriptions + fanout are notified of written tables.
   */
  private async _runUdf(
    type: "query" | "mutation" | "action",
    path: FunctionPath,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (type) {
      case "query":
        return this.executor.executeQuery(path, args);

      case "mutation": {
        const result = await this.executor.executeMutation(path, args);
        // After executeMutation commits internally, the Database's commit()
        // has already bumped the timestamp and returned tablesWritten. But
        // the UdfExecutor doesn't surface that to us. We work around this
        // by noting that the Database.commit() is called inside
        // executeMutation, and we can't intercept it there without modifying
        // UdfExecutor. Instead, we check if the DB timestamp changed and
        // do a broad invalidation, or we rely on the protocol handler's
        // mutation path (which calls _runUdf → executeMutation) returning
        // results that trigger a Transition re-query on the client side.
        //
        // For proper invalidation we need the tables that were written.
        // Since the UdfExecutor calls db.commit() internally, and commit()
        // returns { timestamp, tablesWritten }, but UdfExecutor doesn't
        // expose that, we hook into the Database's commit method.
        //
        // The simplest reliable approach: wrap db.commit to capture
        // tablesWritten. This is done via _wrapCommitOnce below.
        return result;
      }

      case "action":
        return this.executor.executeAction(path, args);

      default:
        throw new Error(`Unknown UDF type: ${type}`);
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
      runQuery: async (udfPath: string, ...args: unknown[]) => {
        const path = resolveFunctionPath({ name: udfPath });
        // args[0] is the convexToJson'd args object from the client
        const convexArgs = (args[0] ?? {}) as Record<string, unknown>;
        // _runUdf always returns JSON-serialisable values for queries
        return await this._runUdf("query", path, convexArgs) as JSONValue;
      },

      runMutation: async (udfPath: string, ...args: unknown[]) => {
        const path = resolveFunctionPath({ name: udfPath });
        const convexArgs = (args[0] ?? {}) as Record<string, unknown>;
        // Wrap db.commit to capture tablesWritten for invalidation.
        const originalCommit = this.db.commit.bind(this.db);
        let capturedTablesWritten: Set<string> | undefined;
        this.db.commit = () => {
          const commitResult = originalCommit();
          capturedTablesWritten = commitResult.tablesWritten;
          return commitResult;
        };

        try {
          const result = await this._runUdf("mutation", path, convexArgs);

          // Invalidate subscriptions + notify cross-tab fanout.
          if (capturedTablesWritten !== undefined && capturedTablesWritten.size > 0) {
            this.onMutationCommit(capturedTablesWritten);
          }

          return result as JSONValue;
        } finally {
          // Restore original commit.
          this.db.commit = originalCommit;
        }
      },

      runAction: async (udfPath: string, ...args: unknown[]) => {
        const path = resolveFunctionPath({ name: udfPath });
        const convexArgs = (args[0] ?? {}) as Record<string, unknown>;
        return await this._runUdf("action", path, convexArgs) as JSONValue;
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
        // In the embedded runtime, tokens are not cryptographically verified.
        // If an identity has been set via setIdentity(), return it.
        // Otherwise treat an empty/missing token as unauthenticated.
        if (!token) {
          throw new Error("No authentication token provided");
        }
        const identity = await this.auth.getUserIdentity();
        if (identity === null) {
          throw new Error(
            "No identity configured. Call runtime.setIdentity() first.",
          );
        }
        return identity;
      },
    };
  }
}
