# convex-edge

Local-first development for Convex applications.

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

## Quick start

### Embedded runtime (standalone)

```typescript
import { createEmbeddedConvex } from "@robelest/convex-embedded";
import { ConvexReactClient } from "convex/react";

// 1. Load your convex modules
const modules = import.meta.glob("./convex/**/*.ts", { eager: true });

// 2. Create the runtime
const runtime = createEmbeddedConvex({ modules });

// 3. Create a standard Convex client over the loopback transport
const transport = runtime.createTransport();
const client = new ConvexReactClient(transport.url, {
  webSocketConstructor: transport.webSocketConstructor,
});

// 4. Use as normal — useQuery, useMutation, etc.
```

Or use the browser convenience wrapper:

```typescript
import { getEmbeddedClient } from "@robelest/convex-embedded/browser";

const modules = import.meta.glob("./convex/**/*.ts", { eager: true });
const client = getEmbeddedClient({ modules });
```

### With sync (embedded + resolve)

```typescript
// convex/functions.ts — shared mutation/query builders
import { builders } from "@robelest/convex-resolve/server";
import { components } from "./_generated/api";

export const { mutation, query } = builders(components);
```

```typescript
// convex/tasks.ts — functions that work locally and remotely
import { register, schema } from "@robelest/convex-resolve/server";
import { mutation, query } from "./functions";
import { v } from "convex/values";

const taskSchema = schema.define({
  version: 1,
  shape: v.object({
    title: schema.register(v.string()),
    body: schema.prose(),
    done: v.boolean(),
  }),
});

const { resolve, _recordDelta, wrapMutation } = register({
  table: "tasks",
  schema: taskSchema,
  component: components.resolve,
});

export { resolve, _recordDelta };

export const complete = wrapMutation(
  _recordDelta,
  mutation({
    args: { id: v.id("tasks") },
    handler: async (ctx, { id }) => {
      await ctx.db.patch(id, { done: true });
    },
    remote: async (ctx, { id }) => {
      await ctx.scheduler.runAfter(0, internal.webhooks.notify, { id });
    },
  }),
);

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("tasks").collect();
  },
});
```

```typescript
// Client — monitor for online/offline sync
import { monitor } from "@robelest/convex-resolve/client";
import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api";

const remoteClient = new ConvexClient(CONVEX_URL);
const m = monitor.create({
  remoteClient,
  tables: {
    tasks: { resolve: api.tasks.resolve },
  },
});

m.start();
m.on("change", (status) => console.log(status.status));
```

## Project structure

```
convex-edge/
  package.json              # Bun workspace root
  convex/                   # Root-level Convex functions (tasks CRUD)
  packages/
    convex-embedded/        # @robelest/convex-embedded
    convex-resolve/         # @robelest/convex-resolve
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
