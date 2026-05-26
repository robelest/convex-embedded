---
title: Svelte Integration
description: Using convex-embedded with SvelteKit and convex-svelte.
---

<svelte:head>

  <title>Svelte Integration - convex-embedded</title>
</svelte:head>

# Svelte Integration

convex-embedded integrates with SvelteKit through `convex-svelte`. The practical
client-only flow is: disable SSR, create the client in your layout, provide it
once, and use the normal query/mutation helpers.

If you want SSR for the initial route, the supported path is different: run the
query on the server in a `+layout.server.ts` / `+page.server.ts` loader with
`preloadQuery(...)`, pass the `Preloaded` payload to your page, and render it
through a small `usePreloadedQuery` helper that swaps to the live local query
once it resolves.

## Quick start

### 1. Disable SSR

The embedded runtime requires browser APIs (IndexedDB, WebAssembly, Worker).
Create a `+layout.ts` file that disables SSR:

```ts
// src/routes/+layout.ts
export const ssr = false;
export const prerender = false;
```

### 2. Create the client in +layout.svelte

Initialize the embedded client in your root layout and provide it to the
component tree via `setConvexClientContext`:

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { setConvexClientContext } from "convex-svelte";
  import { createConvexClient, subscribeRemoteState } from "@robelest/convex-embedded/browser";
  import type { RemoteState } from "@robelest/convex-embedded/browser";
  import { modules } from "../convex-modules";
  import { setContext } from "svelte";

  let { children } = $props();

  const client = createConvexClient({
    modules,
    schema,
    name: "my-app",
    remote: { url: import.meta.env.CONVEX_URL },
  });

  setConvexClientContext(client);

  // Reactive remote status shared via context
  let remoteStatus: RemoteState = $state({ status: "idle" });
  setContext("remoteStatus", () => remoteStatus);

  const unsubResolve = subscribeRemoteState(client, (s: RemoteState) => {
    remoteStatus = s;
  });

  // Cleanup on component destroy and HMR replacement
  onDestroy(() => {
    unsubResolve();
    client.close();
  });

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      unsubResolve();
      client.close();
    });
  }
</script>

{@render children()}
```

The `import.meta.hot?.dispose` handler ensures the client is cleaned up during
hot module replacement in development.

### 3. Use canonical module ids

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

### 4. Use queries and mutations in pages

In any page or component under the layout, use `useQuery` and `useConvexClient`
from `convex-svelte`:

```svelte
<!-- src/routes/+page.svelte -->
<script lang="ts">
  import { getContext } from "svelte";
  import { useQuery, useConvexClient } from "convex-svelte";
  import { api } from "../convex/_generated/api.js";
  import type { RemoteState } from "@robelest/convex-embedded/browser";

  const client = useConvexClient();
  const tasks = useQuery(api.tasks.list, {});

  const getSyncStatus = getContext<() => RemoteState>("remoteStatus");

  let title = $state("");

  async function handleAdd() {
    const t = title.trim();
    if (!t) return;
    await client.mutation(api.tasks.create, { title: t });
    title = "";
  }

  async function handleRemove(id: string) {
    await client.mutation(api.tasks.remove, { id });
  }
</script>

<form onsubmit={(e) => { e.preventDefault(); handleAdd(); }}>
  <input bind:value={title} placeholder="Task title" />
  <button type="submit">Add</button>
</form>

{#if tasks.isLoading}
  <p>Loading...</p>
{:else if tasks.data}
  <ul>
    {#each tasks.data as task (task._id)}
      <li>
        {task.title}
        <button onclick={() => handleRemove(task._id)}>Remove</button>
      </li>
    {/each}
  </ul>
{/if}
```

## Common options

```ts
const client = createConvexClient({
  modules,
  schema,
  name: "my-app",
  remote: { url: import.meta.env.CONVEX_URL },
  auth: {
    fetchToken: myTokenFetcher,
    getUserIdentity: myIdentitySource,
  },
  encryption: myEncryptionHooks,
});
```

## Sync status indicator

Share the resolve state via Svelte context and build a status badge:

```svelte
<script lang="ts">
  import { getContext } from "svelte";
  import type { RemoteState } from "@robelest/convex-embedded/browser";

  const getSyncStatus = getContext<() => RemoteState>("remoteStatus");

  const statusLabel = $derived.by(() => {
    const s = getSyncStatus();
    switch (s.status) {
      case "idle":       return { text: "Local only",    color: "#9ca3af" };
      case "offline":    return { text: "Offline",       color: "#f59e0b" };
      case "connecting": return { text: "Connecting...", color: "#3b82f6" };
      case "resolving":    return { text: "Resolving...",    color: "#3b82f6" };
      case "resolved":  return { text: "Resolved",     color: "#10b981" };
      case "error":      return { text: "Sync error",    color: "#ef4444" };
    }
  });
</script>

<div style="display: flex; align-items: center; gap: 0.5rem;">
  <span
    style="width: 0.5rem; height: 0.5rem; border-radius: 9999px; background: {statusLabel.color};"
  ></span>
  {statusLabel.text}
</div>
```

## Local-only mode

If you do not need remote, omit the `remote` option. The client works as a
purely local embedded database:

```ts
const client = createConvexClient({
  modules,
  name: "my-local-app",
});
```

Queries and mutations work the same way; data is persisted to IndexedDB and
available offline. You can add `remote` later without changing any component
code.

## SSR with preloadQuery

To server-render the first route, run the query in a server loader with
`preloadQuery(...)` and fall back to `emptyPreloaded(...)` when there is no
remote URL:

```ts
// src/routes/+layout.server.ts
import { preloadQuery, emptyPreloaded } from "@robelest/convex-embedded/client";
import { api } from "../convex/_generated/api";

export const load = async ({ locals }) => {
  const convexUrl = import.meta.env.CONVEX_URL;
  let preloadedTasks = emptyPreloaded(api.tasks.list, {});
  if (convexUrl) {
    preloadedTasks = await preloadQuery(
      api.tasks.list,
      {},
      { url: convexUrl, token: locals.authToken },
    );
  }
  return { preloadedTasks };
};
```

`usePreloadedQuery` is small app-side glue rather than an SDK export. Build it
from `preloadedQueryResult` + `preloadedQueryRef` (client entry),
`whenPreloaded` (browser entry), and `convex-svelte`'s `useQuery`. Render the
preloaded value for SSR and first paint, then defer to the live local query once
`whenPreloaded` resolves:

```ts
// src/lib/usePreloadedQuery.svelte.ts
import { browser } from "$app/environment";
import { whenPreloaded } from "@robelest/convex-embedded/browser";
import {
  preloadedQueryResult,
  preloadedQueryRef,
  type Preloaded,
} from "@robelest/convex-embedded/client";
import { useConvexClient, useQuery } from "convex-svelte";
import { makeFunctionReference, type FunctionReference } from "convex/server";

export function usePreloadedQuery<Query extends FunctionReference<"query">>(
  preloaded: Preloaded<Query>,
) {
  const initial = preloadedQueryResult(preloaded);
  if (!browser) {
    return {
      get current() {
        return initial;
      },
    };
  }

  const client = useConvexClient();
  const { name, args } = preloadedQueryRef(preloaded);
  const live = useQuery(makeFunctionReference<Query>(name), () => args);

  let ready = $state(false);
  $effect(() => {
    void whenPreloaded(client, preloaded).then(() => (ready = true));
  });

  return {
    get current() {
      return ready ? (live.data ?? initial) : initial;
    },
  };
}
```

Use it from a page with the `data` returned by the loader:

```svelte
<script lang="ts">
  import { usePreloadedQuery } from "$lib/usePreloadedQuery.svelte";

  let { data } = $props();
  const tasks = usePreloadedQuery(data.preloadedTasks);
</script>

<ul>
  {#each tasks.current as task (task._id)}
    <li>{task.title}</li>
  {/each}
</ul>
```

## Key points

- **Client creation is browser-only** -- wa-sqlite still requires `IndexedDB`,
  `Worker`, and `WebAssembly`. If you want SSR, use `preloadQuery(...)` in a
  server loader instead of creating the client on the server.
- **Modules must stay lazy** -- Use canonical module ids like
  `"./convex/tasks.ts": () => import("./convex/tasks")`.
- **Always clean up** -- Call `client.close()` in both `onDestroy` and
  `import.meta.hot?.dispose` to prevent leaked workers during development.
- **Context pattern** -- Use `setConvexClientContext` from `convex-svelte` for
  the client, and Svelte's `setContext`/`getContext` for additional state like
  remote status.

## What happens after setup

After the client is created:

- local queries run against the embedded runtime
- local mutations commit immediately
- browser-specific worker/session/write transport stays behind the browser entry
- replay, leases, and resolve stay in shared core code
