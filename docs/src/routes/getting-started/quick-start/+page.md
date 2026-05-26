---
title: Quick Start
description:
  A step-by-step walkthrough to get convex-embedded running in your app.
---

<script>
  import Tabs from '$lib/components/docs/Tabs.svelte';
  import TabItem from '$lib/components/docs/TabItem.svelte';
</script>

<svelte:head>

  <title>Quick Start - convex-embedded</title>
</svelte:head>

# Quick Start

This guide walks through the current setup model: defining an embedded table,
binding the component, writing local-first functions, and creating a browser
client.

## 1. Define Your Schema

In `convex/schema.ts`, use `embeddedTable()` instead of `defineTable()` for
tables you want mirrored locally and reconciled with the remote Convex
deployment. Fields wrapped with `schema.register()` become CRDT-aware; plain
`v.*` validators remain last-write-wins.

```ts
// convex/schema.ts
import { schema } from "@robelest/convex-embedded/crdt";
import { embeddedTable } from "@robelest/convex-embedded/server";
import { defineSchema } from "convex/server";
import { v } from "convex/values";

export const tasks = embeddedTable("tasks", {
  title: schema.register(v.string()),
  body: schema.prose(),
  votes: schema.counter(),
  remoteAttachmentId: schema.omit(v.string()),
  done: v.boolean(),
});

export default defineSchema({
  tasks,
});
```

The `tasks` handle returned by `embeddedTable()` is both a valid
`TableDefinition` (so `defineSchema` accepts it) and a builder for mutations and
queries.

## 2. Bind The Remote Component

Export a `bind` helper from each synced module to attach the embedded component.
This enables CRDT delta recording on the remote Convex backend.

```ts
// convex/tasks.ts
import { bindTable } from "@robelest/convex-embedded/server";
import { components } from "./_generated/api";
import { tasks } from "./schema";

export const bind = bindTable(tasks, components.embedded);
```

`bindTable(...)` is explicit and per-table. Function registration still happens
at definition time; binding only adds the remote component hooks used for CRDT
delta recording and resolve.

## 3. Write Functions

Write your mutations and queries using the `tasks` handle from the schema. The
API mirrors standard Convex functions:

```ts
// convex/tasks.ts
import { bindTable } from "@robelest/convex-embedded/server";
import { components } from "./_generated/api";
import { v } from "convex/values";
import { tasks } from "./schema";

export const bind = bindTable(tasks, components.embedded);
export const resolve = tasks.resolve;

export const create = tasks.mutation({
  args: { title: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("tasks", {
      ...args,
      done: false,
      votes: 0,
    });
  },
  remote: async (_ctx, _args, taskId) => {
    await sendTaskCreatedWebhook(taskId);
  },
});

export const update = tasks.mutation({
  args: { id: v.id("tasks"), title: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    const { id, ...fields } = args;
    await ctx.db.patch(id, fields);
    return id;
  },
});

export const remove = tasks.mutation({
  args: { id: v.id("tasks") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
    return args.id;
  },
});

export const list = tasks.query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("tasks"),
      _creationTime: v.number(),
      title: v.string(),
      body: v.string(),
    }),
  ),
  handler: async (ctx) => {
    return await ctx.db.query("tasks").collect();
  },
  resolve: {
    args: () => ({}),
  },
});
```

The important embedded-specific pieces here are:

- `export const bind = bindTable(tasks, components.embedded)`
- `export const resolve = tasks.resolve`
- `remote:` for server-only follow-up logic
- `resolve.args` for queries that should be re-fetched after resolve
- `schema.omit(...)` for fields that must stay remote-only

## 4. Create the Client

In your app's entry point, call `createConvexClient()`. It returns a standard
`ConvexClient` that works with any Convex framework integration.

First, create a lazy module registry using canonical module ids:

```ts
// src/convex-modules.ts
import type { ConvexModuleRegistry } from "@robelest/convex-embedded/browser";

export const modules = {
  "./convex/tasks.ts": () => import("../convex/tasks"),
  "./convex/schema.ts": () => import("../convex/schema"),
  "./convex/_generated/api.ts": () => import("../convex/_generated/api"),
  "./convex/_generated/server.ts": () => import("../convex/_generated/server"),
} satisfies ConvexModuleRegistry;
```

<Tabs>
  <TabItem label="Svelte">

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { onDestroy, setContext } from "svelte";
  import { setConvexClientContext } from "convex-svelte";
  import {
    createConvexClient,
    subscribeRemoteState,
  } from "@robelest/convex-embedded/browser";
  import type { RemoteState } from "@robelest/convex-embedded/browser";
  import { modules } from "../convex-modules";
  import schema from "../convex/schema";

  let { children } = $props();

  const client = createConvexClient({
    modules,
    schema,
    name: "my-app",
    remote: { url: import.meta.env.CONVEX_URL },
  });

  setConvexClientContext(client);

  let remoteStatus: RemoteState = $state({ status: "idle" });
  setContext("remoteStatus", () => remoteStatus);

  const unsubResolve = subscribeRemoteState(
    client,
    (s: RemoteState) => {
      remoteStatus = s;
    },
  );

  onDestroy(() => {
    unsubResolve();
    client.close();
  });
</script>

{@render children()}
```

  </TabItem>
  <TabItem label="React">

```tsx
// src/main.tsx
import { createConvexReactClient } from "@robelest/convex-embedded/react";
import { ConvexProvider } from "convex/react";
import { modules } from "./convex-modules";
import schema from "../convex/schema";

const client = createConvexReactClient({
  modules,
  schema,
  name: "my-app",
  remote: { url: import.meta.env.CONVEX_URL },
});

function App() {
  return <ConvexProvider client={client}>{/* your app */}</ConvexProvider>;
}
```

  </TabItem>
</Tabs>

### Key Options

| Option    | Required | Description                                                                                          |
| --------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `modules` | Yes      | Lazy ESM registry keyed by canonical module id, e.g. `"./convex/tasks.ts": () => import("./tasks")`. |
| `schema`  | No       | Default export from `convex/schema.ts`. Enables write-time validation.                               |
| `name`    | No       | IndexedDB database name. Tabs sharing the same name share data. Defaults to `"convex-embedded"`.     |
| `remote`  | No       | `{ url: string }` -- enables remote. Omit for a purely local embedded database.                      |
| `auth`    | No       | Auth configuration with `fetchToken`, `getUserIdentity`, and related hooks.                          |

### Notes on the current architecture

- browser persistence runs through `browser/sqlite/worker.ts`
- auth/session fanout is browser transport, while auth state and replay rules
  stay in core
- replay ownership uses processor-scoped leases, so multiple tabs can recover
  safely after crashes or abandoned sessions

### SSR with preloadQuery

If your app server-renders its first route, do not create the browser client on
the server. Instead:

1. run the query in a server loader with `preloadQuery(...)` from
   `@robelest/convex-embedded/client` (fall back to `emptyPreloaded(...)`)
2. pass the `Preloaded` payload to a client component
3. render `preloadedQueryResult(...)` for first paint, then defer to the live
   local query once `whenPreloaded(...)` resolves via a small
   `usePreloadedQuery` helper

That keeps the first browser render aligned with the SSR HTML.
`usePreloadedQuery` is app-side glue, not an SDK export; the convex-svelte demo
provides one. `preloadQuery(...)` covers non-paginated queries; paginated
queries load client-side, matching Convex.

## 6. Control local vs remote execution explicitly

Use routing helpers when you need strict execution behavior:

```ts
import { localOnly, remoteOnly } from "@robelest/convex-embedded/server";
import { action } from "./_generated/server";
import { query } from "./_generated/server";
import { v } from "convex/values";

export const localDrafts = localOnly(
  query({
    args: {},
    handler: async (ctx) => await ctx.db.query("drafts").collect(),
  }),
);

export const sendEmail = remoteOnly(
  action({
    args: { to: v.string() },
    handler: async (_ctx, args) => {
      await sendEmailViaProvider(args.to);
    },
  }),
);
```

- `localOnly(...)` means local or fail
- `remoteOnly(...)` means remote or fail

## 5. Use Queries and Mutations

Once the client is provided to your framework, use queries and mutations exactly
as you would with a normal Convex app:

<Tabs>
  <TabItem label="Svelte">

```svelte
<script lang="ts">
  import { useQuery, useMutation } from "convex-svelte";
  import { api } from "../convex/_generated/api";

  const tasks = useQuery(api.tasks.list, {});
  const createTask = useMutation(api.tasks.create);
</script>

{#each $tasks.data ?? [] as task}
  <p>{task.title}</p>
{/each}

<button onclick={() => createTask({ title: "New task", body: "" })}>
  Add Task
</button>
```

  </TabItem>
  <TabItem label="React">

```tsx
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";

function Tasks() {
  const tasks = useQuery(api.tasks.list) ?? [];
  const createTask = useMutation(api.tasks.create);

  return (
    <div>
      {tasks.map((task) => (
        <p key={task._id}>{task.title}</p>
      ))}
      <button onClick={() => createTask({ title: "New task", body: "" })}>
        Add Task
      </button>
    </div>
  );
}
```

  </TabItem>
</Tabs>

The queries read from the local embedded database (instant, offline-capable).
Mutations write locally first and replay to the remote backend in the
background.

## Next Steps

- [Embedded Tables & Fields](/guides/embedded-tables)
- [Local vs Remote Execution](/guides/local-vs-remote)
- [Server API](/api/server)
