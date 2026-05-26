---
title: Browser Integration
description: Create a browser client once and wire it into your framework.
---

<script>
  import Tabs from '$lib/components/docs/Tabs.svelte';
  import TabItem from '$lib/components/docs/TabItem.svelte';
</script>

<svelte:head>

  <title>Browser Integration - convex-embedded</title>
</svelte:head>

# Browser Integration

Most apps only need the browser entry point:

```ts
import { createConvexClient } from "@robelest/convex-embedded/browser";
```

The practical setup is:

1. build a lazy module registry
2. create one browser client
3. provide it to your framework
4. use the normal Convex hooks/APIs

The browser entry is framework agnostic. It intentionally returns a standard
`ConvexClient`, not a React-specific wrapper. For React hooks, use
`@robelest/convex-embedded/react`.

## 1. Create the module registry

Use canonical module ids:

```ts
import type { ConvexModuleRegistry } from "@robelest/convex-embedded/browser";

export const modules = {
  "./convex/tasks.ts": () => import("../convex/tasks"),
  "./convex/schema.ts": () => import("../convex/schema"),
  "./convex/_generated/api.ts": () => import("../convex/_generated/api"),
  "./convex/_generated/server.ts": () => import("../convex/_generated/server"),
} satisfies ConvexModuleRegistry;
```

## 2. Create the client

```ts
import { createConvexClient } from "@robelest/convex-embedded/browser";
import schema from "../convex/schema";
import { modules } from "./convex-modules";

export const client = createConvexClient({
  modules,
  schema,
  name: "my-app",
  remote: { url: import.meta.env.CONVEX_URL },
});
```

Common options:

| Option       | Use                                                 |
| ------------ | --------------------------------------------------- |
| `modules`    | required lazy module registry                       |
| `schema`     | write-time validation and embedded schema metadata  |
| `name`       | shared local database name across tabs              |
| `remote`     | local-first sync against a remote Convex deployment |
| `auth`       | embedded identity + remote token wiring             |
| `encryption` | encrypt persisted local state at rest               |

## 3. Provide it to your framework

<Tabs>
  <TabItem label="Svelte">

```svelte
<script lang="ts">
  import { onDestroy } from "svelte";
  import { setConvexClientContext } from "convex-svelte";
  import { client } from "./convex-client";

  let { children } = $props();
  setConvexClientContext(client);

  onDestroy(() => {
    client.close();
  });
</script>

{@render children()}
```

  </TabItem>
  <TabItem label="Raw Client">

```ts
import { client } from "./convex-client";

const tasks = await client.query(api.tasks.list, {});
const createTask = (args: { title: string; body: string }) =>
  client.mutation(api.tasks.create, args);
```

  </TabItem>
</Tabs>

## 4. Use normal Convex APIs

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
  <TabItem label="Raw Client">

```ts
import { api } from "../convex/_generated/api";
import { client } from "./convex-client";

const tasks = await client.query(api.tasks.list, {});
const firstPage = await client.query(api.tasks.paginated, {
  paginationOpts: { cursor: null, numItems: 20, id: -1 },
});
```

  </TabItem>
</Tabs>

## SSR and pagination

Imports from `@robelest/convex-embedded/browser` are SSR-safe, but client
creation is still a browser-only step.

For SSR startup, run your first query on the server with `preloadQuery(...)`,
hand the result to your client component for first paint, then create the
browser client and defer to the live local query once `whenPreloaded(...)`
resolves.

Server loader:

```ts
import { preloadQuery, emptyPreloaded } from "@robelest/convex-embedded/client";
import { api } from "$convex/_generated/api";

export const load = async () => {
  let preloadedTasks = emptyPreloaded(api.tasks.list, {});
  if (convexUrl) {
    preloadedTasks = await preloadQuery(
      api.tasks.list,
      {},
      { url: convexUrl, token },
    );
  }
  return { preloadedTasks };
};
```

Client component handoff:

```ts
import {
  preloadedQueryResult,
  preloadedQueryRef,
  type Preloaded,
} from "@robelest/convex-embedded/client";
import { whenPreloaded } from "@robelest/convex-embedded/browser";

// render preloadedQueryResult(preloaded) for SSR + first paint, then defer to the
// live local query (framework useQuery on preloadedQueryRef(preloaded)) once
// whenPreloaded(client, preloaded) resolves.
```

Pagination support currently means:

- `preloadQuery(...)` covers non-paginated SSR; paginated queries load
  client-side, matching Convex
- raw browser clients can use paginated Convex queries directly
- `convex/react` pagination hooks are only documented through the Expo entry

## Cleanup

If the client lives for the page lifetime, module-scope creation is fine.

If you create clients dynamically, always call `client.close()` during cleanup.

That closes:

- the embedded runtime
- the browser sqlite worker
- session/write broadcast transports
- the remote client and sync engine when `remote` is enabled

## What happens under the hood

After setup:

- local queries read from the embedded runtime
- local mutations commit immediately
- cross-tab propagation uses browser transport adapters
- replay, resolve, leases, and auth state transitions stay in shared core code

## Next steps

- [Embedded Tables & Fields](/guides/embedded-tables)
- [Local vs Remote Execution](/guides/local-vs-remote)
- [Browser API](/api/browser)
