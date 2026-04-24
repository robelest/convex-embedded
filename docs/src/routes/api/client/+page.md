---
title: Client API
 description: Client bootstrap helpers for building SSR/bootstrap payloads.
---

<svelte:head>

  <title>Client API - convex-embedded</title>
</svelte:head>

# Client API

The client entry point (`@robelest/convex-embedded/client`) is the advanced
bootstrap surface for convex-embedded. Most applications should still start with
[Browser API](/api/browser), but this module exposes the public
`createEmbeddedPrefetch(...)` helper used for SSR/bootstrap flows.

```ts
import {
  createEmbeddedPrefetch,
  emptyEmbeddedPrefetch,
  type Prefetch,
  type CreateEmbeddedPrefetchOptions,
  type CreateEmbeddedPrefetchResult,
  type EmbeddedPrefetchQuerySpec,
} from "@robelest/convex-embedded/client";
```

## What this entry point is for

Use this module if you are:

- building an SSR/bootstrap flow with `createEmbeddedPrefetch(...)`
- fetching serializable prefetch data on the server before first render
- seeding the browser runtime with `emptyEmbeddedPrefetch(...)` when SSR
  prefetch is unavailable

For typical app code, start with the browser or Expo entry points.

## Main exports

### `createEmbeddedPrefetch`

Fetches serializable prefetch data for your embedded tables from a remote Convex
deployment.

Use it when you want:

- SSR-safe imports with client-only runtime startup
- server-rendered HTML that matches the first browser render
- paginated first paint from `EmbeddedRuntime.paginate(...)`

Typical SSR flow:

```ts
import { createEmbeddedRuntime } from "@robelest/convex-embedded";
import { createEmbeddedPrefetch } from "@robelest/convex-embedded/client";
import { createConvexClient } from "@robelest/convex-embedded/browser";

const { embedded: prefetched } = await createEmbeddedPrefetch({
  url: process.env.CONVEX_URL!,
  queries: {
    tasks: {
      query: api.tasks.list,
      args: {},
      collection: "tasks",
    },
  },
});

const runtime = createEmbeddedRuntime({
  modules,
  schema,
  prefetch: prefetched,
});
const firstPage = await runtime.paginate(
  api.tasks.list,
  {},
  { initialNumItems: 20 },
);

const client = createConvexClient({
  modules,
  schema,
  remote: { url: process.env.CONVEX_URL! },
  prefetch: prefetched,
});
```

`createEmbeddedPrefetch(...)` executes the explicit SSR queries you provide and,
for entries with `collection`, captures both the remote documents and resolve
metadata needed to hydrate the embedded runtime. The returned `Prefetch` should
be treated as opaque app data and passed straight into
`createEmbeddedRuntime(...)` or `createConvexClient(...)`.

### `emptyEmbeddedPrefetch`

Builds an empty prefetch payload for cases where SSR/bootstrap data is optional
or unavailable.

```ts
const fallback = emptyEmbeddedPrefetch(identityKey);
```

### `Prefetch`

The serializable artifact returned by `createEmbeddedPrefetch(...)`.

It contains:

- a prefetch format version
- an optional identity scope
- authoritative table documents grouped by embedded table name

### `CreateEmbeddedPrefetchOptions`

Key fields:

- `url`: remote Convex deployment URL
- `token`: optional auth token for authenticated reads
- `identityKey`: optional identity scope for identity-partitioned local data
- `queries`: explicit SSR query specs keyed by result name

### `EmbeddedPrefetchQuerySpec<TResult>`

Each query entry can include:

- `query`: the public Convex query function reference to execute remotely
- `args`: the serializable query arguments
- `collection`: optional embedded table name to hydrate from the query result
- `selectDocuments`: optional projector when the query result is not itself the
  table document array

### `CreateEmbeddedPrefetchResult<TQueries>`

The helper returns:

- `embedded`: the opaque `Prefetch` artifact to feed into the runtime/client
- `results`: the raw remote query results keyed by your `queries` object

## Stability note

`createEmbeddedPrefetch(...)` is the supported advanced API exposed from this
module. For runtime startup, queries, mutations, auth, and remote sync, use the
browser or Expo entry points.
