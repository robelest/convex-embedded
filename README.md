# convex-edge

Local-first development for Convex applications.

> **[Design doc & architecture (Notion)](https://www.notion.so/convex-edge-31e26eeb0e7e81549026e8dc5cc18191)**

## Packages

### @robelest/convex-embedded

In-memory Convex runtime in pure TypeScript. Point a standard `ConvexClient` at
it — existing queries, mutations, and actions execute locally with zero code
changes. Runs in any JS environment: browser, Tauri, Electron, Electrobun, React
Native, or server-side runtimes.

### @robelest/convex-resolve

Offline-first sync between a local embedded runtime and a remote Convex backend.
Uses Yjs CRDTs for automatic conflict resolution on reconnect. Handles schema
versioning, delta recording, and reconnect orchestration.

### @robelest/fx

Lightweight functional effect library for composable async error handling. Lazy
`Fx<A, E>` computations with `pipe()` chaining and generator-based `Fx.gen`
composition. Used pervasively across both `convex-embedded` and `convex-resolve`
for all async/error-handling code:

- **`Fx.bracket`** — Resource lifecycle (transactions, global patching, queue flags)
- **`Fx.gen`** — Sequential composition (migration steps, scheduled function state machines)
- **`Fx.from` + `Fx.recover`** — Fallible operations with typed error recovery
- **`Fx.detach`** — Fire-and-forget (scheduled functions, background persistence)
- **`Fx.zip`** — Parallel hydration (ID map + pending queue)
- **`Fx.fold`** — Outcome mapping (mutation success/failure → final state)
- **`Fx.retry`** — Exponential backoff with jitter (OCC transactions, CRDT resolve)

## Quick start

### Local-only (no sync)

```typescript
import { createConvexClient } from "@robelest/convex-embedded/browser";

const client = createConvexClient({
  modules: import.meta.glob("./convex/*.ts"),
});

// Use with any Convex framework integration — useQuery, ConvexProvider, etc.
```

### Local-first with remote sync

```typescript
import { createConvexClient } from "@robelest/convex-embedded/browser";

const client = createConvexClient({
  modules: import.meta.glob("./convex/*.ts"),
  sync: { url: "https://happy-otter-123.convex.cloud" },
});

// Queries read from local database (instant, offline-capable).
// Mutations write locally first, then replay to remote.
// Reactive subscriptions keep local state fresh with remote changes.
```

### Server-side functions with resolve

```typescript
// convex/sync.ts — one-time setup per app
import { setup } from "@robelest/convex-resolve/server";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

export const register = setup({
  component: components.resolve,
  mutation,
  query,
});
```

```typescript
// convex/tasks.ts — per synced table
import { register } from "./sync";
import { taskSchema } from "./schema";
import { v } from "convex/values";

const tasks = register("tasks", taskSchema);

export const resolve = tasks.resolve;

export const complete = tasks.mutation({
  args: { id: v.id("tasks") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { done: true });
    return id;
  },
});

export const list = tasks.query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("tasks").collect();
  },
});
```

### Observing sync state

```typescript
import {
  createConvexClient,
  subscribeResolveState,
} from "@robelest/convex-embedded/browser";

const client = createConvexClient({
  modules: import.meta.glob("./convex/*.ts"),
  sync: { url: import.meta.env.CONVEX_URL },
});

const unsub = subscribeResolveState(client, (state) => {
  console.log("Sync:", state.status);
  // "idle" | "connecting" | "syncing" | "synced" | "offline" | "error"
});
```

### SvelteKit integration

```svelte
<!-- +layout.svelte -->
<script lang="ts">
  import { createConvexClient } from "@robelest/convex-embedded/browser";
  import { setConvexClientContext } from "convex-svelte";
  import { onDestroy } from "svelte";

  const modules = import.meta.glob("../../convex/*.ts");
  const client = createConvexClient({
    modules,
    sync: { url: import.meta.env.CONVEX_URL },
  });

  setConvexClientContext(client);
  onDestroy(() => client.close());

  // HMR cleanup
  if (import.meta.hot) {
    import.meta.hot.dispose(() => client.close());
  }
</script>
```

```svelte
<!-- +page.svelte -->
<script lang="ts">
  import { useQuery, useConvexClient } from "convex-svelte";
  import { api } from "../../convex/_generated/api";

  const tasks = useQuery(api.tasks.list, {});
  const client = useConvexClient();

  async function addTask(title: string) {
    await client.mutation(api.tasks.create, { title });
  }
</script>
```

## Project structure

```
convex-edge/
  package.json              # Bun workspace root
  convex/                   # Root-level Convex functions (tasks CRUD)
  packages/
    convex-embedded/        # @robelest/convex-embedded
    convex-resolve/         # @robelest/convex-resolve
    fx/                     # @robelest/fx
    test/                   # @robelest/convex-edge-tests (private)
  demos/
    svelte/                 # SvelteKit demo using convex-embedded
```

## Development

### Prerequisites

- Bun >= 1.x
- Node >= 20

### Install

```sh
bun install
```

### Build

```sh
bun run build
```

### Test

```sh
bun run test
```

**Important**: Always use `bun run test`, never `bun test` (bun's built-in
runner is incompatible with the vitest-based test suite).

Run a specific test suite:

```sh
bun --filter @robelest/convex-edge-tests test:embedded
bun --filter @robelest/convex-edge-tests test:resolve
bun --filter @robelest/convex-edge-tests test:integration
```

### Lint & format

```sh
bun run lint
bun run fmt
```

### Demo

```sh
bun run dev:svelte
```

## License

MIT
