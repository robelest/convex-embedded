---
title: Server API
description: Server-side setup with embeddedTable and configuration.
---

<svelte:head>

  <title>Server API - convex-embedded</title>
</svelte:head>

# Server API

The server entry point (`@robelest/convex-embedded/server`) provides the core
primitives for declaring embedded tables, binding the embedded component,
scoping queries with views, and declaring local migration metadata.

```ts
import {
  embeddedTable,
  bindTable,
  localOnly,
  remoteOnly,
  view,
  getTableRegistry,
} from "@robelest/convex-embedded/server";
```

## API layers

| Layer             | Use                                                        | Purpose                                      |
| ----------------- | ---------------------------------------------------------- | -------------------------------------------- |
| table definition  | `embeddedTable(...)`                                       | declares an embedded synced table            |
| synced exports    | `table.query(...)`, `table.mutation(...)`, `table.resolve` | builds local-first synced functions          |
| execution control | `localOnly(...)`, `remoteOnly(...)`                        | forces local-only or remote-only execution   |
| component binding | `bindTable(table, components.embedded)`                    | binds delta storage / resolve component refs |
| extras            | `view.*`                                                   | query scoping utilities                      |

## Most common usage

```ts
export const tasks = embeddedTable("tasks", {
  title: schema.register(v.string()),
  body: schema.prose(),
  remoteAttachmentId: schema.omit(v.string()),
  done: v.boolean(),
});

export const resolve = tasks.resolve;

export const create = tasks.mutation({
  args: { title: v.string(), body: v.string() },
  handler: async (ctx, args) => await ctx.db.insert("tasks", args),
  remote: async (_ctx, _args, taskId) => {
    await sendTaskCreatedWebhook(taskId);
  },
});

export const list = tasks.query({
  args: {},
  handler: async (ctx) => await ctx.db.query("tasks").collect(),
  resolve: { args: () => ({}) },
});
```

Use this page to answer:

- how do I export `resolve`?
- how do I mark a field remote-only?
- when do I use `remote:`?
- when do I use `localOnly()` or `remoteOnly()`?

---

## `embeddedTable(name, shape, options?)`

Declares an embedded synced table at schema-definition time. The return value is
both a valid `TableDefinition` (from `defineTable`) that can be passed directly
to `defineSchema()` **and** an `EmbeddedTableHandle` with `.mutation()`,
`.query()`, and `.resolve` members for building per-table Convex functions.

```ts
function embeddedTable(
  tableName: string,
  shape: Record<string, unknown>,
  options?: {
    version?: number;
    defaults?: Record<string, unknown>;
    migrate?: Record<number, LocalTableMigrationStep>;
  },
): TableDefinition & EmbeddedTableHandle;
```

| Parameter          | Type                                      | Default      | Description                                                |
| ------------------ | ----------------------------------------- | ------------ | ---------------------------------------------------------- |
| `tableName`        | `string`                                  | **required** | Table name. Must match the key used in `defineSchema()`.   |
| `shape`            | `Record<string, unknown>`                 | **required** | CRDT descriptors (`schema.*`) or plain validators (`v.*`). |
| `options.version`  | `number`                                  | `1`          | Current local schema version.                              |
| `options.defaults` | `Record<string, unknown>`                 | `{}`         | Default values for additive changes.                       |
| `options.migrate`  | `Record<number, LocalTableMigrationStep>` | `{}`         | Forward-only local document migration steps by version.    |

Each call registers the table in a module-level registry exposed by
`getTableRegistry()`.

The current alpha model is explicit:

- `localOnly()` means local or fail
- `remoteOnly()` means remote or fail
- top-level component refs remote-route by default
- nested/local component execution is rejected with structured errors

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

The `remote:` callback receives the mutation context, the original args, and the
return value of `handler`. It only executes when the mutation runs on the remote
Convex server (not in the local embedded runtime).

Use `remote:` when the main mutation should stay local-first but you still need
server-only follow-up behavior.

Use `replay:` when queued offline mutations need forward-only payload upgrades
before replay.

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

This export is what allows the sync engine to discover the table's resolve path.

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
import { bindTable } from "@robelest/convex-embedded/server";
import { components } from "./_generated/api";
import { tasks } from "./schema";
import { v } from "convex/values";

export const bind = bindTable(tasks, components.embedded);

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

## `bindTable(table, component)`

Binds the component reference for one embedded table. Export it from the same
module as that table's synced functions. This enables CRDT delta recording and
resolve queries against the real component.

Function registration does **not** depend on `bindTable()` -- the `.mutation()`
and `.query()` builders use `mutationGeneric` / `queryGeneric` from
`convex/server` directly and produce registered functions at definition time.

```ts
function bindTable(
  table: EmbeddedTableHandle,
  component: ComponentBinding,
): RegisteredQuery<"public", DefaultFunctionArgs, any>;
```

| Parameter   | Type                    | Description                                                                                                  |
| ----------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `table`     | Embedded table handle   | The result of `embeddedTable(...)` from your schema module.                                                  |
| `component` | Component API reference | The Convex component reference (`components.embedded`). Provides access to the CRDT delta storage functions. |

### Example: `convex/tasks.ts`

```ts
import { bindTable } from "@robelest/convex-embedded/server";
import { components } from "./_generated/api";
import { tasks } from "./schema";

export const bind = bindTable(tasks, components.embedded);
```

---

## Execution control

Explicit routing helpers for Convex function exports.

```ts
import { localOnly, remoteOnly } from "@robelest/convex-embedded/server";
```

### `localOnly(fn)`

Forces local execution. If the embedded runtime cannot safely execute the
target, the call throws instead of silently routing remote.

```ts
function localOnly<T>(fn: T): T;
```

### `remoteOnly(fn)`

Forces remote execution. If the client is offline, calls fail immediately.

```ts
function remoteOnly<T>(fn: T): T;
```

```ts
import { remoteOnly } from "@robelest/convex-embedded/server";
import { action } from "./_generated/server";
import { v } from "convex/values";

export const sendEmail = remoteOnly(
  action({
    args: { to: v.string(), subject: v.string() },
    handler: async (_ctx, args) => {
      await sendEmailViaProvider(args.to, args.subject);
    },
  }),
);
```

---

## `view`

Query scoping utilities. Views are standalone helpers that compose into your own
queries to scope results based on auth state and indexed ownership.

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

Scopes rows through an index where the specified field matches the current
user's ID (`identity.subject ?? identity.tokenIdentifier`). Unauthenticated
callers scope to `null`, which should yield no rows when the owner field stores
non-null auth identifiers.

```ts
function ownership(options: { index: string; field: string }): ViewFilter;
```

| Parameter       | Type     | Description                                               |
| --------------- | -------- | --------------------------------------------------------- |
| `options.index` | `string` | The index name used to scope the query.                   |
| `options.field` | `string` | The indexed field name that contains the owner's user ID. |

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
      .ownership({ index: "by_user_id", field: "userId" })
      .apply(ctx, ctx.db.query("tasks"))
      .collect();
  },
});
```

---

## Automatic local migrations

Local migrations are now driven by:

1. `embeddedTable(..., { version, defaults, migrate })` for document shape
2. mutation `replay` metadata for queued offline payloads

These run automatically during embedded client startup before queue hydration
and remote sync begin.

The lower-level `runMigrations(ctx, config)` helper still exists as an advanced
API, but it is no longer the primary app-facing workflow.

---

## `getTableRegistry()`

Returns a read-only snapshot of all tables declared with `embeddedTable()`. Used
by the browser entry point for auto-discovery.

```ts
function getTableRegistry(): ReadonlyMap<string, EmbeddedTableHandle>;
```

```ts
const registry = getTableRegistry();
for (const [name, handle] of registry) {
  console.log(`Table: ${name}, version: ${handle.schema.version}`);
}
```
