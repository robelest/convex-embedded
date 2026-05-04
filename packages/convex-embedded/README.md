# `@robelest/convex-embedded`

Embedded Convex runtime for local-first applications.

## API Overview

- `@robelest/convex-embedded` — runtime primitives such as
  `createEmbeddedRuntime()` and transport helpers.
- `@robelest/convex-embedded/browser` — browser-first `createConvexClient()`
  factory with OPFS-backed sqlite, auth, and remote sync wiring.
- `@robelest/convex-embedded/expo` — Expo `createConvexClient()` factory with
  `@op-engineering/op-sqlite` storage plus Expo-backed file, network, and
  crypto adapters.
- `@robelest/convex-embedded/node` — Node `createConvexClient()` factory backed
  by file-based sqlite for tests and server-side embedded use.
- `@robelest/convex-embedded/server` — `embeddedTable()`, schema helpers, the
  migrations API, and Convex-side setup utilities.
- `@robelest/convex-embedded/crdt` — CRDT field constructors and runtime
  helpers for reading Yjs-backed state.
- `@robelest/convex-embedded/client` — client bootstrap helpers such as
  `createEmbeddedPrefetch()` for SSR/bootstrap data loading.
- `@robelest/convex-embedded/test` — test helpers for registering the packaged
  component with `convex-test`.

## Migrations

Each `embeddedTable` declares its current schema version and a map of step
functions keyed by target version. The runtime resolves the lowest stored
version on hydrate and replays each step in order. `ctx.step()` checkpoints
work in `_resolve_schema_steps` so an interrupted migration resumes at the
next boot.

```ts
import { embeddedTable } from "@robelest/convex-embedded/server";
import { v } from "convex/values";

export const tasks = embeddedTable(
  "tasks",
  v.object({
    title: v.string(),
    archived: v.boolean(),
  }),
  {
    version: 2,
    migrations: {
      2: async (ctx) => {
        await ctx.step("default-archived", async () => {
          for await (const row of ctx.db.query("tasks")) {
            if (row.archived === undefined) {
              await ctx.db.patch(row._id, { archived: false });
            }
          }
        });
      },
    },
  },
);
```

## Peer dependencies

- **Browser**: native APIs only (OPFS via `wa-sqlite` is bundled).
- **Expo / React Native**: `@op-engineering/op-sqlite`.
- **Node**: `better-sqlite3`.

## Debug logging

Internal logs are silent by default. Enable verbose tracing in two ways:

```ts
new EmbeddedRuntime({ convex, debug: true });
```

```sh
CONVEX_EMBEDDED_DEBUG=1 node ./your-app.js
```
