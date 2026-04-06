---
title: Error Handling
description: Error patterns and recovery strategies in convex-embedded.
---

<svelte:head>

  <title>Error Handling - convex-embedded</title>
</svelte:head>

# Error Handling

convex-embedded surfaces errors through state machine transitions rather than
thrown exceptions. This page documents the error patterns and the recovery
mechanisms available.

## Sync errors (RemoteState)

When the remote engine encounters an error (network failure, CRDT resolve
failure, etc.), the `RemoteState` transitions to `error`:

```ts
type RemoteState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "resolving"; progress?: { completed: number; total: number } }
  | { status: "resolved" }
  | { status: "offline" }
  | { status: "error"; error?: Error };
```

The `error` state is reached after the resolve engine exhausts its retry budget
(`maxRetries`, default 3). The `error` property contains the underlying `Error`
with details about what failed.

### Handling remote errors

Subscribe to resolve state and handle the `error` status:

```ts
import { subscribeRemoteState } from "@robelest/convex-embedded/browser";

const unsub = subscribeRemoteState(client, (state) => {
  if (state.status === "error") {
    console.error("Sync failed:", state.error?.message);
    // Show UI indicator, log to analytics, etc.
  }
});
```

The engine will automatically attempt recovery on the next connectivity change.

## Auth errors (AuthState)

Auth operations can fail during token refresh, identity resolution, or namespace
migration. The `AuthState` transitions to `error`:

```ts
type AuthState =
  | { status: "idle" }
  | { status: "refreshing" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; identity?: UserIdentity; identityKey?: string }
  | { status: "offlineStale"; identity?: UserIdentity; identityKey?: string }
  | { status: "reauthRequired"; identity?: UserIdentity; identityKey?: string }
  | {
      status: "identityMismatch";
      identity?: UserIdentity;
      identityKey?: string;
    }
  | { status: "error"; error: Error };
```

### Handling auth errors

```ts
import { subscribeAuthState } from "@robelest/convex-embedded/browser";

const unsub = subscribeAuthState(client, (state) => {
  switch (state.status) {
    case "error":
      console.error("Auth error:", state.error.message);
      break;
    case "reauthRequired":
      // Prompt user to re-authenticate
      showLoginDialog();
      break;
    case "identityMismatch":
      // A different user is logging in while remote work is pending
      // for the previous user
      showIdentityConflictWarning();
      break;
  }
});
```

## Migration errors

Most apps now use the automatic startup migration pipeline driven by
`embeddedTable(..., { migrate })` and mutation `replay` metadata. The low-level
`MigrationErrorHandler` below still applies to the advanced/manual
`runMigrations(ctx, config)` API.

Automatic startup migrations are forward-only. If a newer local store is opened
by an older app build, startup fails instead of attempting a downgrade.

When a low-level local migration fails, the `MigrationErrorHandler` callback is
invoked. This gives you control over how to recover.

### MigrationErrorHandler

```ts
type MigrationErrorHandler = (
  error: Error,
  ctx: RecoveryContext,
) => Promise<RecoveryAction>;
```

The `RecoveryContext` provides information about the migration state:

```ts
interface RecoveryContext {
  /** Whether it's safe to wipe local data and resync from remote. */
  canResetSafely: boolean;
  /** The schema version the local data is on. */
  currentVersion: number;
  /** The schema version the app expects. */
  targetVersion: number;
}
```

### RecoveryAction

The error handler must return a `RecoveryAction` telling the migration runner
how to proceed:

```ts
type RecoveryAction =
  | { action: "reset" }
  | { action: "keep-old-schema" }
  | { action: "retry" }
  | { action: "custom"; handler: () => Promise<void> };
```

| Action            | Behavior                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reset`           | Wipe all local data for the table and set version to the target. Data will be reloaded from remote on next resolve pass. Only safe when `canResetSafely` is `true`. |
| `keep-old-schema` | Keep the old schema version. The app continues with the stale shape. The version is not updated, so the migration will be retried on next startup.                  |
| `retry`           | Do nothing now. The migration will be retried on the next app startup.                                                                                              |
| `custom`          | Run a custom async handler. Use this for manual data fixups, selective deletion, or any migration logic not covered by the built-in actions.                        |

### Example: migration error handler

```ts
import { migration } from "@robelest/convex-embedded/server";

await migration.run(ctx, {
  table: "tasks",
  schema: taskSchema,
  migrations: {
    2: api.tasks.migrateV2,
    3: api.tasks.migrateV3,
  },
  onMigrationError: async (error, recoveryCtx) => {
    console.error(
      `Migration failed at v${recoveryCtx.currentVersion}:`,
      error.message,
    );

    if (recoveryCtx.canResetSafely) {
      // Safe to wipe and resync from remote
      return { action: "reset" };
    }

    // Otherwise, retry on next startup
    return { action: "retry" };
  },
});
```

## Common error scenarios

### Module not found

If the `modules` registry is missing an entry, or a module id is incorrect, the
embedded runtime will fail to load the module during function execution. This
typically surfaces as an error in the mutation or query that references the
missing function.

**Fix**: Verify your registry keys match your canonical module ids. For example,
use `"./convex/tasks.ts": () => import("./convex/tasks")` for `api.tasks.*`
functions.

### Schema mismatch

If the `schema` option points to a different schema than what the Convex
functions expect, document validation will fail on writes.

**Fix**: Ensure the `schema` passed to `createConvexClient` is the same default
export from your `convex/schema.ts`.

### Worker initialization failure

The wa-sqlite worker may fail to initialize if:

- The browser does not support `Worker` with `{ type: "module" }`
- The worker script URL cannot be resolved
- WebAssembly compilation fails

These errors surface as rejected promises during client initialization. The
worker RPC has a default timeout of 15 seconds.

**Fix**: Ensure your build pipeline correctly bundles the wa-sqlite worker. If
needed, override the `workerUrl` option.

### Network errors during remote

Network failures during the resolve pass are retried according to the
`maxRetries` and `retryDelayMs` configuration. After exhausting retries, the
resolve state transitions to `error`. Mutations continue to work locally during
network outages.
