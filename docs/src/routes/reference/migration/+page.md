---
title: Migration Guide
description: Schema evolution and data migration in convex-embedded.
---

<svelte:head>

  <title>Migration Guide - convex-embedded</title>
</svelte:head>

# Migration Guide

convex-embedded includes a local schema versioning and migration system. This
handles evolving your local embedded database schema as your app changes --
distinct from remote Convex migrations, which handle server-side data backfills.

## Overview

The migration system:

1. Tracks which schema version each table is on (stored in a
   `_resolve_schema_versions` table).
2. Compares the stored version against the current app version.
3. Runs migration functions in sequence to bring the local data up to date.
4. Applies default values for new fields when no explicit migration function is
   provided.

## Defining a versioned schema

Use `schema.define()` to create a versioned schema definition:

```ts
import { schema } from "@robelest/convex-embedded/server";
import { v } from "convex/values";

const taskSchema = schema.define({
  version: 2,
  shape: {
    title: schema.register(v.string()),
    body: schema.register(v.string()),
    priority: schema.register(v.number()), // new in v2
  },
  history: {
    1: {
      title: schema.register(v.string()),
      body: schema.register(v.string()),
    },
  },
  defaults: {
    priority: 0, // default value for the new field
  },
});
```

### DefineOptions

| Field      | Type                                      | Description                                                                                                                           |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `version`  | `number`                                  | Current schema version number.                                                                                                        |
| `shape`    | `Record<string, unknown>`                 | Current field shape. Fields can be plain Convex validators or CRDT field descriptors (`schema.register()`, `schema.counter()`, etc.). |
| `history`  | `Record<number, Record<string, unknown>>` | Previous version shapes, keyed by version number. Used to understand what changed between versions.                                   |
| `defaults` | `Record<string, unknown>`                 | Default values for fields added in the current version. Applied to existing documents that lack the new fields.                       |

## CRDT field types

The schema module provides CRDT field type constructors that map to Yjs data
structures:

| Constructor                  | Yjs Structure   | Description                                                                                                                      |
| ---------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `schema.register(validator)` | `Y.Map`         | Multi-value register with conflict tracking. Concurrent writes produce a `Conflict` that can be resolved with a custom function. |
| `schema.prose()`             | `Y.XmlFragment` | Rich text field with character-level CRDT merge. Use with ProseMirror or TipTap bindings.                                        |
| `schema.counter()`           | `Y.Array`       | Append-only array of increments. Materialized value is the sum of all deltas.                                                    |
| `schema.set(validator)`      | `Y.Map`         | Add-wins set. Key presence equals membership. Yjs add-wins semantics handle concurrent add/remove.                               |
| `schema.omit(validator)`     | --              | Marks a field as remote-only. It exists on the remote Convex backend but is stripped from local remote payloads.                 |

### Register with custom conflict resolution

```ts
const priceField = schema.register(v.number(), {
  resolve: (conflict) => {
    // Pick the highest price on conflict
    return Math.max(...conflict.values);
  },
});
```

The `Conflict` object provides:

```ts
interface Conflict<T> {
  values: T[]; // All concurrent values, unordered
  entries: ConflictEntry<T>[]; // Per-entry metadata (clientId, timestamp)
  latest(): T; // Value with the highest timestamp (default)
  byClient(id: string): T | undefined; // Value from a specific client
}
```

## Running migrations

Use `migration.run()` during app startup to apply pending migrations before
rendering:

```ts
import { migration } from "@robelest/convex-embedded/server";

await migration.run(ctx, {
  table: "tasks",
  schema: taskSchema,
  migrations: {
    2: api.tasks.migrateV2,
  },
  onMigrationError: async (error, recoveryCtx) => {
    console.error("Migration failed:", error.message);
    return { action: "retry" };
  },
});
```

### MigrationConfig

| Field              | Type                                            | Description                                                                                                    |
| ------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `table`            | `string`                                        | Table name being migrated.                                                                                     |
| `schema`           | `Definition`                                    | Current schema definition from `schema.define()`.                                                              |
| `migrations`       | `Record<number, FunctionReference<"mutation">>` | Per-version migration functions, keyed by target version number. Each function is a Convex mutation reference. |
| `onMigrationError` | `MigrationErrorHandler`                         | Error handler when a migration step fails. Returns a `RecoveryAction`.                                         |

### How migration steps work

For each version from `storedVersion + 1` to `targetVersion`:

1. If a migration function exists for that version, it is executed via
   `ctx.runMutation(fn, {})`.
2. If no migration function exists, defaults from `schema.defaults` are applied
   to all documents that lack the new fields.
3. The stored version is updated to the completed version number.

If the stored version is `null` (first run), it is initialized to version 1.

## Example: adding a field

Suppose you have a `tasks` table at version 1 with `title` and `body` fields,
and you want to add a `priority` field.

### Step 1: Update the schema definition

```ts
const taskSchema = schema.define({
  version: 2,
  shape: {
    title: schema.register(v.string()),
    body: schema.register(v.string()),
    priority: schema.register(v.number()),
  },
  history: {
    1: {
      title: schema.register(v.string()),
      body: schema.register(v.string()),
    },
  },
  defaults: {
    priority: 0,
  },
});
```

### Step 2: Run migrations on startup

```ts
// In your app initialization
await migration.run(ctx, {
  table: "tasks",
  schema: taskSchema,
});
```

Since no explicit migration function is provided for version 2, the runner
automatically applies the `defaults` -- patching all existing task documents
with `priority: 0`.

### Step 3: Custom migration (optional)

If you need more complex migration logic (data transformation, conditional
updates), provide a mutation function:

```ts
// convex/tasks.ts
export const migrateV2 = mutation({
  handler: async (ctx) => {
    const tasks = await ctx.db.query("tasks").collect();
    for (const task of tasks) {
      // Set priority based on existing data
      const priority = task.title.startsWith("[URGENT]") ? 1 : 0;
      await ctx.db.patch(task._id, { priority });
    }
  },
});
```

```ts
await migration.run(ctx, {
  table: "tasks",
  schema: taskSchema,
  migrations: {
    2: api.tasks.migrateV2,
  },
});
```

## Recovery actions

When a migration fails and `onMigrationError` is provided, you must return a
`RecoveryAction`:

| Action                                               | Behavior                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `{ action: "reset" }`                                | Wipe all local data for the table and set the version to the target. Data will be reloaded from remote. |
| `{ action: "keep-old-schema" }`                      | Keep the old version. The app runs with the stale shape until next startup.                             |
| `{ action: "retry" }`                                | Do nothing now. The migration retries on next app startup.                                              |
| `{ action: "custom", handler: () => Promise<void> }` | Run a custom async handler for manual data fixups.                                                      |

See the [Error Handling](/reference/errors) page for more details on
`RecoveryAction` and `MigrationErrorHandler`.
