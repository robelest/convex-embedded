---
title: Cross-Tab Sync
description: How cross-tab synchronization works in convex-embedded.
---

<svelte:head>

  <title>Cross-Tab Sync - convex-embedded</title>
</svelte:head>

# Cross-Tab Sync

convex-embedded automatically synchronizes data and auth state across browser
tabs. When a mutation commits in one tab, other tabs sharing the same database
are notified and update their reactive queries. No additional configuration is
required.

## How it works

Cross-tab remote is built on two mechanisms:

### Shared IndexedDB database

All tabs that use the same `name` option (or the default `"convex-embedded"`)
share a single IndexedDB database via the wa-sqlite worker. When one tab writes
data, any other tab's next read will see the updated state.

```ts
// Both of these share the same data:
const client1 = createConvexClient({
  modules: import.meta.glob("./convex/*.ts"),
  name: "my-app", // same name = same database
});

// In another tab:
const client2 = createConvexClient({
  modules: import.meta.glob("./convex/*.ts"),
  name: "my-app", // same name = same database
});
```

### BroadcastChannel notifications

Sharing a database ensures data consistency, but tabs also need to know _when_
to re-read. convex-embedded uses two `BroadcastChannel` instances for real-time
notifications:

## WriteFanout

`WriteFanout` broadcasts write notifications when a mutation commits. The
channel name is derived from the database name:

- Channel: `${name}:write` (e.g., `"my-app:write"`)
- Payload: the set of table names that were written to

When a tab receives a write notification, it invalidates its subscriptions for
the affected tables and re-executes the relevant queries against the
(now-updated) shared database.

### Fallback behavior

If `BroadcastChannel` is unavailable (older browsers), `WriteFanout` falls back
to `localStorage` storage events. The `storage` event naturally only fires in
_other_ tabs, providing the same cross-tab notification semantics.

## SessionFanout

`SessionFanout` broadcasts auth state changes across tabs. When a user logs in
or out in one tab, other tabs are notified and refresh their embedded identity:

- Channel: `${name}:session` (e.g., `"my-app:session"`)
- Payload: `{ type: "authChanged" }`

This ensures that a login action in one tab propagates to all open tabs without
requiring the user to refresh.

Like `WriteFanout`, `SessionFanout` falls back to `localStorage` storage events
when `BroadcastChannel` is not available.

## Automatic by default

Cross-tab remote is enabled automatically when tabs share the same database
name. There is no configuration flag to turn it on or off. To isolate data
between different parts of your application, use different `name` values:

```ts
// These two do NOT share data or auth state:
const appClient = createConvexClient({
  modules: import.meta.glob("./convex/*.ts"),
  name: "main-app",
});

const adminClient = createConvexClient({
  modules: import.meta.glob("./convex/*.ts"),
  name: "admin-panel",
});
```

## Cleanup

When `client.close()` is called, the `BroadcastChannel` instances are closed and
event listeners are removed. This happens automatically in framework lifecycle
hooks:

```ts
// Svelte
onDestroy(() => client.close());

// React
useEffect(() => () => client.close(), [client]);
```

## Conflict resolution

Because convex-embedded uses Yjs CRDTs for ready fields, concurrent writes from
different tabs are merged automatically without conflicts. For non-CRDT fields,
last-write-wins semantics apply at the database level since all tabs share the
same IndexedDB instance.

## Summary

| Mechanism            | Channel Name      | Purpose                                                                        |
| -------------------- | ----------------- | ------------------------------------------------------------------------------ |
| **WriteFanout**      | `${name}:write`   | Notifies other tabs when tables are written to, triggering query re-execution. |
| **SessionFanout**    | `${name}:session` | Notifies other tabs when auth state changes (login/logout).                    |
| **Shared IndexedDB** | `name` option     | All tabs with the same name read/write the same persistent database.           |

All three mechanisms work together to provide seamless multi-tab operation with
zero configuration.
