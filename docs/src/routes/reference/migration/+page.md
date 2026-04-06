---
title: Migration Guide
description:
  Forward-only local migrations for tables, queued mutations, and persisted
  metadata.
---

<svelte:head>

  <title>Migration Guide - convex-embedded</title>
</svelte:head>

# Migration Guide

`convex-embedded` includes a **forward-only local migration system** for device
data. It upgrades persisted embedded state before queue hydration, replay, or
remote resolve begins.

This is separate from remote Convex migrations like `@convex-dev/migrations`,
which handle server-side data backfills.

## Overview

On startup, the embedded client now does this automatically:

1. Hydrates the local store.
2. Restores the active identity.
3. Discovers queued replay migration metadata from your Convex modules.
4. Runs forward-only local migrations.
5. Hydrates the ID map and pending queue.
6. Starts replay, resolve, and remote subscriptions.

You do not manually call `migration.run()` during normal app startup anymore.

## What gets migrated

The local migration pipeline covers:

1. Embedded table documents via `embeddedTable(..., { migrate })`
2. Queued mutation payloads and local results via mutation `replay` metadata
3. Persisted store metadata such as:
   - `_resolve_pending`
   - `_resolve_id_map`
   - `_resolve_auth_state`
   - `_scheduled_functions`
   - `_storage` metadata

## Core rule

Local migrations are **forward-only**.

If a newer local store version is opened by an older app build, startup fails
instead of attempting a downgrade.

## Table document migrations

Declare table schema versions directly on `embeddedTable()`:

```ts
import { embeddedTable, schema } from "@robelest/convex-embedded/server";
import { v } from "convex/values";

export const tasks = embeddedTable(
  "tasks",
  {
    title: schema.register(v.string()),
    body: schema.prose(),
    priority: schema.register(v.string()),
  },
  {
    version: 2,
    defaults: {
      priority: "medium",
    },
    migrate: {
      2: async ({ docs }) => {
        await docs.patchMissing({ priority: "medium" });
      },
    },
  },
);
```

### `embeddedTable(..., options)` migration fields

| Field      | Type                                      | Description                                                           |
| ---------- | ----------------------------------------- | --------------------------------------------------------------------- |
| `version`  | `number`                                  | Current local table schema version.                                   |
| `defaults` | `Record<string, unknown>`                 | Default values for additive changes when no explicit step is needed.  |
| `migrate`  | `Record<number, LocalTableMigrationStep>` | Forward-only document migration steps keyed by target version number. |

### `LocalTableMigrationStep`

Each step migrates the table **into** its target version.

```ts
type LocalTableMigrationStep = (
  ctx: LocalTableMigrationContext,
) => Promise<void> | void;
```

```ts
interface LocalTableMigrationContext {
  table: string;
  fromVersion: number;
  toVersion: number;
  targetVersion: number;
  schema: Definition;
  docs: LocalTableDocsApi;
}
```

### `docs` helpers

```ts
interface LocalTableDocsApi {
  all(): Promise<Array<Record<string, unknown>>>;
  patchMissing(fields: Record<string, unknown>): Promise<number>;
  patch(id: unknown, fields: Record<string, unknown>): Promise<void>;
  replace(id: unknown, fields: Record<string, unknown>): Promise<void>;
  delete(id: unknown): Promise<void>;
  modify(
    transform: (
      doc: Record<string, unknown>,
    ) =>
      | Record<string, unknown>
      | null
      | void
      | Promise<Record<string, unknown> | null | void>,
  ): Promise<number>;
}
```

### Example: semantic transform

```ts
migrate: {
  3: async ({ docs }) => {
    await docs.modify((doc) => {
      const legacy = typeof doc.status === "string" ? doc.status : "todo";
      return {
        ...doc,
        status: legacy === "open" ? "todo" : legacy,
      };
    });
  },
}
```

## Queued mutation replay migrations

Offline writes are persisted in `_resolve_pending`. Each queued entry stores a
`payloadVersion`, and startup upgrades queued args/local results before replay.

Attach replay migration metadata to the mutation export itself:

```ts
export const create = tasks.mutation({
  args: { title: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("tasks", {
      title: args.title,
      priority: "medium",
    });
  },
  replay: {
    version: 2,
    migrate: {
      2: async ({ args, localResult }) => ({
        args: { ...args, priority: "medium" },
        localResult,
      }),
    },
  },
});
```

### Replay metadata shape

```ts
replay?: {
  version?: number;
  migrate?: Record<number, PendingReplayMigrationStep>;
}
```

```ts
type PendingReplayMigrationStep = (
  ctx: PendingReplayMigrationContext,
) => Promise<PendingReplayMigrationResult> | PendingReplayMigrationResult;
```

```ts
interface PendingReplayMigrationContext {
  ref: string;
  fromVersion: number;
  toVersion: number;
  args: Record<string, unknown>;
  localResult: unknown;
}

interface PendingReplayMigrationResult {
  args: Record<string, unknown>;
  localResult: unknown;
}
```

Use replay migrations when you change:

1. mutation arg shapes
2. local create result semantics
3. queued payload defaults required for replay

## Advanced API

The lower-level `runMigrations(ctx, config)` helper still exists, but it is now
an advanced/manual API used by the runtime bootstrap and tests. For normal app
code, prefer `embeddedTable(..., { migrate })` and mutation `replay` metadata.

## Recovery and errors

Migration recovery hooks still exist in the low-level API, but the product model
is now stricter:

1. migrations are forward-only
2. newer local data on an older app build is an error
3. normal app code should treat startup migration failures as blocking

See [Error Handling](/reference/errors) for the low-level recovery types.
