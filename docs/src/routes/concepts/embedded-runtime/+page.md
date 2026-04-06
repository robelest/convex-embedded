---
title: Embedded Runtime
description: A detailed look at the EmbeddedRuntime and its subsystems.
---

<svelte:head>

  <title>Embedded Runtime - convex-embedded</title>
</svelte:head>

# Embedded Runtime

The `EmbeddedRuntime` class is the top-level orchestrator. It wires together all
subsystems -- database, module loader, UDF executor, transaction manager,
subscriptions, remote protocol, sessions, write fanout, auth, and scheduler --
into a single cohesive runtime that a standard `ConvexClient` can talk to via an
in-memory loopback transport.

## Database

The in-memory document store uses **MVCC timestamps** to track versions. Each
commit increments a global timestamp, and every document carries its creation
time.

Key properties:

- **Per-table write tracking** -- each commit records the set of tables that
  were modified, enabling targeted subscription invalidation and cross-tab
  remote.
- **Identity scoping** -- documents are scoped by an active identity key
  (derived from the authenticated user). When the identity changes, the database
  switches to the namespace for that user.
- **Anonymous-to-identity migration** -- data written before authentication can
  be migrated to a named identity namespace via
  `migrateAnonymousDataToIdentity()`.

```ts
// The Database is created with an optional schema and storage adapter
this.db = new Database(this._schema, options.storage);
```

## Module Loader

The `ModuleLoader` lazily resolves Convex function modules from the lazy ESM
registry provided at construction time. Modules are loaded on demand during
function execution -- not eagerly at startup.

Each module is expected to export registered Convex functions (`query`,
`mutation`, `action`) created via `queryGeneric`, `mutationGeneric`, or the
`embeddedTable()` builders. The loader scans module exports to find function
definitions and (when remote is enabled) `remote metadata` constants for
auto-discovery.

```ts
this.moduleLoader = new ModuleLoader(options.modules);
```

## UDF Executor

The `UdfExecutor` handles running Convex user-defined functions (queries,
mutations, actions) within the embedded environment. It:

- **Patches globals** -- installs syscall handlers (`1.0/queryStream`,
  `1.0/schedule`, etc.) that the Convex runtime expects.
- **Manages transactions** -- queries run inside a read-only transaction;
  mutations run inside a read-write transaction with commit/rollback.
- **Dispatches nested calls** -- when a function calls `ctx.runQuery()` or
  `ctx.runMutation()`, the executor routes the call back through the runtime's
  central `_runUdf` dispatch.

System functions (paths starting with `_system:`) bypass the module loader and
UDF executor entirely. They execute directly against the database for internal
bookkeeping (ID maps, pending queues, etc.).

## Transaction Manager

The `TransactionManager` implements **optimistic concurrency control (OCC)**.
Every UDF execution acquires a transaction lock:

1. **Begin** -- starts a new transaction scope.
2. **Execute** -- the UDF runs, reading and writing against the in-memory
   database.
3. **Commit or Rollback** -- on success, writes are committed atomically and the
   timestamp advances. On failure, all writes are rolled back.

Queries always roll back their writes (they are read-only). Mutations commit on
success and roll back on error.

```ts
await this.transactionManager.begin(false);
try {
  const result = await fn();
  this.transactionManager.commit(false);
  return result;
} catch (err) {
  this.transactionManager.rollback(false);
  throw err;
}
```

## Subscription Manager

The `SubscriptionManager` tracks active reactive query subscriptions. When a
mutation commits, the manager is told which tables were written:

```ts
this.subscriptions.invalidate(commit.tablesWritten);
```

This triggers re-evaluation of all queries that read from any of the affected
tables. The `SyncProtocolHandler` then pushes `Transition` messages through the
loopback WebSocket to notify the `ConvexClient` of updated query results.

## Sync Protocol Handler

The `SyncProtocolHandler` implements the Convex wire protocol -- the same
binary-over-WebSocket protocol used by real Convex deployments. It handles:

- **Connect/Authenticate** -- session establishment and token verification.
- **Add/RemoveQuery** -- subscription management.
- **Mutation** -- executing mutations and returning results.
- **Transition** -- pushing updated query results to the client.

The `ConvexClient` SDK sends `ClientMessage` objects; the handler returns
`ServerMessage` responses. From the SDK's perspective, this is indistinguishable
from a remote Convex deployment.

## Session Manager

The `SessionManager` tracks per-connection state. Each loopback WebSocket
connection gets a session ID. The session stores:

- Active query subscriptions for that connection.
- The current protocol version counter (used for `Transition` messages).
- Authentication state for that session.

When a transport connection closes, the session is torn down and all its
subscriptions are cleaned up.

## Scheduler

The `SchedulerExecutor` handles `ctx.scheduler.runAfter()` and
`ctx.scheduler.runAt()` calls from within mutations. Scheduled functions are
deferred using `setTimeout` and execute as mutations against the embedded
database.

All active timer IDs are tracked so they can be cleared on shutdown, preventing
leaked timers from accessing the database after teardown.

## Auth Resolver

The `AuthResolver` is a simple identity holder. In the embedded runtime, there
is no JWT verification -- the identity is set programmatically via
`runtime.setIdentity()`.

When auth is configured, the `createConvexClient` factory:

1. Calls `auth.getUserIdentity()` to fetch the current identity from your auth
   provider.
2. Sets the identity on the embedded runtime.
3. Scopes the database namespace to that identity's key.
4. Optionally installs `auth.fetchToken` on both the embedded and remote
   `ConvexClient` instances.

The protocol auth facade wraps this: any non-empty token is treated as valid,
and the currently-set identity is returned. An optional `verifyToken` hook can
be provided for stricter validation.

## Hydration

The runtime hydrates from persistent storage automatically at construction time.
Messages from the `ConvexClient` are gated behind the hydration promise -- no
client traffic is processed until the database is fully loaded from IndexedDB.

```ts
// Messages wait for hydration before processing
async handleMessage(message: string): Promise<string[]> {
  await this._hydrated;
  // ... parse and handle message
}
```

The browser entry point can replace the hydration gate with `setHydrationGate()`
to defer processing until the wa-sqlite worker is fully initialized.

## Document Ingestion

The `ingestDocuments()` method is the primary mechanism for receiving reactive
query results from the remote backend. It:

1. Diffs incoming documents against the current local state.
2. Applies only actual changes (inserts, updates, deletes) within a single
   transaction.
3. Persists to IndexedDB via the storage adapter.
4. Invalidates local subscriptions and notifies other tabs.
5. Re-evaluates all active queries and pushes `Transition` messages to every
   connected `ConvexClient`.

If the incoming data is identical to the local state, the method is a no-op.
