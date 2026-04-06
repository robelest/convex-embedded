---
title: Embedded Tables & Fields
description:
  How to define embedded tables, export resolve, and choose CRDT vs remote-only
  fields.
---

<svelte:head>

  <title>Embedded Tables & Fields - convex-embedded</title>
</svelte:head>

# Embedded Tables & Fields

This is the core server-side usage pattern for convex-embedded.

You use:

1. `embeddedTable()` in `convex/schema.ts`
2. `table.mutation(...)` / `table.query(...)` in feature modules
3. `export const resolve = table.resolve` in each synced table module
4. `setup({ component: components.embedded })` once in your app

## Minimal example

```ts
// convex/schema.ts
import { embeddedTable } from "@robelest/convex-embedded/server";
import { schema } from "@robelest/convex-embedded/crdt";
import { defineSchema } from "convex/server";
import { v } from "convex/values";

export const tasks = embeddedTable("tasks", {
  title: schema.register(v.string()),
  body: schema.prose(),
  votes: schema.counter(),
  tags: schema.set(v.string()),
  remoteAttachmentId: schema.omit(v.string()),
  done: v.boolean(),
  projectId: v.id("projects"),
}).index("by_project", ["projectId"]);

export default defineSchema({ tasks });
```

```ts
// convex/tasks.ts
import { v } from "convex/values";
import { tasks } from "./schema";

export const resolve = tasks.resolve;

export const create = tasks.mutation({
  args: { title: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("tasks", {
      ...args,
      done: false,
      votes: 0,
      tags: [],
    });
  },
});

export const list = tasks.query({
  args: {},
  handler: async (ctx) => await ctx.db.query("tasks").collect(),
  resolve: {
    args: () => ({}),
  },
});
```

## Field choices

Use the simplest field type that matches the behavior you want.

| Field type             | Use when                                  | Merge behavior                                | Local storage |
| ---------------------- | ----------------------------------------- | --------------------------------------------- | ------------- |
| `schema.register(v.*)` | one value can be edited concurrently      | multi-value register with conflict resolution | yes           |
| `schema.prose()`       | collaborative rich text                   | character-level merge                         | yes           |
| `schema.counter()`     | additive numeric changes                  | summed increments                             | yes           |
| `schema.set(v.*)`      | membership / tags / add-wins sets         | add-wins set                                  | yes           |
| `schema.omit(v.*)`     | field must stay remote-only               | omitted from local sync                       | no            |
| plain `v.*`            | normal synced field with simple semantics | last-write-wins                               | yes           |

## `schema.omit(...)`

Use `schema.omit(...)` when a field should exist remotely but should not be
mirrored into the embedded local runtime.

```ts
export const tasks = embeddedTable("tasks", {
  title: schema.register(v.string()),
  remoteAttachmentId: schema.omit(v.string()),
  done: v.boolean(),
});
```

Good uses:

- large remote-only attachment metadata
- sensitive server-side identifiers
- fields the browser should never persist locally

## `resolve`

Every embedded synced table gets an auto-generated resolve query.

You should re-export it from the same module as the table's other public synced
functions:

```ts
export const resolve = tasks.resolve;
```

You normally do not call `resolve` yourself. The remote sync engine discovers it
and uses it during reconnect/resolve.

## Query `resolve.args`

If a query should be re-fetched after resolve, provide `resolve.args` so the
engine knows which query shape to refresh. Use an index-backed query shape here,
not `query.filter(...)`.

```ts
export const byProject = tasks.query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tasks")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
  resolve: {
    args: () => ({ projectId: currentProjectId() }),
  },
});
```

Use this only for queries whose remote-refresh shape matters after reconcile.

## `remote:` callbacks

`table.mutation(...)` and `table.query(...)` both support an optional `remote:`
callback.

### Mutation `remote:`

Runs only on remote Convex after the normal handler succeeds.

```ts
export const create = tasks.mutation({
  args: { title: v.string() },
  handler: async (ctx, args) => await ctx.db.insert("tasks", args),
  remote: async (_ctx, _args, taskId) => {
    await sendWebhook(taskId);
  },
});
```

Use it for server-only side effects.

### Query `remote:`

Runs only on remote Convex and can transform the remote result.

```ts
export const list = tasks.query({
  args: {},
  handler: async (ctx) => await ctx.db.query("tasks").collect(),
  remote: async (_ctx, _args, result) => {
    return result.map((task) => ({ ...task, source: "remote" }));
  },
});
```

## What stays remote-only automatically

Only tables declared with `embeddedTable()` participate in embedded sync.

Tables declared with plain `defineTable(...)` stay in the normal remote Convex
world unless you explicitly route or expose them another way.

## Next steps

- [Local vs Remote Execution](/guides/local-vs-remote)
- [Server API](/api/server)
- [CRDT Schema](/api/crdt)
