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
are notified and refresh their local query state after the write is safely
persisted. No additional configuration is required.

## How it works

Cross-tab behavior is built on three cooperating pieces:

### Shared IndexedDB database

All tabs that use the same `name` option (or the default `"convex-embedded"`)
share a single IndexedDB database via the wa-sqlite worker. When one tab writes
data, any other tab's next read will see the updated state.

```ts
// Both of these share the same data:
const client1 = createConvexClient({
  modules,
  name: "my-app", // same name = same database
});

// In another tab:
const client2 = createConvexClient({
  modules,
  name: "my-app", // same name = same database
});
```

### Write broadcast notifications

Sharing a database ensures data consistency, but tabs also need to know _when_
to re-read. convex-embedded uses separate write and session broadcast channels.

## Write broadcast

The write broadcast sends notifications when a mutation commit is durably
persisted. The channel name is derived from the database name:

- Channel: `${name}:write` (e.g., `"my-app:write"`)
- Payload: the set of table names that were written to

When a tab receives a write notification, the runtime:

1. syncs the affected tables from shared persistence into memory
2. re-evaluates protocol queries for connected clients
3. refreshes local query watches

This is why cross-tab query updates stay fast even without a server round-trip.

### Fallback behavior

If `BroadcastChannel` is unavailable (older browsers), the write broadcast falls
back to `localStorage` storage events. The `storage` event naturally only fires
in _other_ tabs, providing the same cross-tab notification semantics.

## Session broadcast

The session broadcast sends auth state changes across tabs. When a user logs in
or out in one tab, other tabs are notified and refresh their embedded identity:

- Channel: `${name}:session` (e.g., `"my-app:session"`)
- Payload: `{ type: "authChanged" }`

This ensures that a login action in one tab propagates to all open tabs without
requiring the user to refresh.

Like the write broadcast, the session broadcast falls back to `localStorage`
storage events when `BroadcastChannel` is not available.

## Replay leases and tab recovery

Cross-tab sync is not just transport.

Replay ownership is handled in the core queue/engine layer using processor
leases:

- a processor claims a pending replay entry
- active replay renews the lease
- success removes the owned entry
- unknown failure releases it back to pending
- expired leases can be reclaimed by another tab/processor

This means browser tabs only provide transport and processor identity. They do
not define replay correctness rules.

## Automatic by default

Cross-tab remote is enabled automatically when tabs share the same database
name. There is no configuration flag to turn it on or off. To isolate data
between different parts of your application, use different `name` values:

```ts
// These two do NOT share data or auth state:
const appClient = createConvexClient({
  modules,
  name: "main-app",
});

const adminClient = createConvexClient({
  modules,
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

| Mechanism             | Channel Name       | Purpose                                                               |
| --------------------- | ------------------ | --------------------------------------------------------------------- |
| **Write broadcast**   | `${name}:write`    | Notifies other tabs when persisted table writes are ready to refresh. |
| **Session broadcast** | `${name}:session`  | Notifies other tabs when auth state changes.                          |
| **Shared IndexedDB**  | `name` option      | All tabs with the same name read/write the same persistent database.  |
| **Replay leases**     | core runtime state | Prevent duplicate replay and allow crash recovery.                    |

All three mechanisms work together to provide seamless multi-tab operation with
zero configuration.
