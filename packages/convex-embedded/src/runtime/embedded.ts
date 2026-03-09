/**
 * Main embedded runtime.
 *
 * Wires together all subsystems — database, module loader, UDF executor,
 * transaction manager, subscriptions, sync protocol, sessions, write fanout,
 * auth, scheduler, and blob storage — into a single cohesive runtime that
 * ConvexClient can talk to via an in-memory transport.
 */

import { Database } from "../core/database.js";
import { parseSchema } from "../core/schema.js";
import type { ParsedSchema } from "../core/schema.js";
import { ModuleLoader } from "../kernel/module-loader.js";
import type { FunctionPath } from "../kernel/module-loader.js";
import { resolveFunctionPath } from "../kernel/module-loader.js";
import { UdfExecutor } from "../kernel/udf-executor.js";
import { TransactionManager } from "../kernel/transaction.js";
import { SubscriptionManager } from "../sync/subscriptions.js";
import { SyncProtocolHandler } from "../sync/protocol.js";
import type { ClientMessage, ServerMessage } from "../sync/protocol.js";
import { SessionManager } from "../sync/session.js";
import { WriteFanout } from "./write-fanout.js";
import { createTransport } from "./transport.js";
import { AuthResolver } from "../auth/resolver.js";
import type { UserIdentity } from "../auth/resolver.js";
import { SchedulerExecutor } from "../scheduler/executor.js";
import { BlobStore } from "../storage/blob-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddedRuntimeOptions {
  /** Vite `import.meta.glob` record pointing at your Convex modules. */
  modules: Record<string, () => Promise<any>>;
  /** Optional Convex schema definition (the default export from schema.ts). */
  schema?: any;
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
  readonly blobStore: BlobStore;

  private _schema: ParsedSchema | null;
  private _shutdown = false;

  constructor(options: EmbeddedRuntimeOptions) {
    console.debug(
      "[convex-embedded] creating runtime, modules:",
      Object.keys(options.modules).length,
    );

    // 1. Parse schema (if provided) ----------------------------------------
    this._schema = options.schema ? parseSchema(options.schema) : null;

    // 2. Core database -----------------------------------------------------
    this.db = new Database(this._schema);

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
        args: any,
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

    // Wire cross-tab write fanout: when a remote tab writes, invalidate
    // local subscriptions so queries re-evaluate.
    this.writeFanout.onNotification((tablesWritten) => {
      this.subscriptions.invalidate(tablesWritten);
    });

    // 11. Blob store -------------------------------------------------------
    this.blobStore = new BlobStore();

    // 12. Scheduler --------------------------------------------------------
    this.scheduler = new SchedulerExecutor({
      db: this.db,
      runFunction: (path: string, args: any) =>
        this._runUdf(
          "mutation",
          resolveFunctionPath({ name: path }),
          args,
        ),
    });
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
  createTransport(): { url: string; webSocketConstructor: any } {
    return createTransport(this);
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
      (parsed as any).sessionId ?? "default";

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
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Tear down all resources. */
  shutdown(): void {
    if (this._shutdown) return;
    this._shutdown = true;

    this.scheduler.shutdown();
    this.subscriptions.clear();
    this.writeFanout.close();
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
    args: any,
  ): Promise<any> {
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
  private _buildProtocolExecutor() {
    return {
      runQuery: async (udfPath: string, ...args: any[]) => {
        const path = resolveFunctionPath({ name: udfPath });
        // args[0] is the convexToJson'd args object from the client
        const convexArgs = args[0] ?? {};
        const result = await this._runUdf("query", path, convexArgs);
        return result;
      },

      runMutation: async (udfPath: string, ...args: any[]) => {
        const path = resolveFunctionPath({ name: udfPath });
        const convexArgs = args[0] ?? {};
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

          return result;
        } finally {
          // Restore original commit.
          this.db.commit = originalCommit;
        }
      },

      runAction: async (udfPath: string, ...args: any[]) => {
        const path = resolveFunctionPath({ name: udfPath });
        const convexArgs = args[0] ?? {};
        return this._runUdf("action", path, convexArgs);
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
