# `@robelest/convex-embedded`

Embedded Convex runtime for local-first applications. Write idiomatic
Convex/React; reads, writes, mutations, files, scheduled functions,
HTTP routes, and components all run locally on a SQLite-backed doc
store and replay to a remote deployment when online.

## Entry points

- `@robelest/convex-embedded` — runtime primitives plus the
  `WorkScheduler` interface, route helpers, and the TanStack DB
  collection seam.
- `@robelest/convex-embedded/browser` — `createConvexClient()` for web
  apps. OPFS-backed SQLite via `wa-sqlite`, auth, remote sync.
- `@robelest/convex-embedded/expo` — `createConvexClient()` for Expo
  / React Native. `@op-engineering/op-sqlite` storage, Expo-backed
  file, network, and crypto adapters.
- `@robelest/convex-embedded/node` — `createConvexClient()` for Node
  servers and tests. `better-sqlite3` storage. Pairs with
  `dispatchHttpRequest` to act as a "low-powered Convex" deployment.
- `@robelest/convex-embedded/react` — React client wrapper that
  satisfies `convex/react` hooks (`useQuery`, `useMutation`,
  `usePaginatedQuery`).
- `@robelest/convex-embedded/server` — `embeddedTable()`,
  `localOnly()` / `remoteOnly()` markers, schema + migration helpers,
  and Convex-side setup utilities.
- `@robelest/convex-embedded/crdt` — CRDT field constructors and
  runtime helpers for reading Yjs-backed state.
- `@robelest/convex-embedded/vite` — `convexEmbedded()` Vite plugin
  that runs codegen on dev start and re-runs on `convex/` file
  changes.
- `@robelest/convex-embedded/tracing/{memory,browser,node}` —
  OpenTelemetry tracer + meter providers for tests, dev tools, and
  production collection.

## Code generation

`convex-embedded codegen` (or `vp run -w codegen:embedded` in this
monorepo) walks `convex/`, AST-strips every module whose Convex
exports are wrapped in `remoteOnly()`, and emits
`convex/_generated/embedded.ts`:

```jsonc
// package.json
{
  "scripts": {
    "predev":   "convex codegen && convex-embedded codegen",
    "prebuild": "convex codegen && convex-embedded codegen"
  }
}
```

```ts
// app/main.ts
import { convex } from "../convex/_generated/embedded";
createConvexClient({ convex });
```

Files where every Convex registration is wrapped in `remoteOnly()`
disappear from the client bundle entirely. Mixed files emit a stripped
companion at `convex/_generated/embedded/<path>.ts` containing only
local-runnable exports plus their actual transitive dependencies; the
rest is removed from the source the bundler sees, not just hidden
behind a runtime check. Bundlers tree-shake the original module away
because no static path reaches it (`_generated/api.ts` is type-only).

`--watch` enables fs-based watch mode; users on Vite can use the plugin
instead:

```ts
// vite.config.ts
import { convexEmbedded } from "@robelest/convex-embedded/vite";
export default defineConfig({ plugins: [convexEmbedded()] });
```

## Route helpers

Mark per-export with one of:

```ts
import { localOnly, remoteOnly } from "@robelest/convex-embedded/server";

// Server-only: dispatched remote, stripped from client bundle
export const chargeCard = remoteOnly(internalMutation({ ... }));

// Local-only: dispatched in the embedded runtime, never replayed
export const recomputeStats = localOnly(internalMutation({ ... }));
```

Runtime introspection: `getRouteMode(value)`, `isRemoteOnly(value)`,
`isLocalOnly(value)` from `@robelest/convex-embedded`. The runtime
consults these at every dispatch site (top-level `client.mutation`,
nested `ctx.runQuery/Mutation/Action`, cron firings, httpAction
dispatch, replay queue).

## Scheduled functions (cron)

Define `convex/crons.ts` exactly as you would for a cloud-only
Convex app:

```ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("recompute stats", { minutes: 5 }, internal.stats.recompute);
crons.daily(
  "send digest",
  { hourUTC: 9, minuteUTC: 0 },
  internal.emails.sendDigest,
);

export default crons;
```

Crons whose target function is wrapped in `remoteOnly()` are skipped
at discovery — they fire on the cloud only. The rest run locally with
per-job `setTimeout` against `nextFireMs`. Single-tab firing for now;
multi-tab dedup via system-mutation lease is a planned follow-on.

## HTTP routes

Define `convex/http.ts` as you would for cloud Convex (`httpRouter`).
The runtime exposes:

```ts
client.dispatchHttpRequest(request: Request): Promise<Response>
```

That signature is the standard Web fetch handler; it plugs straight
into:

```ts
// Bun
Bun.serve({ port: 8080, fetch: client.dispatchHttpRequest });
// Deno
Deno.serve({ port: 8080 }, client.dispatchHttpRequest);
// Cloudflare Workers
export default { fetch: client.dispatchHttpRequest };
// Hono
app.all("*", (c) => client.dispatchHttpRequest(c.req.raw));
```

For Node, use [`@whatwg-node/server`](https://github.com/ardatan/whatwg-node):

```ts
import { createServerAdapter } from "@whatwg-node/server";
http.createServer(createServerAdapter(client.dispatchHttpRequest))
    .listen(8080, "0.0.0.0");
```

Routes whose handler is wrapped in `remoteOnly()` return 404 from the
local dispatcher — webhook handlers (Stripe, GitHub, OAuth callbacks)
correctly stay server-only.

## Offline file uploads

`ctx.storage.store(blob)` always writes the blob locally + a row in
`_resolve_pending_uploads`. The engine drains the upload queue on
reconnect:

1. claim a pending row under the processor lease
2. read the blob from local storage
3. call the discovered remote `generateUploadUrl()` and PUT the blob
4. record `localStorageId → remoteStorageId` in the IdMap
5. remove the row

Subsequent mutation replays find the storage id pre-translated; the
just-in-time upload path inside mutation replay still exists as a
safety net for blobs created after reconnect. Observable depth is
emitted as the `convex.embedded.pending_uploads.depth` gauge.

## Observability

The runtime emits OpenTelemetry spans, events, counters, and gauges
through the standard global API. Install the in-memory provider in
tests + dev tools:

```ts
import { installInMemoryTracing } from "@robelest/convex-embedded/tracing/memory";

const tracing = installInMemoryTracing();
// ... run your code ...
const spans = tracing.getSpans();          // BufferedSpan[]
const metrics = await tracing.getMetrics(); // BufferedMetricPoint[]
await tracing.close();
```

Stable metric names include `convex.embedded.replay.success`,
`convex.embedded.replay.failure`, `convex.embedded.cron.fired`,
`convex.embedded.cron.skipped_remote`,
`convex.embedded.http_dispatch` (with `result` attribute),
`convex.embedded.pending_queue.depth`,
`convex.embedded.pending_uploads.depth`. State-transition events
include `lease.acquired` / `replay.started` / `cron.fired` /
`http.dispatch.404` / `connectivity.online` / `connectivity.offline`.

For production, install
`@robelest/convex-embedded/tracing/{browser,node}` to attach OTLP
exporters or any other OTel `SpanProcessor` / `MetricReader`.

## TanStack DB seam

`@robelest/convex-embedded` (the root entry) exports
`convexEmbeddedCollectionOptions` for users who want d2ts-style
incremental live queries on top of the embedded sync engine:

```ts
import { createCollection } from "@tanstack/db";
import { convexEmbeddedCollectionOptions } from "@robelest/convex-embedded";

const issues = createCollection(
  convexEmbeddedCollectionOptions({
    client,
    query: api.issues.forProject,
    args: { projectId },
    mutations: {
      insert: api.issues.create,
      update: api.issues.update,
      delete: api.issues.remove,
    },
  }),
);
```

`@tanstack/db` is an optional peer dependency. The seam is a thin
wiring helper (~150 lines) — it doesn't pull TanStack DB into your
bundle unless you install it.

## Migrations

Each `embeddedTable` declares its current schema version and a map of
step functions keyed by target version. The runtime resolves the
lowest stored version on hydrate and replays each step in order.
`ctx.step()` checkpoints work in `_resolve_schema_steps` so an
interrupted migration resumes at the next boot.

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
- **Codegen**: `typescript >= 5.0` (used by the AST stripper).
- **TanStack DB seam**: `@tanstack/db` (optional).

## Debug logging

Internal logs are silent by default. Enable verbose tracing in two ways:

```ts
new EmbeddedRuntime({ convex, debug: true });
```

```sh
CONVEX_EMBEDDED_DEBUG=1 node ./your-app.js
```
