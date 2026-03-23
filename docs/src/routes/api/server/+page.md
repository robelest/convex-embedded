---
title: Server API
description: Server-side setup with embeddedTable and configuration.
---

<svelte:head>

  <title>Server API - convex-embedded</title>
</svelte:head>

# Server API

The server entry point (`@robelest/convex-embedded/server`) provides the core
primitives for declaring ready tables, binding the embedded component, scoping
queries with views, and running local schema migrations.

```ts
import {
  embeddedTable,
  setup,
  remoteOnly,
  view,
  migration,
  runMigrations,
  getTableRegistry,
} from "@robelest/convex-embedded/server";
```

---

## `embeddedTable(name, shape, options?)`

Declares a ready table at schema-definition time. The return value is both a
valid `TableDefinition` (from `defineTable`) that can be passed directly to
`defineSchema()` **and** an `EmbeddedTableHandle` with `.mutation()`,
`.query()`, and `.resolve` members for building per-table Convex functions.

```ts
function embeddedTable(
  tableName: string,
  shape: Record<string, unknown>,
  options?: {
    version?: number;
    history?: Record<number, Record<string, unknown>>;
    defaults?: Record<string, unknown>;
  },
): TableDefinition & EmbeddedTableHandle;
```

| Parameter          | Type                                      | Default      | Description                                                |
| ------------------ | ----------------------------------------- | ------------ | ---------------------------------------------------------- |
| `tableName`        | `string`                                  | **required** | Table name. Must match the key used in `defineSchema()`.   |
| `shape`            | `Record<string, unknown>`                 | **required** | CRDT descriptors (`schema.*`) or plain validators (`v.*`). |
| `options.version`  | `number`                                  | `1`          | Current schema version for migration support.              |
| `options.history`  | `Record<number, Record<string, unknown>>` | `{}`         | Previous version shapes keyed by version number.           |
| `options.defaults` | `Record<string, unknown>`                 | `{}`         | Default values for fields added in the current version.    |

Each call registers the table in a module-level registry (read by `setup()` and
`getTableRegistry()`).

### `EmbeddedTableHandle`

```ts
interface EmbeddedTableHandle {
  readonly table: string;
  readonly schema: Definition;
  resolve: RegisteredQuery<"public", DefaultFunctionArgs, any>;
  mutation: EmbeddedMutationBuilder;
  query: EmbeddedQueryBuilder;
}
```

### `.mutation(definition)`

Wraps a mutation with CRDT delta recording and `remote:` support.

On **remote Convex**: runs `handler` -> `remote:` block -> records delta. On
**local embedded**: runs `handler` only.

```ts
tasks.mutation({
  args: { title: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("tasks", {
      title: args.title,
      body: args.body,
      done: false,
    });
  },
  // Optional: additional logic that only runs on the remote server
  remote: async (ctx, args, result) => {
    // e.g. send a notification, update analytics
  },
});
```

The `remote:` callback receives the mutation context, the original args, and the
return value of `handler`. It only executes when the mutation runs on the remote
Convex server (not in the local embedded runtime).

### `.query(definition)`

Wraps a query with `remote:` support and optional resolve metadata.

On **remote Convex**: runs `handler` -> `remote:` block (which can transform the
result). On **local embedded**: runs `handler` only.

```ts
tasks.query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("tasks").collect();
  },
  // Optional: transform results on the remote server
  remote: async (ctx, args, result) => {
    return result.map((task) => ({ ...task, source: "remote" }));
  },
  // Optional: tell the resolve engine which args to use for this query
  resolve: {
    args: () => ({}),
  },
});
```

### `.resolve`

An auto-generated Convex query used by the CRDT resolve engine. Tagged with
remote metadata for auto-discovery. You typically export it from your module but
never call it directly:

```ts
// convex/tasks.ts
export const resolve = tasks.resolve;
```

### Example: `convex/schema.ts`

```ts
import { embeddedTable } from "@robelest/convex-embedded/server";
import { schema } from "@robelest/convex-embedded/crdt";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const tasks = embeddedTable("tasks", {
  title: schema.register(v.string()),
  body: schema.register(v.string()),
  done: v.boolean(),
});

export default defineSchema({
  tasks,
  analytics: defineTable({ event: v.string() }),
});
```

### Example: `convex/tasks.ts`

```ts
import { tasks } from "./schema";
import { v } from "convex/values";

export const create = tasks.mutation({
  args: { title: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("tasks", {
      title: args.title,
      body: args.body,
      done: false,
    });
  },
});

export const list = tasks.query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("tasks").collect();
  },
});

export const resolve = tasks.resolve;
```

---

## `setup(config)`

Binds the component reference to all registered embedded tables. Call once per
app in a dedicated file (e.g. `convex/embedded.ts`). This enables CRDT delta
recording and resolve queries against the real component.

Function registration does **not** depend on `setup()` -- the `.mutation()` and
`.query()` builders use `mutationGeneric` / `queryGeneric` from `convex/server`
directly and produce registered functions at definition time.

```ts
function setup(config: SetupConfig): void;
```

### `SetupConfig`

```ts
interface SetupConfig {
  component?: {
    public: {
      insertDelta: FunctionReference<"mutation", any>;
      getLatestDelta: FunctionReference<"query", any>;
      getLatestDeltas: FunctionReference<"query", any>;
      cleanup: FunctionReference<"mutation", any>;
    };
  };
}
```

| Field       | Type                    | Description                                                                                                  |
| ----------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `component` | Component API reference | The Convex component reference (`components.embedded`). Provides access to the CRDT delta storage functions. |

Evaluation order between `schema.ts` and `embedded.ts` does not matter. If
`setup()` runs before `embeddedTable()` (e.g. due to ESM evaluation order), the
config is stored and applied automatically when tables register.

### Example: `convex/embedded.ts`

```ts
import { setup } from "@robelest/convex-embedded/server";
import { components } from "./_generated/api";

setup({ component: components.embedded });
```

---

## `remoteOnly(fn)`

Marks a Convex function as remote-only. A function wrapped with `remoteOnly()`
is never executed in the local embedded runtime. Browser routing sends calls
directly to the remote Convex client, and local execution paths reject if
reached.

```ts
function remoteOnly<T>(fn: T): T;
```

```ts
import { remoteOnly } from "@robelest/convex-embedded/server";
import { mutation } from "./_generated/server";

export const sendEmail = remoteOnly(
  mutation({
    args: { to: v.string(), subject: v.string() },
    handler: async (ctx, args) => {
      // This only runs on the remote server
      await sendEmailViaProvider(args.to, args.subject);
    },
  }),
);
```

---

## `view`

Query scoping utilities. Views are standalone helpers that compose into your own
queries to filter results based on auth state or custom logic.

```ts
import { view } from "@robelest/convex-embedded/server";
```

### `view.public()`

No filter. All rows visible to all callers.

```ts
function public(): ViewFilter;
```

### `view.authenticated()`

Requires a valid identity. Returns all rows. Throws if unauthenticated.

```ts
function authenticated(): ViewFilter;
```

### `view.ownership(options)`

Filters to rows where the specified field matches the current user's ID
(`identity.subject ?? identity.tokenIdentifier`). Unauthenticated callers see
nothing (empty result set).

```ts
function ownership(options: { owner: string }): ViewFilter;
```

| Parameter       | Type     | Description                                                       |
| --------------- | -------- | ----------------------------------------------------------------- |
| `options.owner` | `string` | The field name on the document that contains the owner's user ID. |

### `view.filter(fn)`

Custom filter view. Accepts a function `(ctx, query) => filteredQuery`.

```ts
function filter<Ctx, Q>(
  fn: (ctx: Ctx, query: Q) => Q | Promise<Q>,
): ViewFilter<Ctx, Q>;
```

### `ViewFilter` interface

```ts
interface ViewFilter<Ctx = unknown, Q = unknown> {
  apply(ctx: Ctx, query: Q): Q | Promise<Q>;
}
```

### Usage example

```ts
import { view } from "@robelest/convex-embedded/server";

export const myTasks = query({
  args: {},
  handler: async (ctx) => {
    return await view
      .ownership({ owner: "userId" })
      .apply(ctx, ctx.db.query("tasks"))
      .collect();
  },
});
```

---

## `migration(config)` / `runMigrations(ctx, config)`

Local schema versioning for embedded tables. Tracks which schema version each
local embedded runtime instance is on, diffs against the current app version,
and runs user-supplied migration functions in sequence.

This handles **local device migrations** -- distinct from
`@convex-dev/migrations` which handles remote data backfills.

### `MigrationConfig`

```ts
interface MigrationConfig {
  table: string;
  schema: Definition;
  migrations?: Record<number, FunctionReference<"mutation">>;
  onMigrationError?: MigrationErrorHandler;
}
```

| Field              | Type                                            | Description                                                     |
| ------------------ | ----------------------------------------------- | --------------------------------------------------------------- |
| `table`            | `string`                                        | Table name being migrated.                                      |
| `schema`           | `Definition`                                    | Current schema definition (from `embeddedTable().schema`).      |
| `migrations`       | `Record<number, FunctionReference<"mutation">>` | Per-version migration functions keyed by target version number. |
| `onMigrationError` | `MigrationErrorHandler`                         | Error handler when a migration step fails.                      |

### `runMigrations(ctx, config)`

Checks the current schema version and runs any pending migrations. Returns
`true` if migrations were run, `false` if already up to date. Should be called
during app startup, before rendering.

```ts
async function runMigrations(
  ctx: MutationCtx,
  config: MigrationConfig,
): Promise<boolean>;
```

### `MigrationErrorHandler`

```ts
type MigrationErrorHandler = (
  error: Error,
  ctx: RecoveryContext,
) => Promise<RecoveryAction>;
```

### `RecoveryContext`

```ts
interface RecoveryContext {
  canResetSafely: boolean;
  currentVersion: number;
  targetVersion: number;
}
```

### `RecoveryAction`

```ts
type RecoveryAction =
  | { action: "reset" } // Wipe local data and set version to target
  | { action: "keep-old-schema" } // Don't update version, limp along
  | { action: "retry" } // Retry migration on next startup
  | { action: "custom"; handler: () => Promise<void> };
```

### `migration` namespace

The `migration` object provides a convenience wrapper:

```ts
const migration = {
  run: runMigrations,
  VERSION_TABLE: "_resolve_schema_versions",
};
```

---

## `getTableRegistry()`

Returns a read-only snapshot of all tables declared with `embeddedTable()`. Used
by the browser entry point for auto-discovery and internally by `setup()`.

```ts
function getTableRegistry(): ReadonlyMap<string, EmbeddedTableHandle>;
```

```ts
const registry = getTableRegistry();
for (const [name, handle] of registry) {
  console.log(`Table: ${name}, version: ${handle.schema.version}`);
}
```
