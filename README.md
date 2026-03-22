# convex-embedded

Local-first development for Convex applications.

> **[Documentation (Notion)](https://www.notion.so/31e26eeb0e7e81549026e8dc5cc18191)**

## Packages

### @robelest/convex-embedded

In-memory Convex runtime in pure TypeScript. `createConvexClient()` returns a
standard `ConvexClient` backed by a local embedded runtime with wa-sqlite
persistence. Existing queries, mutations, and actions execute locally with zero
code changes. Includes offline-first sync with a remote Convex backend via Yjs
CRDTs for automatic conflict resolution on reconnect. Runs in any JS
environment: browser, Tauri, Electron, Electrobun, React Native, or server-side
runtimes.

### @robelest/fx

Lightweight functional effect library for composable async error handling. Lazy
`Fx<A, E>` computations with `pipe()` chaining and generator-based `Fx.gen`
composition. Used across `convex-embedded` for all async and error-handling
code.

## Quick start

### 1. Install

```sh
vp add @robelest/convex-embedded
```

### 2. Define schema

`embeddedTable()` replaces `defineTable()` for tables that sync between local
and remote. It accepts CRDT field descriptors (`schema.register()`,
`schema.prose()`) alongside plain Convex validators (`v.boolean()`). Plain
validators become last-write-wins fields.

```typescript
// convex/schema.ts
import { schema } from "@robelest/convex-embedded/crdt";
import { embeddedTable } from "@robelest/convex-embedded/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const tasks = embeddedTable("tasks", {
  title: schema.register(v.string()),
  body: schema.register(v.string()),
  done: v.boolean(), // plain field, LWW
});

export default defineSchema({
  tasks,
  analytics: defineTable({ event: v.string() }), // normal remote-only table
});
```

### 3. Bind the component

One file, one call. This connects CRDT delta recording and resolve queries to
the Convex component. Function registration does not depend on this file.

```typescript
// convex/embedded.ts
import { setup } from "@robelest/convex-embedded/server";
import { components } from "./_generated/api";

setup({ component: components.embedded });
```

```typescript
// convex/convex.config.ts
import { defineApp } from "convex/server";
import embedded from "@robelest/convex-embedded/convex.config";

const app = defineApp();
app.use(embedded);
export default app;
```

### 4. Write functions

Import the table handle from schema. Use `.mutation()` and `.query()` directly.
No `register()` call. The resolve query is auto-generated on the table handle,
but you should still re-export it so sync discovery can find it.

```typescript
// convex/tasks.ts
import { tasks } from "./schema";
import { v } from "convex/values";

export const resolve = tasks.resolve;

export const create = tasks.mutation({
  args: { title: v.string(), body: v.string() },
  handler: async (ctx, args) => ctx.db.insert("tasks", args),
});

export const update = tasks.mutation({
  args: { id: v.id("tasks"), title: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    const { id, ...fields } = args;
    await ctx.db.patch(id, fields);
    return id;
  },
});

export const list = tasks.query({
  args: {},
  handler: async (ctx) => ctx.db.query("tasks").collect(),
});
```

### 5. Use the client

```typescript
import { createConvexClient } from "@robelest/convex-embedded/browser";
import schema from "./convex/schema";

// Local-only (no sync)
const client = createConvexClient({
  modules: import.meta.glob([
    "./convex/**/*.{ts,tsx,js,jsx}",
    "!./convex/convex.config.ts",
  ]),
  schema,
  name: "my-local-app",
});

// Local-first with remote sync
const client = createConvexClient({
  modules: import.meta.glob([
    "./convex/**/*.{ts,tsx,js,jsx}",
    "!./convex/convex.config.ts",
  ]),
  schema,
  name: "my-local-app",
  sync: { url: "https://happy-otter-123.convex.cloud" },
});

// Use with any Convex framework integration — useQuery, ConvexProvider, etc.
```

## Server-side execution model

Every wrapped function has a `handler` and an optional `remote:` block.
`handler` runs on both local and remote. `remote:` runs only on remote Convex,
in the same transaction.

```typescript
export const complete = tasks.mutation({
  args: { id: v.id("tasks") },

  // Runs on both local embedded and remote Convex
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { done: true });
    return id;
  },

  // Runs only on remote Convex, same transaction
  remote: async (ctx, { id }, result) => {
    await ctx.scheduler.runAfter(0, internal.webhooks.notify, { id: result });
  },
});
```

Runtime detection is automatic. On the first handler invocation,
`detectRuntime()` probes the component reference. If reachable, `remote:` blocks
and delta recording execute. If unreachable, both are skipped. No public
`ctx.runtime` exists.

## Observing sync state

```typescript
import {
  createConvexClient,
  getResolveState,
  subscribeResolveState,
} from "@robelest/convex-embedded/browser";

const client = createConvexClient({
  modules: import.meta.glob([
    "./convex/**/*.{ts,tsx,js,jsx}",
    "!./convex/convex.config.ts",
  ]),
  schema,
  name: "my-local-app",
  sync: { url: import.meta.env.CONVEX_URL },
});

// Point-in-time read
const state = getResolveState(client);

// Reactive subscription
const unsub = subscribeResolveState(client, (state) => {
  console.log("Sync:", state.status);
  // "idle" | "connecting" | "syncing" | "synced" | "offline" | "error"
});
```

## SvelteKit integration

```svelte
<!-- +layout.svelte -->
<script lang="ts">
  import { createConvexClient } from "@robelest/convex-embedded/browser";
  import { setConvexClientContext } from "convex-svelte";
  import { onDestroy } from "svelte";
  import schema from "../../convex/schema";

  const modules = import.meta.glob([
    "../../convex/**/*.{ts,tsx,js,jsx}",
    "!../../convex/convex.config.ts",
  ]);
  const client = createConvexClient({
    modules,
    schema,
    name: "my-svelte-app",
    sync: { url: import.meta.env.CONVEX_URL },
  });

  setConvexClientContext(client);
  onDestroy(() => client.close());

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
    await client.mutation(api.tasks.create, { title, body: "" });
  }
</script>
```

## Export map

```
@robelest/convex-embedded
  /browser          createConvexClient, getResolveState, subscribeResolveState
  /server           embeddedTable, setup
  /crdt             schema.register, schema.prose, schema.counter, schema.set,
                    schema.omit, schema.define
  /client           Resolve engine internals (@internal)
  /convex.config    Component definition
  /test             Test helpers for convex-test
  /                 Low-level: EmbeddedRuntime, createEmbeddedConvex, etc.
```

## Project structure

```
convex-embedded/
  package.json              # Vite+ workspace root
  convex/                   # Root-level Convex functions (tasks CRUD + demo)
  packages/
    convex-embedded/        # @robelest/convex-embedded
    fx/                     # @robelest/fx
    test/                   # @robelest/embedded-tests (private)
  demos/
    svelte/                 # SvelteKit demo
```

## Development

### Prerequisites

- Bun >= 1.x
- Node >= 20

### Install

```sh
vp install
```

### Build

```sh
vp run build
```

### Test

```sh
vp run test
```

Always use `vp test` or `vp run test`, never `bun test`.

Run a specific test suite:

```sh
vp run --filter @robelest/embedded-tests test:embedded
vp run --filter @robelest/embedded-tests test:resolve
vp run --filter @robelest/embedded-tests test:integration
```

### Lint & format

```sh
vp run lint
vp run fmt
```

### Demo

```sh
vp run dev:svelte
```

## Future work

- **`@robelest/r-ts`** — Pure-TypeScript CRDT engine (FugueMax, Eg-walker,
  Peritext) to replace Yjs. Standalone package, usable without Convex.
- **Encrypted local storage** — AES-256-GCM encryption of persisted data at the
  `StorageAdapter` level. First-class `createConvexClient({ encryption: true })`
  option.

## License

MIT
